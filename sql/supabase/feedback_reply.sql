-- PENTE · aviso al usuario de que su comentario fue revisado (v165). Pegar en Supabase → SQL Editor → New query → Run. Se puede correr más de una vez.
-- Requiere feedback.sql (la tabla public.feedback) y config.sql (is_pente_admin). No toca las funciones que ya tenés: solo agrega columnas y funciones nuevas.

alter table public.feedback add column if not exists reply       text        not null default '';
alter table public.feedback add column if not exists notified_at timestamptz;
alter table public.feedback add column if not exists seen        boolean     not null default true;

-- Admin: marca el comentario como resuelto y le avisa a quien lo mandó (con un mensaje opcional).
create or replace function public.feedback_notify(p bigint, msg text default '') returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.is_pente_admin() then raise exception 'not_admin'; end if;
  update public.feedback set done = true, reply = left(btrim(coalesce(msg, '')), 500), notified_at = now(), seen = false where id = p;
  return true;
end $$;

-- Usuario: sus propios comentarios revisados que todavía no cerró.
create or replace function public.feedback_mine() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  return coalesce((select jsonb_agg(x order by x.at desc) from (
    select id, kind, left(body, 120) as body, reply, extract(epoch from notified_at)::bigint * 1000 as at
    from public.feedback where uid = auth.uid() and notified_at is not null and not seen order by notified_at desc limit 20) x), '[]'::jsonb);
end $$;

-- Usuario: cierra el aviso (ya lo leyó).
create or replace function public.feedback_seen(p bigint) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  update public.feedback set seen = true where id = p and uid = auth.uid();
  return true;
end $$;

revoke all on function public.feedback_notify(bigint, text), public.feedback_mine(), public.feedback_seen(bigint) from public, anon;
grant execute on function public.feedback_notify(bigint, text), public.feedback_mine(), public.feedback_seen(bigint) to authenticated;
