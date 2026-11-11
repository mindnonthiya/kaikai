-- Migration: Loyalty Admin Overview Stats, Paginated Coupons/Logs RPCs & Composite Index
-- Separated into its own migration file so databases that already applied 202611110001_line_loyalty.sql
-- will execute these new RPCs and composite index cleanly.

create index if not exists loyalty_logs_owner_shop_action_created_idx
  on public.loyalty_logs(owner_id, shop_scope_id, action, created_at desc);

create index if not exists loyalty_push_queue_created_at_idx
  on public.loyalty_push_queue(created_at);

create index if not exists loyalty_logs_created_at_idx
  on public.loyalty_logs(created_at);

create index if not exists settings_line_loyalty_server_key_idx
  on public.settings ((value->>'serverKeyHash'))
  where key = 'line_loyalty' or key like 's:%:line_loyalty';

-- Layer 1: Revoke direct RPC execute permission on run_loyalty_housekeeping from public/anon/authenticated
revoke all on function public.run_loyalty_housekeeping(uuid) from public, anon, authenticated;

-- Layer 2: Ensure worker batch RPC verifies serverKeyHash against settings BEFORE running housekeeping
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
    return jsonb_build_object('ok', false, 'code', 'UNAUTHORIZED_SERVER_KEY', 'jobs', '[]'::jsonb);
  end if;

  if not exists (
    select 1
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
  ) then
    return jsonb_build_object('ok', false, 'code', 'UNAUTHORIZED_SERVER_KEY', 'jobs', '[]'::jsonb);
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

revoke all on function public.claim_due_loyalty_push_jobs_batch(text, text, integer) from public;
grant execute on function public.claim_due_loyalty_push_jobs_batch(text, text, integer) to anon, authenticated;

drop function if exists public.get_loyalty_admin_overview_stats(text, timestamptz, timestamptz);
drop function if exists public.admin_query_loyalty_coupons(text, text, text, integer, integer);
drop function if exists public.admin_query_loyalty_logs(text, text, integer, integer);

-- 1. Authenticated Shop Owner RPC: Single-Query Exact Overview Metrics & 7-Day Scan Aggregates
create or replace function public.get_loyalty_admin_overview_stats(
  p_shop_scope_id text,
  p_today_start timestamptz,
  p_seven_days_ago timestamptz
) returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_shop text := coalesce(nullif(trim(p_shop_scope_id), ''), 'default');
  v_total_members bigint := 0;
  v_ready_coupons bigint := 0;
  v_used_coupons bigint := 0;
  v_failed_push bigint := 0;
  v_pending_push bigint := 0;
  v_scans_today bigint := 0;
  v_points_today bigint := 0;
  v_scans_7d bigint := 0;
  v_points_7d bigint := 0;
begin
  if v_user_id is null then
    return jsonb_build_object('ok', false, 'message', 'UNAUTHORIZED');
  end if;

  select count(*) into v_total_members
  from public.loyalty_members
  where owner_id = v_user_id and shop_scope_id = v_shop;

  select
    count(*) filter (where status = 'unclaimed'),
    count(*) filter (where status = 'claimed')
  into v_ready_coupons, v_used_coupons
  from public.loyalty_coupons
  where owner_id = v_user_id and shop_scope_id = v_shop;

  select
    count(*) filter (where status in ('failed_network', 'failed_quota', 'failed_auth', 'failed_recipient')),
    count(*) filter (where status in ('pending', 'processing'))
  into v_failed_push, v_pending_push
  from public.loyalty_push_queue
  where owner_id = v_user_id and shop_scope_id = v_shop;

  select
    count(*),
    coalesce(sum(greatest(0, points_delta)), 0),
    count(*) filter (where created_at >= p_today_start),
    coalesce(sum(greatest(0, points_delta)) filter (where created_at >= p_today_start), 0)
  into v_scans_7d, v_points_7d, v_scans_today, v_points_today
  from public.loyalty_logs
  where owner_id = v_user_id
    and shop_scope_id = v_shop
    and action = 'qr_claim'
    and created_at >= p_seven_days_ago;

  return jsonb_build_object(
    'ok', true,
    'totalMembers', coalesce(v_total_members, 0),
    'readyCouponsCount', coalesce(v_ready_coupons, 0),
    'usedCouponsCount', coalesce(v_used_coupons, 0),
    'failedPushCount', coalesce(v_failed_push, 0),
    'pendingPushCount', coalesce(v_pending_push, 0),
    'scansTodayCount', coalesce(v_scans_today, 0),
    'pointsTodayCount', coalesce(v_points_today, 0),
    'scans7dCount', coalesce(v_scans_7d, 0),
    'points7dCount', coalesce(v_points_7d, 0)
  );
end;
$$;

revoke all on function public.get_loyalty_admin_overview_stats(text, timestamptz, timestamptz) from public;
grant execute on function public.get_loyalty_admin_overview_stats(text, timestamptz, timestamptz) to authenticated;

-- 2. Authenticated Shop Owner RPC: Paginated & Searchable Coupons with Full Member Name Join
create or replace function public.admin_query_loyalty_coupons(
  p_shop_scope_id text,
  p_status text default 'unclaimed',
  p_query text default '',
  p_limit integer default 20,
  p_offset integer default 0
) returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_shop text := coalesce(nullif(trim(p_shop_scope_id), ''), 'default');
  v_status text := coalesce(nullif(trim(p_status), ''), 'unclaimed');
  v_q text := regexp_replace(trim(coalesce(p_query, '')), '^#', '');
  v_limit integer := greatest(1, least(100, coalesce(p_limit, 20)));
  v_offset integer := greatest(0, coalesce(p_offset, 0));
  v_total bigint := 0;
  v_items jsonb := '[]'::jsonb;
begin
  if v_user_id is null then
    return jsonb_build_object('ok', false, 'message', 'UNAUTHORIZED');
  end if;

  select count(*) into v_total
  from public.loyalty_coupons c
  left join public.loyalty_members m on m.id = c.member_id
  where c.owner_id = v_user_id
    and c.shop_scope_id = v_shop
    and (v_status = 'all' or c.status = v_status)
    and (
      v_q = ''
      or c.code ilike '%' || v_q || '%'
      or c.title ilike '%' || v_q || '%'
      or c.line_user_id ilike '%' || v_q || '%'
      or coalesce(m.display_name, '') ilike '%' || v_q || '%'
    );

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', sub.id,
      'memberId', sub.member_id,
      'lineUserId', sub.line_user_id,
      'code', sub.code,
      'title', sub.title,
      'status', sub.status,
      'issuedAt', sub.issued_at,
      'claimedAt', sub.claimed_at,
      'displayName', sub.display_name,
      'pictureUrl', sub.picture_url
    )
  ), '[]'::jsonb)
  into v_items
  from (
    select
      c.id,
      c.member_id,
      c.line_user_id,
      c.code,
      c.title,
      c.status,
      c.issued_at,
      c.claimed_at,
      coalesce(m.display_name, 'ลูกค้า LINE') as display_name,
      m.picture_url
    from public.loyalty_coupons c
    left join public.loyalty_members m on m.id = c.member_id
    where c.owner_id = v_user_id
      and c.shop_scope_id = v_shop
      and (v_status = 'all' or c.status = v_status)
      and (
        v_q = ''
        or c.code ilike '%' || v_q || '%'
        or c.title ilike '%' || v_q || '%'
        or c.line_user_id ilike '%' || v_q || '%'
        or coalesce(m.display_name, '') ilike '%' || v_q || '%'
      )
    order by c.issued_at desc
    limit v_limit
    offset v_offset
  ) sub;

  return jsonb_build_object(
    'ok', true,
    'total', coalesce(v_total, 0),
    'items', v_items
  );
end;
$$;

revoke all on function public.admin_query_loyalty_coupons(text, text, text, integer, integer) from public;
grant execute on function public.admin_query_loyalty_coupons(text, text, text, integer, integer) to authenticated;

-- 3. Authenticated Shop Owner RPC: Paginated & Searchable Activity Logs with Full Member Name Join
create or replace function public.admin_query_loyalty_logs(
  p_shop_scope_id text,
  p_query text default '',
  p_limit integer default 20,
  p_offset integer default 0
) returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_shop text := coalesce(nullif(trim(p_shop_scope_id), ''), 'default');
  v_q text := trim(coalesce(p_query, ''));
  v_limit integer := greatest(1, least(100, coalesce(p_limit, 20)));
  v_offset integer := greatest(0, coalesce(p_offset, 0));
  v_total bigint := 0;
  v_items jsonb := '[]'::jsonb;
begin
  if v_user_id is null then
    return jsonb_build_object('ok', false, 'message', 'UNAUTHORIZED');
  end if;

  select count(*) into v_total
  from public.loyalty_logs l
  left join public.loyalty_members m on m.id = l.member_id
  where l.owner_id = v_user_id
    and l.shop_scope_id = v_shop
    and (
      v_q = ''
      or coalesce(l.note, '') ilike '%' || v_q || '%'
      or l.action ilike '%' || v_q || '%'
      or l.line_user_id ilike '%' || v_q || '%'
      or coalesce(m.display_name, '') ilike '%' || v_q || '%'
    );

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', sub.id,
      'memberId', sub.member_id,
      'lineUserId', sub.line_user_id,
      'displayName', sub.display_name,
      'pictureUrl', sub.picture_url,
      'action', sub.action,
      'pointsDelta', sub.points_delta,
      'balanceAfter', sub.balance_after,
      'note', sub.note,
      'createdAt', sub.created_at
    )
  ), '[]'::jsonb)
  into v_items
  from (
    select
      l.id,
      l.member_id,
      l.line_user_id,
      coalesce(m.display_name, 'ลูกค้า LINE') as display_name,
      m.picture_url,
      l.action,
      l.points_delta,
      l.balance_after,
      l.note,
      l.created_at
    from public.loyalty_logs l
    left join public.loyalty_members m on m.id = l.member_id
    where l.owner_id = v_user_id
      and l.shop_scope_id = v_shop
      and (
        v_q = ''
        or coalesce(l.note, '') ilike '%' || v_q || '%'
        or l.action ilike '%' || v_q || '%'
        or l.line_user_id ilike '%' || v_q || '%'
        or coalesce(m.display_name, '') ilike '%' || v_q || '%'
      )
    order by l.created_at desc
    limit v_limit
    offset v_offset
  ) sub;

  return jsonb_build_object(
    'ok', true,
    'total', coalesce(v_total, 0),
    'items', v_items
  );
end;
$$;

revoke all on function public.admin_query_loyalty_logs(text, text, integer, integer) from public;
grant execute on function public.admin_query_loyalty_logs(text, text, integer, integer) to authenticated;

notify pgrst, 'reload schema';
