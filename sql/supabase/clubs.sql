-- PENTE · Clubes (v1). Pegar en Supabase → SQL Editor → New query → Run. Se puede correr más de una vez.
-- Un club entero (socios, roles, configuraciones) es un documento JSON. Solo lo lee y escribe el SERVIDOR (clave secret / service_role).
create table if not exists public.clubs (
  id         text primary key,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.clubs enable row level security;
revoke all on public.clubs from anon, authenticated;
