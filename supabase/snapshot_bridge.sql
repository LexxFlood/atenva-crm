create table if not exists public.app_sync_credentials (
  id text primary key,
  secret_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.app_snapshots (
  company_key text primary key,
  database_base64 text not null,
  byte_size bigint not null,
  version bigint not null default 1,
  lock_token text,
  lock_holder text,
  lock_expires_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.app_snapshots add column if not exists version bigint not null default 1;
alter table public.app_snapshots add column if not exists lock_token text;
alter table public.app_snapshots add column if not exists lock_holder text;
alter table public.app_snapshots add column if not exists lock_expires_at timestamptz;

alter table public.app_sync_credentials enable row level security;
alter table public.app_snapshots enable row level security;
revoke all on public.app_sync_credentials from anon, authenticated;
revoke all on public.app_snapshots from anon, authenticated;

create or replace function public.acquire_snapshot_lease(
  p_company_key text,
  p_holder text,
  p_lease_seconds integer default 300
)
returns table(lease_token text, snapshot_version bigint)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  update public.app_snapshots as snapshot
  set lock_token = encode(extensions.gen_random_bytes(32), 'hex'),
      lock_holder = left(p_holder, 120),
      lock_expires_at = now() + make_interval(secs => greatest(30, least(p_lease_seconds, 600)))
  where snapshot.company_key = p_company_key
    and (snapshot.lock_expires_at is null or snapshot.lock_expires_at < now())
  returning snapshot.lock_token, snapshot.version;
end;
$$;

create or replace function public.release_snapshot_lease(p_company_key text, p_lease_token text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  released_count integer;
begin
  update public.app_snapshots
  set lock_token = null, lock_holder = null, lock_expires_at = null
  where company_key = p_company_key and lock_token = p_lease_token;
  get diagnostics released_count = row_count;
  return released_count > 0;
end;
$$;

create or replace function public.read_snapshot_with_lease(p_company_key text, p_lease_token text)
returns table(database_base64 text)
language sql
security definer
set search_path = ''
as $$
  select snapshot.database_base64
  from public.app_snapshots as snapshot
  where snapshot.company_key = p_company_key
    and snapshot.lock_token = p_lease_token
    and snapshot.lock_expires_at > now();
$$;

create or replace function public.save_snapshot_with_lease(
  p_company_key text,
  p_lease_token text,
  p_database_base64 text,
  p_byte_size bigint
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved_version bigint;
begin
  update public.app_snapshots as snapshot
  set database_base64 = p_database_base64,
      byte_size = p_byte_size,
      version = snapshot.version + 1,
      updated_at = now()
  where snapshot.company_key = p_company_key
    and snapshot.lock_token = p_lease_token
    and snapshot.lock_expires_at > now()
  returning snapshot.version into saved_version;
  return saved_version;
end;
$$;

revoke execute on function public.acquire_snapshot_lease(text,text,integer) from public, anon, authenticated;
revoke execute on function public.release_snapshot_lease(text,text) from public, anon, authenticated;
revoke execute on function public.read_snapshot_with_lease(text,text) from public, anon, authenticated;
revoke execute on function public.save_snapshot_with_lease(text,text,text,bigint) from public, anon, authenticated;
grant execute on function public.acquire_snapshot_lease(text,text,integer) to service_role;
grant execute on function public.release_snapshot_lease(text,text) to service_role;
grant execute on function public.read_snapshot_with_lease(text,text) to service_role;
grant execute on function public.save_snapshot_with_lease(text,text,text,bigint) to service_role;

insert into public.app_sync_credentials (id, secret_hash)
values ('vercel-primary', '4578036cc3e44ee09be7e6b0d678ebd378a5eb4e4d44fa5f06108953888100b7')
on conflict (id) do update set secret_hash=excluded.secret_hash, updated_at=now();
