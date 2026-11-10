-- PENTE · desbloquear todo a otra cuenta (v138). Pegar en Supabase → SQL Editor → New query → Run. Se puede correr más de una vez.
-- Requiere config.sql (is_pente_admin) y names.sql.
-- Solo la cuenta «Bixgt» puede darle (o sacarle) el «todo desbloqueado» a otra persona, por su nombre. Va en una tabla aparte que nadie puede escribir directo
-- (si fuera una columna de profiles, cada persona se la podría poner a sí misma, porque puede editar su propio perfil).

create table if not exists public.unlocked_users (
  id uuid primary key references auth.users(id) on delete cascade,
  at timestamptz not null default now()
);
alter table public.unlocked_users enable row level security;
revoke all on public.unlocked_users from anon, authenticated;

create or replace function public.my_unlock() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.unlocked_users where id = auth.uid())
$$;

create or replace function public.admin_unlock_user(p text, v boolean default true) returns text
language plpgsql security definer set search_path = '' as $$
declare uid uuid;
begin
  if auth.uid() is null or not public.is_pente_admin() then raise exception 'not_admin'; end if;
  select id into uid from public.profiles where name_set and lower(name) = lower(btrim(coalesce(p, ''))) limit 1;
  if uid is null then return 'not_found'; end if;
  if coalesce(v, true) then insert into public.unlocked_users (id) values (uid) on conflict (id) do nothing;
  else delete from public.unlocked_users where id = uid; end if;
  return 'ok';
end $$;

create or replace function public.admin_unlock_list() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.is_pente_admin() then raise exception 'not_admin'; end if;
  return coalesce((select jsonb_agg(p.name order by p.name) from public.unlocked_users u join public.profiles p on p.id = u.id), '[]'::jsonb);
end $$;

revoke all on function public.my_unlock(), public.admin_unlock_user(text, boolean), public.admin_unlock_list() from public, anon;
grant execute on function public.my_unlock(), public.admin_unlock_user(text, boolean), public.admin_unlock_list() to authenticated;
