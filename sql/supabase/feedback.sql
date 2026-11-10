-- PENTE · buzón de comentarios (v132). Pegar en Supabase → SQL Editor → New query → Run. Se puede correr más de una vez.
-- Requiere config.sql (is_pente_admin) y names.sql.
-- Cualquiera con cuenta puede mandar un comentario (error o sugerencia). Solo la cuenta «Bixgt» los puede leer y marcar como resueltos.

create table if not exists public.feedback (
  id      bigserial primary key,
  uid     uuid not null references auth.users(id) on delete cascade,
  name    text not null default '',
  kind    text not null default 'bug' check (kind in ('bug', 'idea', 'other')),
  body    text not null check (char_length(body) between 3 and 1500),
  info    text not null default '',
  done    boolean not null default false,
  at      timestamptz not null default now()
);
alter table public.feedback enable row level security;
revoke all on public.feedback from anon, authenticated;

create or replace function public.feedback_send(k text, b text, i text default '') returns text
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); nm text; txt text := btrim(coalesce(b, ''));
begin
  if me is null then raise exception 'not_authenticated'; end if;
  if char_length(txt) < 3 then return 'short'; end if;
  if (select count(*) from public.feedback where uid = me and at > now() - interval '1 hour') >= 10 then return 'limit'; end if;
  select coalesce(case when name_set then name else '' end, '') into nm from public.profiles where id = me;
  insert into public.feedback (uid, name, kind, body, info)
  values (me, coalesce(nm, ''), case when k in ('bug', 'idea') then k else 'other' end, left(txt, 1500), left(coalesce(i, ''), 300));
  return 'ok';
end $$;

create or replace function public.feedback_list(only_open boolean default true) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.is_pente_admin() then raise exception 'not_admin'; end if;
  return coalesce((select jsonb_agg(to_jsonb(f) - 'uid' order by f.at desc) from (
    select id, name, kind, body, info, done, extract(epoch from at)::bigint * 1000 as at
    from public.feedback where (not only_open) or not done order by at desc limit 200) f), '[]'::jsonb);
end $$;

create or replace function public.feedback_done(p bigint, v boolean) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.is_pente_admin() then raise exception 'not_admin'; end if;
  update public.feedback set done = coalesce(v, true) where id = p;
  return true;
end $$;

create or replace function public.feedback_delete(p bigint) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.is_pente_admin() then raise exception 'not_admin'; end if;
  delete from public.feedback where id = p;
  return true;
end $$;

revoke all on function public.feedback_send(text, text, text), public.feedback_list(boolean), public.feedback_done(bigint, boolean), public.feedback_delete(bigint) from public, anon;
grant execute on function public.feedback_send(text, text, text), public.feedback_list(boolean), public.feedback_done(bigint, boolean), public.feedback_delete(bigint) to authenticated;
