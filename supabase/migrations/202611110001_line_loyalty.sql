-- LINE OA Loyalty Stamp Card & Reward Coupons (per-owner, per-shop isolated).
-- Safe to run more than once (idempotent).

create table if not exists public.loyalty_members (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  shop_scope_id text not null default 'default',
  line_user_id text not null,
  display_name text not null default 'ลูกค้า LINE',
  picture_url text,
  stamps integer not null default 0 check (stamps >= 0),
  lifetime_stamps integer not null default 0 check (lifetime_stamps >= 0),
  expires_at timestamptz,
  last_stamped_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, shop_scope_id, line_user_id)
);

create index if not exists loyalty_members_owner_shop_idx
  on public.loyalty_members(owner_id, shop_scope_id, updated_at desc);

create table if not exists public.loyalty_coupons (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  shop_scope_id text not null default 'default',
  member_id uuid not null references public.loyalty_members(id) on delete cascade,
  line_user_id text not null,
  code text not null,
  title text not null,
  status text not null default 'unclaimed' check (status in ('unclaimed', 'claimed')),
  issued_at timestamptz not null default now(),
  claimed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists loyalty_coupons_member_status_idx
  on public.loyalty_coupons(member_id, status, issued_at desc);

create index if not exists loyalty_coupons_owner_shop_idx
  on public.loyalty_coupons(owner_id, shop_scope_id, issued_at desc);

create table if not exists public.loyalty_logs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  shop_scope_id text not null default 'default',
  member_id uuid references public.loyalty_members(id) on delete cascade,
  line_user_id text not null,
  action text not null,
  points_delta integer not null default 0,
  balance_after integer not null default 0,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists loyalty_logs_member_created_idx
  on public.loyalty_logs(member_id, created_at desc);

create index if not exists settings_line_loyalty_secret_idx
  on public.settings ((value->>'shopSecret'))
  where key = 'line_loyalty' or key like 's:%:line_loyalty';

create index if not exists settings_line_loyalty_webhook_idx
  on public.settings ((value->>'webhookSecret'))
  where key = 'line_loyalty' or key like 's:%:line_loyalty';

alter table public.loyalty_members enable row level security;
alter table public.loyalty_coupons enable row level security;
alter table public.loyalty_logs enable row level security;

drop policy if exists loyalty_members_owner_all on public.loyalty_members;
create policy loyalty_members_owner_all on public.loyalty_members
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

drop policy if exists loyalty_coupons_owner_all on public.loyalty_coupons;
create policy loyalty_coupons_owner_all on public.loyalty_coupons
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

drop policy if exists loyalty_logs_owner_all on public.loyalty_logs;
create policy loyalty_logs_owner_all on public.loyalty_logs
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- Drop any older function signatures before recreating
drop function if exists public.get_loyalty_card_state(text, text, text, text);
drop function if exists public.claim_loyalty_stamps(text, text, text, text, text, text);
drop function if exists public.claim_loyalty_stamps(text, integer, text, text, text, text);
drop function if exists public.redeem_loyalty_coupon(text, text, uuid);
drop function if exists public.redeem_loyalty_coupon(text, uuid, text, text);
drop function if exists public.get_loyalty_webhook_context(text, text);
drop function if exists public.get_loyalty_webhook_context(text);

-- 1. Public RPC: Get Loyalty Card State & Member Progress
create or replace function public.get_loyalty_card_state(
  p_shop_secret text,
  p_line_user_id text default null,
  p_display_name text default null,
  p_picture_url text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner_id uuid;
  v_setting_key text;
  v_config jsonb;
  v_shop_scope_id text;
  v_validity_months integer;
  v_stamps_per_reward integer;
  v_member public.loyalty_members%rowtype;
  v_coupons jsonb := '[]'::jsonb;
  v_expired_reset boolean := false;
  v_now timestamptz := now();
begin
  if p_shop_secret is null or length(trim(p_shop_secret)) < 6 then
    return jsonb_build_object(
      'ok', false,
      'code', 'INVALID_SECRET',
      'message', 'ไม่พบรหัสร้านค้าในลิงก์บัตรสะสมแต้ม'
    );
  end if;

  select s.owner_id, s.key, s.value
    into v_owner_id, v_setting_key, v_config
  from public.settings s
  where (s.key = 'line_loyalty' or s.key like 's:%:line_loyalty')
    and s.value->>'shopSecret' = trim(p_shop_secret)
  limit 1;

  if v_owner_id is null then
    return jsonb_build_object(
      'ok', false,
      'code', 'SHOP_NOT_FOUND',
      'message', 'ยังไม่ได้บันทึกเปิดใช้งานบัตรสะสมแต้มสำหรับร้านนี้ กรุณากดบันทึกในหน้าตั้งค่าก่อน'
    );
  end if;

  v_shop_scope_id := coalesce(
    substring(v_setting_key from '^s:([a-zA-Z0-9_-]{1,36}):line_loyalty$'),
    'default'
  );
  v_validity_months := greatest(1, least(36, coalesce((v_config->>'validityMonths')::integer, 3)));
  v_stamps_per_reward := greatest(1, least(30, coalesce((v_config->>'stampsPerReward')::integer, 10)));

  if p_line_user_id is not null and length(trim(p_line_user_id)) > 0 then
    insert into public.loyalty_members (
      owner_id,
      shop_scope_id,
      line_user_id,
      display_name,
      picture_url,
      stamps,
      lifetime_stamps,
      expires_at,
      updated_at
    )
    values (
      v_owner_id,
      v_shop_scope_id,
      trim(p_line_user_id),
      coalesce(nullif(trim(p_display_name), ''), 'ลูกค้า LINE'),
      nullif(trim(p_picture_url), ''),
      0,
      0,
      v_now + (v_validity_months || ' months')::interval,
      v_now
    )
    on conflict (owner_id, shop_scope_id, line_user_id) do update
    set display_name = case
          when excluded.display_name <> 'ลูกค้า LINE' then excluded.display_name
          else public.loyalty_members.display_name
        end,
        picture_url = coalesce(excluded.picture_url, public.loyalty_members.picture_url),
        updated_at = v_now
    returning * into v_member;

    -- Reset expired stamps if past validity window
    if v_member.expires_at is not null and v_member.expires_at < v_now and v_member.stamps > 0 then
      v_expired_reset := true;
      update public.loyalty_members
      set stamps = 0,
          expires_at = v_now + (v_validity_months || ' months')::interval,
          updated_at = v_now
      where id = v_member.id
      returning * into v_member;

      insert into public.loyalty_logs (
        owner_id, shop_scope_id, member_id, line_user_id, action, points_delta, balance_after, note
      ) values (
        v_owner_id, v_shop_scope_id, v_member.id, v_member.line_user_id, 'expired_reset', 0, 0, 'แต้มหมดอายุเกินกำหนด'
      );
    end if;

    select coalesce(jsonb_agg(
      jsonb_build_object(
        'id', c.id,
        'code', c.code,
        'title', c.title,
        'status', c.status,
        'issuedAt', c.issued_at,
        'claimedAt', c.claimed_at
      ) order by
        case when c.status = 'unclaimed' then 0 else 1 end,
        coalesce(c.claimed_at, c.issued_at) desc
    ), '[]'::jsonb)
    into v_coupons
    from public.loyalty_coupons c
    where c.member_id = v_member.id;
  end if;

  return jsonb_build_object(
    'ok', true,
    'config', jsonb_build_object(
      'cardTitle', coalesce(nullif(v_config->>'cardTitle', ''), 'GaiTomNamPla 🐔'),
      'cardHeadline', coalesce(nullif(v_config->>'cardHeadline', ''), 'สะสม 10 กล่อง ลด 50%'),
      'rewardTitle', coalesce(nullif(v_config->>'rewardTitle', ''), 'ลด 50% เมนูหลัก 1 กล่อง'),
      'stampsPerReward', v_stamps_per_reward,
      'validityMonths', v_validity_months,
      'cooldownMinutes', coalesce((v_config->>'cooldownMinutes')::integer, 5),
      'rulesText', coalesce(nullif(v_config->>'rulesText', ''), ''),
      'liffId', coalesce(v_config->>'liffId', ''),
      'botBasicId', coalesce(v_config->>'botBasicId', '')
    ),
    'member', jsonb_build_object(
      'lineUserId', coalesce(v_member.line_user_id, coalesce(p_line_user_id, '')),
      'displayName', coalesce(v_member.display_name, coalesce(p_display_name, 'ลูกค้า LINE')),
      'pictureUrl', v_member.picture_url,
      'stamps', coalesce(v_member.stamps, 0),
      'lifetimeStamps', coalesce(v_member.lifetime_stamps, 0),
      'expiresAt', coalesce(v_member.expires_at, v_now + (v_validity_months || ' months')::interval),
      'lastStampedAt', v_member.last_stamped_at,
      'expiredReset', v_expired_reset
    ),
    'coupons', v_coupons
  );
end;
$$;

-- 2. Public RPC: Atomically Claim Stamps from a Static 1..10 Box QR Code
create or replace function public.claim_loyalty_stamps(
  p_shop_secret text,
  p_points integer,
  p_token text,
  p_line_user_id text,
  p_display_name text default null,
  p_picture_url text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner_id uuid;
  v_setting_key text;
  v_config jsonb;
  v_shop_scope_id text;
  v_expected_token text;
  v_validity_months integer;
  v_stamps_per_reward integer;
  v_cooldown_minutes integer;
  v_card_title text;
  v_reward_title text;
  v_member public.loyalty_members%rowtype;
  v_now timestamptz := now();
  v_elapsed_seconds integer;
  v_remaining_minutes integer;
  v_prev_stamps integer;
  v_combined integer;
  v_rewards_unlocked integer := 0;
  v_new_stamps integer;
  v_i integer;
  v_code text;
begin
  if p_points is null or p_points < 1 or p_points > 10 then
    return jsonb_build_object(
      'ok', false,
      'code', 'INVALID_POINTS',
      'message', 'จำนวนแต้มสะสมไม่ถูกต้อง (รองรับ 1 ถึง 10 กล่อง)'
    );
  end if;

  select s.owner_id, s.key, s.value
    into v_owner_id, v_setting_key, v_config
  from public.settings s
  where (s.key = 'line_loyalty' or s.key like 's:%:line_loyalty')
    and s.value->>'shopSecret' = trim(coalesce(p_shop_secret, ''))
  limit 1;

  if v_owner_id is null then
    return jsonb_build_object(
      'ok', false,
      'code', 'SHOP_NOT_FOUND',
      'message', 'ไม่พบข้อมูลบัตรสะสมแต้มของร้านนี้'
    );
  end if;

  if coalesce((v_config->>'enabled')::boolean, false) = false then
    return jsonb_build_object(
      'ok', false,
      'code', 'LOYALTY_DISABLED',
      'message', 'ขณะนี้ทางร้านปิดระบบสะสมแต้มชั่วคราว'
    );
  end if;

  v_expected_token := coalesce(v_config->'qrTokens'->>(p_points::text), '');
  if v_expected_token = '' or v_expected_token <> trim(coalesce(p_token, '')) then
    return jsonb_build_object(
      'ok', false,
      'code', 'INVALID_QR_TOKEN',
      'message', 'คิวอาร์โค้ดนี้ไม่ถูกต้องหรือถูกรีเซ็ตรหัสใหม่แล้ว กรุณาขอคิวอาร์โค้ดล่าสุดจากทางร้าน'
    );
  end if;

  v_shop_scope_id := coalesce(
    substring(v_setting_key from '^s:([a-zA-Z0-9_-]{1,36}):line_loyalty$'),
    'default'
  );
  v_validity_months := greatest(1, least(36, coalesce((v_config->>'validityMonths')::integer, 3)));
  v_stamps_per_reward := greatest(1, least(30, coalesce((v_config->>'stampsPerReward')::integer, 10)));
  v_cooldown_minutes := greatest(0, least(1440, coalesce((v_config->>'cooldownMinutes')::integer, 5)));
  v_card_title := coalesce(nullif(v_config->>'cardTitle', ''), 'GaiTomNamPla 🐔');
  v_reward_title := coalesce(nullif(v_config->>'rewardTitle', ''), 'ลด 50% เมนูหลัก 1 กล่อง');

  insert into public.loyalty_members (
    owner_id,
    shop_scope_id,
    line_user_id,
    display_name,
    picture_url,
    stamps,
    lifetime_stamps,
    expires_at,
    updated_at
  )
  values (
    v_owner_id,
    v_shop_scope_id,
    trim(p_line_user_id),
    coalesce(nullif(trim(p_display_name), ''), 'ลูกค้า LINE'),
    nullif(trim(p_picture_url), ''),
    0,
    0,
    v_now + (v_validity_months || ' months')::interval,
    v_now
  )
  on conflict (owner_id, shop_scope_id, line_user_id) do update
  set display_name = case
        when excluded.display_name <> 'ลูกค้า LINE' then excluded.display_name
        else public.loyalty_members.display_name
      end,
      picture_url = coalesce(excluded.picture_url, public.loyalty_members.picture_url)
  returning * into v_member;

  -- Lock member row FOR UPDATE to prevent concurrent duplicate scans
  select * into v_member
  from public.loyalty_members
  where id = v_member.id
  for update;

  -- Cooldown check
  if v_cooldown_minutes > 0 and v_member.last_stamped_at is not null then
    v_elapsed_seconds := extract(epoch from (v_now - v_member.last_stamped_at))::integer;
    if v_elapsed_seconds < (v_cooldown_minutes * 60) then
      v_remaining_minutes := greatest(1, ceil(((v_cooldown_minutes * 60) - v_elapsed_seconds)::numeric / 60.0)::integer);
      return jsonb_build_object(
        'ok', false,
        'code', 'COOLDOWN_ACTIVE',
        'message', 'คุณเพิ่งสแกนรับแต้มไปแล้ว (แต้มปัจจุบัน ' || v_member.stamps::text || '/' || v_stamps_per_reward::text || ') กรุณารออีกประมาณ ' || v_remaining_minutes::text || ' นาทีก่อนสแกนครั้งถัดไป'
      );
    end if;
  end if;

  -- Reset expired stamps if past validity window
  if v_member.expires_at is not null and v_member.expires_at < v_now and v_member.stamps > 0 then
    v_member.stamps := 0;
  end if;

  v_prev_stamps := v_member.stamps;
  v_combined := v_prev_stamps + p_points;
  v_rewards_unlocked := v_combined / v_stamps_per_reward;
  v_new_stamps := mod(v_combined, v_stamps_per_reward);

  update public.loyalty_members
  set stamps = v_new_stamps,
      lifetime_stamps = lifetime_stamps + p_points,
      last_stamped_at = v_now,
      expires_at = v_now + (v_validity_months || ' months')::interval,
      updated_at = v_now
  where id = v_member.id
  returning * into v_member;

  if v_rewards_unlocked > 0 then
    for v_i in 1..v_rewards_unlocked loop
      v_code := 'GT-' || upper(substr(md5(gen_random_uuid()::text), 1, 6));
      insert into public.loyalty_coupons (
        owner_id,
        shop_scope_id,
        member_id,
        line_user_id,
        code,
        title,
        status,
        issued_at
      ) values (
        v_owner_id,
        v_shop_scope_id,
        v_member.id,
        v_member.line_user_id,
        v_code,
        v_reward_title,
        'unclaimed',
        v_now
      );
    end loop;
  end if;

  insert into public.loyalty_logs (
    owner_id,
    shop_scope_id,
    member_id,
    line_user_id,
    action,
    points_delta,
    balance_after,
    note
  ) values (
    v_owner_id,
    v_shop_scope_id,
    v_member.id,
    v_member.line_user_id,
    'scan_claim',
    p_points,
    v_new_stamps,
    'ลูกค้าสแกน QR สะสม +' || p_points::text || ' แต้ม'
  );

  return jsonb_build_object(
    'ok', true,
    'cardTitle', v_card_title,
    'rewardTitle', v_reward_title,
    'displayName', v_member.display_name,
    'pointsAdded', p_points,
    'previousStamps', v_prev_stamps,
    'newStamps', v_new_stamps,
    'stampsPerReward', v_stamps_per_reward,
    'stampsRemaining', v_stamps_per_reward - v_new_stamps,
    'rewardsUnlocked', v_rewards_unlocked,
    'expiresAt', v_member.expires_at,
    'channelAccessToken', coalesce(v_config->>'channelAccessToken', '')
  );
end;
$$;

-- 3. Public RPC: Self-Service Coupon Redemption (ลูกค้ากดใช้คูปองเองแล้วแคปส่งร้าน)
create or replace function public.redeem_loyalty_coupon(
  p_shop_secret text,
  p_coupon_id uuid,
  p_line_user_id text,
  p_display_name text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner_id uuid;
  v_setting_key text;
  v_config jsonb;
  v_shop_scope_id text;
  v_coupon public.loyalty_coupons%rowtype;
  v_member public.loyalty_members%rowtype;
  v_now timestamptz := now();
  v_already_claimed boolean := false;
begin
  select s.owner_id, s.key, s.value
    into v_owner_id, v_setting_key, v_config
  from public.settings s
  where (s.key = 'line_loyalty' or s.key like 's:%:line_loyalty')
    and s.value->>'shopSecret' = trim(coalesce(p_shop_secret, ''))
  limit 1;

  if v_owner_id is null then
    return jsonb_build_object(
      'ok', false,
      'code', 'SHOP_NOT_FOUND',
      'message', 'ไม่พบข้อมูลร้านสำหรับคูปองนี้'
    );
  end if;

  v_shop_scope_id := coalesce(
    substring(v_setting_key from '^s:([a-zA-Z0-9_-]{1,36}):line_loyalty$'),
    'default'
  );

  select * into v_coupon
  from public.loyalty_coupons
  where id = p_coupon_id
    and owner_id = v_owner_id
    and shop_scope_id = v_shop_scope_id
    and line_user_id = trim(coalesce(p_line_user_id, ''))
  for update;

  if v_coupon.id is null then
    return jsonb_build_object(
      'ok', false,
      'code', 'COUPON_NOT_FOUND',
      'message', 'ไม่พบคูปองส่วนลดใบนี้'
    );
  end if;

  select * into v_member from public.loyalty_members where id = v_coupon.member_id;

  if v_coupon.status = 'claimed' then
    v_already_claimed := true;
  else
    update public.loyalty_coupons
    set status = 'claimed',
        claimed_at = v_now
    where id = v_coupon.id
    returning * into v_coupon;

    insert into public.loyalty_logs (
      owner_id,
      shop_scope_id,
      member_id,
      line_user_id,
      action,
      points_delta,
      balance_after,
      note
    ) values (
      v_owner_id,
      v_shop_scope_id,
      v_coupon.member_id,
      v_coupon.line_user_id,
      'coupon_redeem',
      0,
      coalesce(v_member.stamps, 0),
      'ลูกค้ากดใช้คูปอง #' || v_coupon.code || ' (' || v_coupon.title || ')'
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'alreadyClaimed', v_already_claimed,
    'couponId', v_coupon.id,
    'code', v_coupon.code,
    'title', v_coupon.title,
    'claimedAt', coalesce(v_coupon.claimed_at, v_now),
    'cardTitle', coalesce(nullif(v_config->>'cardTitle', ''), 'GaiTomNamPla 🐔'),
    'displayName', coalesce(v_member.display_name, coalesce(p_display_name, 'ลูกค้า LINE')),
    'channelAccessToken', coalesce(v_config->>'channelAccessToken', '')
  );
end;
$$;

-- 4. Public RPC: Resolve Webhook Context by Private Webhook Secret
create or replace function public.get_loyalty_webhook_context(
  p_webhook_secret text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner_id uuid;
  v_setting_key text;
  v_config jsonb;
begin
  if p_webhook_secret is null or length(trim(p_webhook_secret)) < 6 then
    return jsonb_build_object('ok', false);
  end if;

  select s.owner_id, s.key, s.value
    into v_owner_id, v_setting_key, v_config
  from public.settings s
  where (s.key = 'line_loyalty' or s.key like 's:%:line_loyalty')
    and s.value->>'webhookSecret' = trim(p_webhook_secret)
    and coalesce((s.value->>'enabled')::boolean, false) = true
  limit 1;

  if v_owner_id is null then
    return jsonb_build_object('ok', false);
  end if;

  return jsonb_build_object(
    'ok', true,
    'shopSecret', coalesce(v_config->>'shopSecret', ''),
    'channelSecret', coalesce(v_config->>'channelSecret', ''),
    'channelAccessToken', coalesce(v_config->>'channelAccessToken', ''),
    'cardTitle', coalesce(nullif(v_config->>'cardTitle', ''), 'GaiTomNamPla 🐔'),
    'rewardTitle', coalesce(nullif(v_config->>'rewardTitle', ''), 'ลด 50% เมนูหลัก 1 กล่อง'),
    'stampsPerReward', greatest(1, least(30, coalesce((v_config->>'stampsPerReward')::integer, 10))),
    'liffId', coalesce(v_config->>'liffId', '')
  );
end;
$$;

revoke all on function public.get_loyalty_card_state(text, text, text, text) from public;
grant execute on function public.get_loyalty_card_state(text, text, text, text) to anon, authenticated;

revoke all on function public.claim_loyalty_stamps(text, integer, text, text, text, text) from public;
grant execute on function public.claim_loyalty_stamps(text, integer, text, text, text, text) to anon, authenticated;

revoke all on function public.redeem_loyalty_coupon(text, uuid, text, text) from public;
grant execute on function public.redeem_loyalty_coupon(text, uuid, text, text) to anon, authenticated;

revoke all on function public.get_loyalty_webhook_context(text) from public;
grant execute on function public.get_loyalty_webhook_context(text) to anon, authenticated;

notify pgrst, 'reload schema';
