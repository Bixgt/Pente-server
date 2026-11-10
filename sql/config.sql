-- PENTE · configuración que decide el administrador (v112): a qué nivel se destraba cada tablero, piedra y pieza de personaje.
-- Pegar en Supabase → SQL Editor → New query → Run. Se puede correr más de una vez.
-- Antes: la cuenta "Bixgt" tiene que tener ese nombre definitivo (Perfil → elegir nombre). El nombre es único e inmodificable, así que solo esa cuenta puede cambiar la configuración.

create table if not exists public.app_config (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.app_config enable row level security;
drop policy if exists app_config_read on public.app_config;
create policy app_config_read on public.app_config for select to anon, authenticated using (true);   -- todos la leen
revoke insert, update, delete on public.app_config from anon, authenticated;                           -- nadie la escribe directo
grant select on public.app_config to anon, authenticated;

create or replace function public.is_pente_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = auth.uid() and name_set and lower(name) = 'bixgt')
$$;

create or replace function public.admin_set_config(k text, v jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.is_pente_admin() then raise exception 'not_admin'; end if;
  if k not in ('levels') then raise exception 'bad_key'; end if;
  if v is null or jsonb_typeof(v) <> 'object' or length(v::text) > 20000 then raise exception 'bad_value'; end if;
  insert into public.app_config (key, value, updated_at) values (k, v, now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
  return true;
end $$;

revoke all on function public.is_pente_admin() from public, anon;
revoke all on function public.admin_set_config(text, jsonb) from public, anon;
grant execute on function public.is_pente_admin() to authenticated;
grant execute on function public.admin_set_config(text, jsonb) to authenticated;
