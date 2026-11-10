-- PENTE · avisos push (v172). Pegar en Supabase → SQL Editor → New query → Run. Se puede correr más de una vez.
-- Guarda de cada aparato un «dónde avisarle». Solo lo toca el servidor (clave de servicio); nadie puede leerlo desde la app.

create table if not exists public.push_subs (
  id         bigserial primary key,
  uid        uuid not null references auth.users(id) on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  prefs      jsonb not null default '{}'::jsonb,
  ua         text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists push_subs_uid_idx on public.push_subs (uid);
alter table public.push_subs enable row level security;
revoke all on public.push_subs from anon, authenticated;
