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
  updated_at timestamptz not null default now()
);

alter table public.app_sync_credentials enable row level security;
alter table public.app_snapshots enable row level security;
revoke all on public.app_sync_credentials from anon, authenticated;
revoke all on public.app_snapshots from anon, authenticated;

insert into public.app_sync_credentials (id, secret_hash)
values ('vercel-primary', '4578036cc3e44ee09be7e6b0d678ebd378a5eb4e4d44fa5f06108953888100b7')
on conflict (id) do update set secret_hash=excluded.secret_hash, updated_at=now();
