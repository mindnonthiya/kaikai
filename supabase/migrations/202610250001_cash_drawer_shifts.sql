-- Migration: 202610250001_cash_drawer_shifts.sql
-- Description: Add cash_shifts table for opening drawer cash, shift closing, and daily cash reconciliation.

create table if not exists public.cash_shifts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  shift_date date not null default (now() at time zone 'Asia/Bangkok')::date,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  opening_cash_satang bigint not null default 0,
  cash_sales_satang bigint not null default 0,
  cash_expenses_satang bigint not null default 0,
  expected_cash_satang bigint not null default 0,
  actual_cash_satang bigint,
  difference_satang bigint,
  status text not null default 'open' check (status in ('open', 'closed')),
  notes text,
  cash_breakdown jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Indexes for querying shift history and active shifts
create index if not exists idx_cash_shifts_owner_date on public.cash_shifts (owner_id, shift_date desc);
create index if not exists idx_cash_shifts_owner_status on public.cash_shifts (owner_id, status);

-- Enable Row Level Security
alter table public.cash_shifts enable row level security;

-- Policies
create policy "Users can view their own cash shifts"
  on public.cash_shifts for select
  using (owner_id = auth.uid());

create policy "Users can insert their own cash shifts"
  on public.cash_shifts for insert
  with check (owner_id = auth.uid());

create policy "Users can update their own cash shifts"
  on public.cash_shifts for update
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create policy "Users can delete their own cash shifts"
  on public.cash_shifts for delete
  using (owner_id = auth.uid());
