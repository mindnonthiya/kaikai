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

create index if not exists loyalty_logs_owner_created_idx
  on public.loyalty_logs(owner_id, created_at desc);

create table if not exists public.loyalty_push_queue (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  shop_scope_id text not null default 'default',
  shop_secret text not null,
  member_id uuid references public.loyalty_members(id) on delete cascade,
  line_user_id text not null,
  event_type text not null check (event_type in ('stamp_claim', 'coupon_redeem')),
  messages jsonb not null default '[]'::jsonb,
  fallback_text text,
  status text not null default 'pending' check (
    status in ('pending', 'processing', 'sent', 'failed_auth', 'failed_quota', 'failed_recipient', 'failed_network')
  ),
  retry_key uuid not null default gen_random_uuid(),
  attempts integer not null default 0,
  max_attempts integer not null default 6,
  last_error text,
  next_retry_at timestamptz not null default now(),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.loyalty_push_queue
  add column if not exists retry_key uuid not null default gen_random_uuid();

alter table public.loyalty_push_queue
  alter column max_attempts set default 6;

update public.loyalty_push_queue
set max_attempts = 6
where max_attempts < 6;

create index if not exists loyalty_push_queue_pending_idx
  on public.loyalty_push_queue(shop_secret, status, next_retry_at asc)
  where status in ('pending', 'processing');

create index if not exists loyalty_push_queue_owner_shop_idx
  on public.loyalty_push_queue(owner_id, shop_scope_id, created_at desc);

create index if not exists settings_line_loyalty_secret_idx
  on public.settings ((value->>'shopSecret'))
  where key = 'line_loyalty' or key like 's:%:line_loyalty';

create index if not exists settings_line_loyalty_webhook_idx
  on public.settings ((value->>'webhookSecret'))
  where key = 'line_loyalty' or key like 's:%:line_loyalty';

alter table public.loyalty_members enable row level security;
alter table public.loyalty_coupons enable row level security;
alter table public.loyalty_logs enable row level security;
alter table public.loyalty_push_queue enable row level security;

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

drop policy if exists loyalty_push_queue_owner_all on public.loyalty_push_queue;
create policy loyalty_push_queue_owner_all on public.loyalty_push_queue
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- Clean up any zero-stamp 'web_...' guest rows created on shops that already have liffId configured
delete from public.loyalty_members m
using public.settings s
where m.owner_id = s.owner_id
  and (
    (m.shop_scope_id = 'default' and s.key = 'line_loyalty')
    or s.key = 's:' || m.shop_scope_id || ':line_loyalty'
  )
  and coalesce(trim(s.value->>'liffId'), '') <> ''
  and m.line_user_id not like 'U%'
  and m.stamps = 0
  and m.lifetime_stamps = 0;

-- Drop any older function signatures before recreating
drop function if exists public.get_loyalty_card_state(text, text, text, text);
drop function if exists public.claim_loyalty_stamps(text, text, text, text, text, text);
drop function if exists public.claim_loyalty_stamps(text, integer, text, text, text, text);
drop function if exists public.redeem_loyalty_coupon(text, text, uuid);
drop function if exists public.redeem_loyalty_coupon(text, uuid, text, text);
drop function if exists public.get_loyalty_webhook_context(text, text);
drop function if exists public.get_loyalty_webhook_context(text);
drop function if exists public.get_loyalty_server_credentials(text, text);
drop function if exists public.get_loyalty_server_credentials(text, text, text);
drop function if exists public.enqueue_loyalty_push_job(text, text, text, text, text, jsonb, text);
drop function if exists public.claim_pending_loyalty_push_jobs(text, text, text, integer);
drop function if exists public.claim_due_loyalty_push_jobs_batch(text, text, integer);
drop function if exists public.complete_loyalty_push_job(uuid, text, text, text, text, text, integer);
drop function if exists public.run_loyalty_housekeeping(uuid);
drop function if exists public.admin_adjust_loyalty_stamps(text, uuid, integer);
drop function if exists public.admin_redeem_coupon_by_code(text, text);
drop function if exists public.admin_retry_failed_loyalty_push_jobs(text, uuid);

-- 0. Dedicated Daily & Opportunistic Housekeeping RPC
--    Prunes loyalty_push_queue older than 14 days and loyalty_logs older than 180 days,
--    regardless of whether LINE Push notifications are enabled or disabled.
create or replace function public.run_loyalty_housekeeping(
  p_owner_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_deleted_queue integer := 0;
  v_deleted_logs integer := 0;
begin
  delete from public.loyalty_push_queue
  where (p_owner_id is null or owner_id = p_owner_id)
    and created_at < now() - interval '14 days';
  get diagnostics v_deleted_queue = row_count;

  delete from public.loyalty_logs
  where (p_owner_id is null or owner_id = p_owner_id)
    and created_at < now() - interval '180 days';
  get diagnostics v_deleted_logs = row_count;

  return jsonb_build_object(
    'ok', true,
    'deletedPushQueue', v_deleted_queue,
    'deletedLogs', v_deleted_logs
  );
end;
$$;

-- 1. Public RPC: Get Loyalty Card State & Member Progress
--    - NEVER returns channelAccessToken or channelSecret
--    - When p_line_user_id is null/empty (config-only), returns member: null without creating rows or showing fake 0 stamps
--    - When shop has liffId configured, rejects non-LINE ('web_...') user IDs so junk members are never created
--    - Avoids unnecessary row UPDATE when existing member's name/picture have not changed
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
  v_liff_id text;
  v_clean_user_id text := trim(coalesce(p_line_user_id, ''));
  v_clean_name text := coalesce(nullif(trim(p_display_name), ''), 'ลูกค้า LINE');
  v_clean_pic text := nullif(trim(p_picture_url), '');
  v_member public.loyalty_members%rowtype;
  v_member_json jsonb := null;
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
  v_liff_id := trim(coalesce(v_config->>'liffId', ''));

  if v_clean_user_id <> '' then
    -- If the shop has configured LIFF ID, strictly reject non-LINE ('web_...') IDs so junk members cannot be created
    if v_liff_id <> '' and left(v_clean_user_id, 1) <> 'U' then
      return jsonb_build_object(
        'ok', false,
        'code', 'LINE_AUTH_REQUIRED',
        'message', 'เชื่อมต่อ LINE ไม่สำเร็จ กรุณาเปิดบัตรสะสมแต้มผ่านแอป LINE แล้วลองใหม่อีกครั้ง'
      );
    end if;

    select * into v_member
    from public.loyalty_members
    where owner_id = v_owner_id
      and shop_scope_id = v_shop_scope_id
      and line_user_id = v_clean_user_id
    limit 1;

    if v_member.id is null then
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
        v_clean_user_id,
        v_clean_name,
        v_clean_pic,
        0,
        0,
        v_now + (v_validity_months || ' months')::interval,
        v_now
      )
      on conflict (owner_id, shop_scope_id, line_user_id) do update
      set updated_at = public.loyalty_members.updated_at
      returning * into v_member;
    elsif (v_clean_name <> 'ลูกค้า LINE' and v_member.display_name is distinct from v_clean_name)
       or (v_clean_pic is not null and v_member.picture_url is distinct from v_clean_pic) then
      update public.loyalty_members
      set display_name = case when v_clean_name <> 'ลูกค้า LINE' then v_clean_name else display_name end,
          picture_url = coalesce(v_clean_pic, picture_url),
          updated_at = v_now
      where id = v_member.id
      returning * into v_member;
    end if;

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
        'id', sub.id,
        'code', sub.code,
        'title', sub.title,
        'status', sub.status,
        'issuedAt', sub.issued_at,
        'claimedAt', sub.claimed_at
      ) order by
        case when sub.status = 'unclaimed' then 0 else 1 end,
        coalesce(sub.claimed_at, sub.issued_at) desc
    ), '[]'::jsonb)
    into v_coupons
    from (
      (
        select c.id, c.code, c.title, c.status, c.issued_at, c.claimed_at
        from public.loyalty_coupons c
        where c.member_id = v_member.id and c.status = 'unclaimed'
        order by c.issued_at desc
      )
      union all
      (
        select c.id, c.code, c.title, c.status, c.issued_at, c.claimed_at
        from public.loyalty_coupons c
        where c.member_id = v_member.id and c.status = 'claimed'
        order by coalesce(c.claimed_at, c.issued_at) desc
        limit 20
      )
    ) sub;

    v_member_json := jsonb_build_object(
      'lineUserId', v_member.line_user_id,
      'displayName', v_member.display_name,
      'pictureUrl', v_member.picture_url,
      'stamps', coalesce(v_member.stamps, 0),
      'lifetimeStamps', coalesce(v_member.lifetime_stamps, 0),
      'expiresAt', coalesce(v_member.expires_at, v_now + (v_validity_months || ' months')::interval),
      'lastStampedAt', v_member.last_stamped_at,
      'expiredReset', v_expired_reset
    );
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
      'liffId', v_liff_id,
      'botBasicId', coalesce(v_config->>'botBasicId', ''),
      'notifyMode', coalesce(nullif(v_config->>'notifyMode', ''), 'all')
    ),
    'member', v_member_json,
    'coupons', v_coupons
  );
end;
$$;

-- 2. Public RPC: Atomically Claim Stamps from a Static 1..10 Box QR Code
--    NEVER returns channelAccessToken or channelSecret; returns config + updated member + coupons in single round-trip.
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
  v_liff_id text;
  v_notify_mode text;
  v_has_encrypted_token boolean := false;
  v_push_job_id uuid := null;
  v_clean_user_id text := trim(coalesce(p_line_user_id, ''));
  v_member public.loyalty_members%rowtype;
  v_coupons jsonb := '[]'::jsonb;
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

  v_liff_id := trim(coalesce(v_config->>'liffId', ''));
  if v_clean_user_id = '' or (v_liff_id <> '' and left(v_clean_user_id, 1) <> 'U') then
    return jsonb_build_object(
      'ok', false,
      'code', 'LINE_AUTH_REQUIRED',
      'message', 'เชื่อมต่อ LINE ไม่สำเร็จ กรุณาสแกนผ่านแอป LINE แล้วลองใหม่อีกครั้ง'
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
    v_clean_user_id,
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

  -- Atomic Transactional Outbox: Enqueue LINE Push job in the exact same transaction as stamp & coupon creation
  v_notify_mode := coalesce(nullif(v_config->>'notifyMode', ''), 'all');
  v_has_encrypted_token := trim(coalesce(v_config->>'channelAccessToken', '')) like 'enc:%'
    and trim(coalesce(v_config->>'serverKeyHash', '')) <> '';

  if v_has_encrypted_token
     and left(v_clean_user_id, 1) = 'U'
     and (v_notify_mode = 'all' or (v_notify_mode = 'reward_only' and v_rewards_unlocked > 0)) then
    insert into public.loyalty_push_queue (
      owner_id,
      shop_scope_id,
      shop_secret,
      member_id,
      line_user_id,
      event_type,
      messages,
      fallback_text,
      status,
      attempts,
      max_attempts,
      next_retry_at
    ) values (
      v_owner_id,
      v_shop_scope_id,
      trim(p_shop_secret),
      v_member.id,
      v_member.line_user_id,
      'stamp_claim',
      jsonb_build_object(
        'autoBuild', true,
        'cardTitle', v_card_title,
        'rewardTitle', v_reward_title,
        'displayName', v_member.display_name,
        'pointsAdded', p_points,
        'newStamps', v_new_stamps,
        'stampsPerReward', v_stamps_per_reward,
        'rewardsUnlocked', v_rewards_unlocked,
        'expiresAt', v_member.expires_at,
        'liffId', v_liff_id,
        'shopSecret', trim(p_shop_secret)
      ),
      '🐔 ' || v_card_title || E'\nสะสมแต้มสำเร็จ +' || p_points::text || ' แต้ม (แต้มปัจจุบัน ' || v_new_stamps::text || ' / ' || v_stamps_per_reward::text || ' แต้ม)',
      'pending',
      0,
      6,
      v_now
    )
    returning id into v_push_job_id;
  end if;

  -- Run housekeeping (14-day push queue & 180-day logs cleanup) regardless of whether push mode is on or off
  perform public.run_loyalty_housekeeping(v_owner_id);

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', sub.id,
      'code', sub.code,
      'title', sub.title,
      'status', sub.status,
      'issuedAt', sub.issued_at,
      'claimedAt', sub.claimed_at
    ) order by
      case when sub.status = 'unclaimed' then 0 else 1 end,
      coalesce(sub.claimed_at, sub.issued_at) desc
  ), '[]'::jsonb)
  into v_coupons
  from (
    (
      select c.id, c.code, c.title, c.status, c.issued_at, c.claimed_at
      from public.loyalty_coupons c
      where c.member_id = v_member.id and c.status = 'unclaimed'
      order by c.issued_at desc
    )
    union all
    (
      select c.id, c.code, c.title, c.status, c.issued_at, c.claimed_at
      from public.loyalty_coupons c
      where c.member_id = v_member.id and c.status = 'claimed'
      order by coalesce(c.claimed_at, c.issued_at) desc
      limit 20
    )
  ) sub;

  return jsonb_build_object(
    'ok', true,
    'cardTitle', v_card_title,
    'rewardTitle', v_reward_title,
    'liffId', v_liff_id,
    'notifyMode', v_notify_mode,
    'pushJobId', v_push_job_id,
    'pushQueued', (v_push_job_id is not null),
    'displayName', v_member.display_name,
    'pointsAdded', p_points,
    'previousStamps', v_prev_stamps,
    'newStamps', v_new_stamps,
    'stampsPerReward', v_stamps_per_reward,
    'stampsRemaining', v_stamps_per_reward - v_new_stamps,
    'rewardsUnlocked', v_rewards_unlocked,
    'expiresAt', v_member.expires_at,
    'config', jsonb_build_object(
      'cardTitle', v_card_title,
      'cardHeadline', coalesce(nullif(v_config->>'cardHeadline', ''), 'สะสม 10 กล่อง ลด 50%'),
      'rewardTitle', v_reward_title,
      'stampsPerReward', v_stamps_per_reward,
      'validityMonths', v_validity_months,
      'cooldownMinutes', v_cooldown_minutes,
      'rulesText', coalesce(nullif(v_config->>'rulesText', ''), ''),
      'liffId', v_liff_id,
      'botBasicId', coalesce(v_config->>'botBasicId', ''),
      'notifyMode', coalesce(nullif(v_config->>'notifyMode', ''), 'all')
    ),
    'member', jsonb_build_object(
      'id', v_member.id,
      'lineUserId', v_member.line_user_id,
      'displayName', v_member.display_name,
      'pictureUrl', v_member.picture_url,
      'stamps', v_member.stamps,
      'lifetimeStamps', v_member.lifetime_stamps,
      'expiresAt', v_member.expires_at,
      'lastStampedAt', v_member.last_stamped_at,
      'expiredReset', false
    ),
    'coupons', v_coupons
  );
end;
$$;

-- 3. Public RPC: Self-Service Coupon Redemption (NEVER returns channelAccessToken or channelSecret)
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
  v_coupons jsonb := '[]'::jsonb;
  v_now timestamptz := now();
  v_already_claimed boolean := false;
  v_notify_mode text;
  v_has_encrypted_token boolean := false;
  v_push_job_id uuid := null;
  v_card_title text;
  v_resolved_name text;
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
  v_card_title := coalesce(nullif(v_config->>'cardTitle', ''), 'GaiTomNamPla 🐔');
  v_resolved_name := coalesce(v_member.display_name, coalesce(p_display_name, 'ลูกค้า LINE'));
  v_notify_mode := coalesce(nullif(v_config->>'notifyMode', ''), 'all');
  v_has_encrypted_token := trim(coalesce(v_config->>'channelAccessToken', '')) like 'enc:%'
    and trim(coalesce(v_config->>'serverKeyHash', '')) <> '';

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

    -- Atomic Transactional Outbox: Enqueue coupon redemption LINE Push in the exact same transaction
    if v_has_encrypted_token
       and left(v_coupon.line_user_id, 1) = 'U'
       and v_notify_mode <> 'off' then
      insert into public.loyalty_push_queue (
        owner_id,
        shop_scope_id,
        shop_secret,
        member_id,
        line_user_id,
        event_type,
        messages,
        fallback_text,
        status,
        attempts,
        max_attempts,
        next_retry_at
      ) values (
        v_owner_id,
        v_shop_scope_id,
        trim(p_shop_secret),
        v_coupon.member_id,
        v_coupon.line_user_id,
        'coupon_redeem',
        jsonb_build_object(
          'autoBuild', true,
          'cardTitle', v_card_title,
          'rewardTitle', v_coupon.title,
          'couponCode', v_coupon.code,
          'displayName', v_resolved_name,
          'claimedAt', v_now
        ),
        '🎉 ใช้คูปองส่วนลดสำเร็จ #' || v_coupon.code || ' (' || v_coupon.title || ')',
        'pending',
        0,
        6,
        v_now
      )
      returning id into v_push_job_id;
    end if;

    perform public.run_loyalty_housekeeping(v_owner_id);
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', sub.id,
      'code', sub.code,
      'title', sub.title,
      'status', sub.status,
      'issuedAt', sub.issued_at,
      'claimedAt', sub.claimed_at
    ) order by
      case when sub.status = 'unclaimed' then 0 else 1 end,
      coalesce(sub.claimed_at, sub.issued_at) desc
  ), '[]'::jsonb)
  into v_coupons
  from (
    (
      select c.id, c.code, c.title, c.status, c.issued_at, c.claimed_at
      from public.loyalty_coupons c
      where c.member_id = v_coupon.member_id and c.status = 'unclaimed'
      order by c.issued_at desc
    )
    union all
    (
      select c.id, c.code, c.title, c.status, c.issued_at, c.claimed_at
      from public.loyalty_coupons c
      where c.member_id = v_coupon.member_id and c.status = 'claimed'
      order by coalesce(c.claimed_at, c.issued_at) desc
      limit 20
    )
  ) sub;

  return jsonb_build_object(
    'ok', true,
    'alreadyClaimed', v_already_claimed,
    'couponId', v_coupon.id,
    'memberId', v_coupon.member_id,
    'code', v_coupon.code,
    'title', v_coupon.title,
    'claimedAt', coalesce(v_coupon.claimed_at, v_now),
    'cardTitle', v_card_title,
    'liffId', coalesce(v_config->>'liffId', ''),
    'notifyMode', v_notify_mode,
    'pushJobId', v_push_job_id,
    'pushQueued', (v_push_job_id is not null),
    'displayName', v_resolved_name,
    'coupons', v_coupons
  );
end;
$$;

-- 4. Server-Only Credential Lookup RPC
--    - Requires non-empty serverKeyHash match (never bypasses when serverKeyHash is empty)
--    - Never returns unencrypted plaintext tokens (only 'enc:...' AES-256-GCM ciphertexts)
create or replace function public.get_loyalty_server_credentials(
  p_lookup_secret text,
  p_server_key_hash text,
  p_legacy_key_hash text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner_id uuid;
  v_setting_key text;
  v_config jsonb;
  v_stored_hash text;
  v_raw_token text;
  v_raw_secret text;
begin
  if p_lookup_secret is null or length(trim(p_lookup_secret)) < 6 then
    return jsonb_build_object('ok', false);
  end if;

  if p_server_key_hash is null or length(trim(p_server_key_hash)) < 32 then
    return jsonb_build_object('ok', false);
  end if;

  select s.owner_id, s.key, s.value
    into v_owner_id, v_setting_key, v_config
  from public.settings s
  where (s.key = 'line_loyalty' or s.key like 's:%:line_loyalty')
    and (
      s.value->>'shopSecret' = trim(p_lookup_secret)
      or s.value->>'webhookSecret' = trim(p_lookup_secret)
    )
  limit 1;

  if v_owner_id is null then
    return jsonb_build_object('ok', false);
  end if;

  v_stored_hash := trim(coalesce(v_config->>'serverKeyHash', ''));
  v_raw_token := trim(coalesce(v_config->>'channelAccessToken', ''));
  v_raw_secret := trim(coalesce(v_config->>'channelSecret', ''));

  -- Public metadata (liffId, notifyMode, cardTitle) is always safe to return,
  -- while encrypted credentials are ONLY returned when serverKeyHash matches AND ciphertext starts with 'enc:'
  if v_stored_hash = '' or (
    v_stored_hash <> trim(p_server_key_hash)
    and (p_legacy_key_hash is null or v_stored_hash <> trim(p_legacy_key_hash))
  ) then
    return jsonb_build_object(
      'ok', true,
      'enabled', coalesce((v_config->>'enabled')::boolean, false),
      'shopSecret', coalesce(v_config->>'shopSecret', ''),
      'channelSecret', '',
      'channelAccessToken', '',
      'credentialsLocked', true,
      'cardTitle', coalesce(nullif(v_config->>'cardTitle', ''), 'GaiTomNamPla 🐔'),
      'rewardTitle', coalesce(nullif(v_config->>'rewardTitle', ''), 'ลด 50% เมนูหลัก 1 กล่อง'),
      'stampsPerReward', greatest(1, least(30, coalesce((v_config->>'stampsPerReward')::integer, 10))),
      'liffId', coalesce(v_config->>'liffId', ''),
      'notifyMode', coalesce(nullif(v_config->>'notifyMode', ''), 'all')
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'enabled', coalesce((v_config->>'enabled')::boolean, false),
    'shopSecret', coalesce(v_config->>'shopSecret', ''),
    'channelSecret', case when v_raw_secret like 'enc:%' then v_raw_secret else '' end,
    'channelAccessToken', case when v_raw_token like 'enc:%' then v_raw_token else '' end,
    'credentialsLocked', false,
    'cardTitle', coalesce(nullif(v_config->>'cardTitle', ''), 'GaiTomNamPla 🐔'),
    'rewardTitle', coalesce(nullif(v_config->>'rewardTitle', ''), 'ลด 50% เมนูหลัก 1 กล่อง'),
    'stampsPerReward', greatest(1, least(30, coalesce((v_config->>'stampsPerReward')::integer, 10))),
    'liffId', coalesce(v_config->>'liffId', ''),
    'notifyMode', coalesce(nullif(v_config->>'notifyMode', ''), 'all')
  );
end;
$$;

-- 5. Server-Only Push Queue RPCs (Decoupled Background LINE Push & Retry)
create or replace function public.enqueue_loyalty_push_job(
  p_shop_secret text,
  p_server_key_hash text,
  p_legacy_key_hash text,
  p_line_user_id text,
  p_event_type text,
  p_messages jsonb,
  p_fallback_text text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner_id uuid;
  v_setting_key text;
  v_config jsonb;
  v_stored_hash text;
  v_shop_scope_id text;
  v_member_id uuid;
  v_job_id uuid;
begin
  select s.owner_id, s.key, s.value
    into v_owner_id, v_setting_key, v_config
  from public.settings s
  where (s.key = 'line_loyalty' or s.key like 's:%:line_loyalty')
    and s.value->>'shopSecret' = trim(coalesce(p_shop_secret, ''))
  limit 1;

  if v_owner_id is null then
    return jsonb_build_object('ok', false);
  end if;

  if p_server_key_hash is null or length(trim(p_server_key_hash)) < 32 then
    return jsonb_build_object('ok', false, 'code', 'UNAUTHORIZED_SERVER_KEY');
  end if;

  v_stored_hash := trim(coalesce(v_config->>'serverKeyHash', ''));
  -- Strictly fail-closed: reject immediately if stored serverKeyHash is empty or does not match
  if v_stored_hash = '' or (
    v_stored_hash <> trim(p_server_key_hash)
    and (
      p_legacy_key_hash is null
      or length(trim(p_legacy_key_hash)) < 32
      or v_stored_hash <> trim(p_legacy_key_hash)
    )
  ) then
    return jsonb_build_object('ok', false, 'code', 'UNAUTHORIZED_SERVER_KEY');
  end if;

  if left(trim(coalesce(p_line_user_id, '')), 1) <> 'U'
     or length(trim(coalesce(p_line_user_id, ''))) > 64 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_LINE_USER_ID');
  end if;

  if octet_length(coalesce(p_messages, '[]'::jsonb)::text) > 24576
     or length(coalesce(p_fallback_text, '')) > 2000 then
    return jsonb_build_object('ok', false, 'code', 'PAYLOAD_TOO_LARGE');
  end if;

  v_shop_scope_id := coalesce(
    substring(v_setting_key from '^s:([a-zA-Z0-9_-]{1,36}):line_loyalty$'),
    'default'
  );

  select id into v_member_id
  from public.loyalty_members
  where owner_id = v_owner_id
    and shop_scope_id = v_shop_scope_id
    and line_user_id = trim(coalesce(p_line_user_id, ''))
  limit 1;

  insert into public.loyalty_push_queue (
    owner_id,
    shop_scope_id,
    shop_secret,
    member_id,
    line_user_id,
    event_type,
    messages,
    fallback_text,
    status,
    attempts,
    max_attempts,
    next_retry_at
  ) values (
    v_owner_id,
    v_shop_scope_id,
    trim(p_shop_secret),
    v_member_id,
    trim(coalesce(p_line_user_id, '')),
    case when p_event_type = 'coupon_redeem' then 'coupon_redeem' else 'stamp_claim' end,
    coalesce(p_messages, '[]'::jsonb),
    p_fallback_text,
    'pending',
    0,
    6,
    now()
  )
  returning id into v_job_id;

  perform public.run_loyalty_housekeeping(v_owner_id);

  return jsonb_build_object('ok', true, 'jobId', v_job_id);
end;
$$;

create or replace function public.claim_pending_loyalty_push_jobs(
  p_shop_secret text,
  p_server_key_hash text,
  p_legacy_key_hash text default null,
  p_limit integer default 5
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner_id uuid;
  v_config jsonb;
  v_stored_hash text;
  v_jobs jsonb := '[]'::jsonb;
begin
  if p_server_key_hash is null or length(trim(p_server_key_hash)) < 32 then
    return '[]'::jsonb;
  end if;

  select s.owner_id, s.value
    into v_owner_id, v_config
  from public.settings s
  where (s.key = 'line_loyalty' or s.key like 's:%:line_loyalty')
    and s.value->>'shopSecret' = trim(coalesce(p_shop_secret, ''))
  limit 1;

  if v_owner_id is null then
    return '[]'::jsonb;
  end if;

  v_stored_hash := trim(coalesce(v_config->>'serverKeyHash', ''));
  -- Strictly fail-closed: reject immediately if stored serverKeyHash is empty or does not match
  if v_stored_hash = '' or (
    v_stored_hash <> trim(p_server_key_hash)
    and (
      p_legacy_key_hash is null
      or length(trim(p_legacy_key_hash)) < 32
      or v_stored_hash <> trim(p_legacy_key_hash)
    )
  ) then
    return '[]'::jsonb;
  end if;

  with due as (
    select q.id
    from public.loyalty_push_queue q
    where q.shop_secret = trim(p_shop_secret)
      and (
        (q.status = 'pending' and q.next_retry_at <= now())
        or (q.status = 'processing' and q.updated_at < now() - interval '30 seconds')
      )
      and q.attempts < q.max_attempts
    order by q.next_retry_at asc
    limit greatest(1, least(20, coalesce(p_limit, 5)))
    for update skip locked
  ),
  claimed as (
    update public.loyalty_push_queue q
    set status = 'processing',
        attempts = q.attempts + 1,
        updated_at = now()
    from due
    where q.id = due.id
    returning q.id, q.retry_key, q.line_user_id, q.event_type, q.messages, q.fallback_text, q.attempts, q.max_attempts
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', c.id,
      'retryKey', coalesce(c.retry_key, c.id)::text,
      'lineUserId', c.line_user_id,
      'eventType', c.event_type,
      'messages', c.messages,
      'fallbackText', c.fallback_text,
      'attempts', c.attempts,
      'maxAttempts', c.max_attempts
    )
  ), '[]'::jsonb)
  into v_jobs
  from claimed c;

  return v_jobs;
end;
$$;

create or replace function public.complete_loyalty_push_job(
  p_job_id uuid,
  p_shop_secret text,
  p_server_key_hash text,
  p_legacy_key_hash text,
  p_status text,
  p_error text default null,
  p_retry_delay_seconds integer default 0
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner_id uuid;
  v_config jsonb;
  v_stored_hash text;
begin
  if p_server_key_hash is null or length(trim(p_server_key_hash)) < 32 then
    return jsonb_build_object('ok', false, 'code', 'UNAUTHORIZED_SERVER_KEY');
  end if;

  select s.owner_id, s.value
    into v_owner_id, v_config
  from public.settings s
  where (s.key = 'line_loyalty' or s.key like 's:%:line_loyalty')
    and s.value->>'shopSecret' = trim(coalesce(p_shop_secret, ''))
  limit 1;

  if v_owner_id is null then
    return jsonb_build_object('ok', false);
  end if;

  v_stored_hash := trim(coalesce(v_config->>'serverKeyHash', ''));
  -- Strictly fail-closed: reject immediately if stored serverKeyHash is empty or does not match
  if v_stored_hash = '' or (
    v_stored_hash <> trim(p_server_key_hash)
    and (
      p_legacy_key_hash is null
      or length(trim(p_legacy_key_hash)) < 32
      or v_stored_hash <> trim(p_legacy_key_hash)
    )
  ) then
    return jsonb_build_object('ok', false, 'code', 'UNAUTHORIZED_SERVER_KEY');
  end if;

  if p_status = 'sent' then
    update public.loyalty_push_queue
    set status = 'sent',
        sent_at = now(),
        last_error = null,
        updated_at = now()
    where id = p_job_id and shop_secret = trim(p_shop_secret);
  elsif p_status = 'retry' then
    update public.loyalty_push_queue
    set status = case when attempts < max_attempts then 'pending' else 'failed_network' end,
        last_error = left(coalesce(p_error, ''), 500),
        next_retry_at = now() + (greatest(1, coalesce(p_retry_delay_seconds, 60)) || ' seconds')::interval,
        updated_at = now()
    where id = p_job_id and shop_secret = trim(p_shop_secret);
  else
    update public.loyalty_push_queue
    set status = case
          when p_status in ('failed_auth', 'failed_quota', 'failed_recipient', 'failed_network') then p_status
          else 'failed_network'
        end,
        last_error = left(coalesce(p_error, ''), 500),
        updated_at = now()
    where id = p_job_id and shop_secret = trim(p_shop_secret);
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

-- 5b. Server-Only Cron/Worker Batch Claim & Daily Housekeeping RPC
create or replace function public.claim_due_loyalty_push_jobs_batch(
  p_server_key_hash text,
  p_legacy_key_hash text default null,
  p_limit integer default 15
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_jobs jsonb := '[]'::jsonb;
  v_housekeeping jsonb;
begin
  if p_server_key_hash is null or length(trim(p_server_key_hash)) < 32 then
    return jsonb_build_object('ok', false, 'jobs', '[]'::jsonb);
  end if;

  v_housekeeping := public.run_loyalty_housekeeping(null);

  with authorized_shops as (
    select
      s.owner_id,
      trim(coalesce(s.value->>'shopSecret', '')) as shop_secret,
      case
        when trim(coalesce(s.value->>'channelAccessToken', '')) like 'enc:%'
          then trim(coalesce(s.value->>'channelAccessToken', ''))
        else ''
      end as encrypted_access_token
    from public.settings s
    where (s.key = 'line_loyalty' or s.key like 's:%:line_loyalty')
      and trim(coalesce(s.value->>'serverKeyHash', '')) <> ''
      and (
        trim(coalesce(s.value->>'serverKeyHash', '')) = trim(p_server_key_hash)
        or (
          p_legacy_key_hash is not null
          and length(trim(p_legacy_key_hash)) >= 32
          and trim(coalesce(s.value->>'serverKeyHash', '')) = trim(p_legacy_key_hash)
        )
      )
  ),
  due as (
    select
      q.id,
      a.encrypted_access_token
    from public.loyalty_push_queue q
    join authorized_shops a
      on a.owner_id = q.owner_id
     and a.shop_secret = q.shop_secret
    where (
        (q.status = 'pending' and q.next_retry_at <= now())
        or (q.status = 'processing' and q.updated_at < now() - interval '30 seconds')
      )
      and q.attempts < q.max_attempts
    order by q.next_retry_at asc
    limit greatest(1, least(30, coalesce(p_limit, 15)))
    for update of q skip locked
  ),
  claimed as (
    update public.loyalty_push_queue q
    set status = 'processing',
        attempts = q.attempts + 1,
        updated_at = now()
    from due
    where q.id = due.id
    returning
      q.id,
      q.retry_key,
      q.shop_secret,
      due.encrypted_access_token,
      q.line_user_id,
      q.event_type,
      q.messages,
      q.fallback_text,
      q.attempts,
      q.max_attempts
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', c.id,
      'retryKey', coalesce(c.retry_key, c.id)::text,
      'shopSecret', c.shop_secret,
      'channelAccessToken', c.encrypted_access_token,
      'lineUserId', c.line_user_id,
      'eventType', c.event_type,
      'messages', c.messages,
      'fallbackText', c.fallback_text,
      'attempts', c.attempts,
      'maxAttempts', c.max_attempts
    )
  ), '[]'::jsonb)
  into v_jobs
  from claimed c;

  return jsonb_build_object(
    'ok', true,
    'jobs', v_jobs,
    'housekeeping', v_housekeeping
  );
end;
$$;

-- 6. Authenticated Shop Owner RPC: Atomic Stamp Adjustment (locks row, checks expiry, issues coupons & logs atomically)
create or replace function public.admin_adjust_loyalty_stamps(
  p_shop_scope_id text,
  p_member_id uuid,
  p_delta integer
) returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_shop text := coalesce(nullif(trim(p_shop_scope_id), ''), 'default');
  v_setting_key text;
  v_config jsonb := '{}'::jsonb;
  v_stamps_per_reward integer;
  v_validity_months integer;
  v_reward_title text;
  v_member public.loyalty_members%rowtype;
  v_now timestamptz := now();
  v_base_stamps integer;
  v_combined integer;
  v_next_stamps integer;
  v_issued_count integer := 0;
  v_i integer;
  v_code text;
begin
  if v_user_id is null then
    return jsonb_build_object('ok', false, 'message', 'กรุณาเข้าสู่ระบบก่อนจัดการแต้มลูกค้า');
  end if;

  if p_delta is null or p_delta = 0 or p_delta < -50 or p_delta > 50 then
    return jsonb_build_object('ok', false, 'message', 'จำนวนแต้มที่ต้องการปรับไม่ถูกต้อง');
  end if;

  v_setting_key := case when v_shop = 'default' then 'line_loyalty' else 's:' || v_shop || ':line_loyalty' end;

  select s.value into v_config
  from public.settings s
  where s.owner_id = v_user_id and s.key = v_setting_key
  limit 1;

  v_stamps_per_reward := greatest(1, least(30, coalesce((v_config->>'stampsPerReward')::integer, 10)));
  v_validity_months := greatest(1, least(36, coalesce((v_config->>'validityMonths')::integer, 3)));
  v_reward_title := coalesce(nullif(v_config->>'rewardTitle', ''), 'ลด 50% เมนูหลัก 1 กล่อง');

  select * into v_member
  from public.loyalty_members
  where id = p_member_id
    and owner_id = v_user_id
    and shop_scope_id = v_shop
  for update;

  if v_member.id is null then
    return jsonb_build_object('ok', false, 'message', 'ไม่พบข้อมูลลูกค้ารายนี้');
  end if;

  v_base_stamps := greatest(0, v_member.stamps);
  if p_delta > 0 and v_member.expires_at is not null and v_member.expires_at < v_now and v_base_stamps > 0 then
    v_base_stamps := 0;
  end if;

  if p_delta > 0 then
    v_combined := v_base_stamps + p_delta;
    v_issued_count := v_combined / v_stamps_per_reward;
    v_next_stamps := mod(v_combined, v_stamps_per_reward);
  else
    v_next_stamps := greatest(0, v_base_stamps + p_delta);
  end if;

  update public.loyalty_members
  set stamps = v_next_stamps,
      lifetime_stamps = case when p_delta > 0 then lifetime_stamps + p_delta else lifetime_stamps end,
      expires_at = case when p_delta > 0 then v_now + (v_validity_months || ' months')::interval else expires_at end,
      updated_at = v_now
  where id = v_member.id
  returning * into v_member;

  if v_issued_count > 0 then
    for v_i in 1..v_issued_count loop
      v_code := 'GT-' || upper(substr(md5(gen_random_uuid()::text), 1, 6));
      insert into public.loyalty_coupons (
        owner_id, shop_scope_id, member_id, line_user_id, code, title, status, issued_at
      ) values (
        v_user_id, v_shop, v_member.id, v_member.line_user_id, v_code, v_reward_title, 'unclaimed', v_now
      );
    end loop;
  end if;

  insert into public.loyalty_logs (
    owner_id, shop_scope_id, member_id, line_user_id, action, points_delta, balance_after, note
  ) values (
    v_user_id,
    v_shop,
    v_member.id,
    v_member.line_user_id,
    'manual_adjust',
    p_delta,
    v_next_stamps,
    case when p_delta > 0 then 'ร้านค้าเพิ่มแต้มพิเศษ +' || p_delta::text else 'ร้านค้าปรับลดแต้ม ' || p_delta::text end
  );

  return jsonb_build_object(
    'ok', true,
    'displayName', v_member.display_name,
    'nextStamps', v_next_stamps,
    'stampsPerReward', v_stamps_per_reward,
    'issuedCouponsCount', v_issued_count
  );
end;
$$;

-- 7. Authenticated Shop Owner RPC: Verify & Redeem Coupon by Code in Backoffice
create or replace function public.admin_redeem_coupon_by_code(
  p_shop_scope_id text,
  p_coupon_code text
) returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_shop text := coalesce(nullif(trim(p_shop_scope_id), ''), 'default');
  v_clean_code text;
  v_coupon public.loyalty_coupons%rowtype;
  v_member public.loyalty_members%rowtype;
  v_now timestamptz := now();
begin
  if v_user_id is null then
    return jsonb_build_object('ok', false, 'message', 'กรุณาเข้าสู่ระบบก่อนตรวจสอบคูปอง');
  end if;

  v_clean_code := upper(regexp_replace(trim(coalesce(p_coupon_code, '')), '^#', ''));
  if length(v_clean_code) < 4 then
    return jsonb_build_object('ok', false, 'message', 'กรุณาระบุรหัสคูปอง เช่น GT-XXXXXX');
  end if;

  select * into v_coupon
  from public.loyalty_coupons
  where owner_id = v_user_id
    and shop_scope_id = v_shop
    and upper(code) = v_clean_code
  order by issued_at desc
  limit 1
  for update;

  if v_coupon.id is null then
    return jsonb_build_object('ok', false, 'message', 'ไม่พบรหัสคูปอง #' || v_clean_code || ' ในร้านนี้');
  end if;

  select * into v_member from public.loyalty_members where id = v_coupon.member_id;

  if v_coupon.status = 'claimed' then
    return jsonb_build_object(
      'ok', true,
      'alreadyClaimed', true,
      'code', v_coupon.code,
      'title', v_coupon.title,
      'displayName', coalesce(v_member.display_name, 'ลูกค้า LINE'),
      'claimedAt', v_coupon.claimed_at
    );
  end if;

  update public.loyalty_coupons
  set status = 'claimed',
      claimed_at = v_now
  where id = v_coupon.id
  returning * into v_coupon;

  insert into public.loyalty_logs (
    owner_id, shop_scope_id, member_id, line_user_id, action, points_delta, balance_after, note
  ) values (
    v_user_id,
    v_shop,
    v_coupon.member_id,
    v_coupon.line_user_id,
    'admin_coupon_redeem',
    0,
    coalesce(v_member.stamps, 0),
    'ร้านค้ายืนยันการตัดสิทธิ์คูปอง #' || v_coupon.code
  );

  return jsonb_build_object(
    'ok', true,
    'alreadyClaimed', false,
    'code', v_coupon.code,
    'title', v_coupon.title,
    'displayName', coalesce(v_member.display_name, 'ลูกค้า LINE'),
    'claimedAt', v_coupon.claimed_at
  );
end;
$$;

-- 8. Authenticated Shop Owner RPC: Reset Permanently Failed Push Jobs for Manual Re-Send
create or replace function public.admin_retry_failed_loyalty_push_jobs(
  p_shop_scope_id text,
  p_job_id uuid default null
) returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_shop text := coalesce(nullif(trim(p_shop_scope_id), ''), 'default');
  v_reset_count integer := 0;
begin
  if v_user_id is null then
    return jsonb_build_object('ok', false, 'message', 'กรุณาเข้าสู่ระบบก่อนสั่งส่งข้อความซ้ำ');
  end if;

  update public.loyalty_push_queue
  set status = 'pending',
      attempts = 0,
      max_attempts = greatest(max_attempts, 6),
      next_retry_at = now(),
      updated_at = now()
  where owner_id = v_user_id
    and shop_scope_id = v_shop
    and (p_job_id is null or id = p_job_id)
    and status in ('failed_network', 'failed_quota', 'failed_auth', 'failed_recipient');
  get diagnostics v_reset_count = row_count;

  return jsonb_build_object(
    'ok', true,
    'resetCount', v_reset_count
  );
end;
$$;

revoke all on function public.admin_retry_failed_loyalty_push_jobs(text, uuid) from public;
grant execute on function public.admin_retry_failed_loyalty_push_jobs(text, uuid) to authenticated;

revoke all on function public.get_loyalty_card_state(text, text, text, text) from public;
grant execute on function public.get_loyalty_card_state(text, text, text, text) to anon, authenticated;

revoke all on function public.claim_loyalty_stamps(text, integer, text, text, text, text) from public;
grant execute on function public.claim_loyalty_stamps(text, integer, text, text, text, text) to anon, authenticated;

revoke all on function public.redeem_loyalty_coupon(text, uuid, text, text) from public;
grant execute on function public.redeem_loyalty_coupon(text, uuid, text, text) to anon, authenticated;

revoke all on function public.get_loyalty_server_credentials(text, text, text) from public;
grant execute on function public.get_loyalty_server_credentials(text, text, text) to anon, authenticated;

revoke all on function public.enqueue_loyalty_push_job(text, text, text, text, text, jsonb, text) from public;
grant execute on function public.enqueue_loyalty_push_job(text, text, text, text, text, jsonb, text) to anon, authenticated;

revoke all on function public.claim_pending_loyalty_push_jobs(text, text, text, integer) from public;
grant execute on function public.claim_pending_loyalty_push_jobs(text, text, text, integer) to anon, authenticated;

revoke all on function public.run_loyalty_housekeeping(uuid) from public;
grant execute on function public.run_loyalty_housekeeping(uuid) to authenticated;

revoke all on function public.claim_due_loyalty_push_jobs_batch(text, text, integer) from public;
grant execute on function public.claim_due_loyalty_push_jobs_batch(text, text, integer) to anon, authenticated;

revoke all on function public.complete_loyalty_push_job(uuid, text, text, text, text, text, integer) from public;
grant execute on function public.complete_loyalty_push_job(uuid, text, text, text, text, text, integer) to anon, authenticated;

revoke all on function public.admin_adjust_loyalty_stamps(text, uuid, integer) from public;
grant execute on function public.admin_adjust_loyalty_stamps(text, uuid, integer) to authenticated;

revoke all on function public.admin_redeem_coupon_by_code(text, text) from public;
grant execute on function public.admin_redeem_coupon_by_code(text, text) to authenticated;

-- Register daily database housekeeping (02:00 AM ICT / 19:00 UTC) if pg_cron is enabled on the Supabase project
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule(
      'loyalty-daily-housekeeping',
      '0 19 * * *',
      $cron$select public.run_loyalty_housekeeping(null);$cron$
    );
  end if;
exception
  when others then
    null;
end;
$$;

notify pgrst, 'reload schema';
