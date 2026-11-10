-- PENTE · estadísticas cara a cara con un amigo (v132). Pegar en Supabase → SQL Editor → New query → Run. Se puede correr más de una vez.
-- Requiere haber corrido antes schema.sql, names.sql, friends.sql y online.sql.
--
-- Qué hace:
--  · El SERVIDOR de salas (service_role) anota cada partida online terminada entre dos cuentas distintas (de cualquier modo: clásico, blitz, bullet, tríos, gomoku), con un mínimo de 10 jugadas.
--    A diferencia de online.sql, acá NO hay tope por pareja: es solo para mostrarte «cómo te va con tal persona».
--  · pair_stats(nombre) devuelve las partidas entre vos y esa persona: jugadas, ganadas, perdidas, empates y el detalle por modo.

create table if not exists public.pair_games (
  id      bigserial primary key,
  a       uuid not null references auth.users(id) on delete cascade,   -- jugó primero
  b       uuid not null references auth.users(id) on delete cascade,
  winner  smallint not null check (winner in (0, 1, 2)),               -- 0 = empate, 1 = ganó a, 2 = ganó b
  mode    text not null,
  moves   int not null,
  at      timestamptz not null default now()
);
create index if not exists pair_games_pair on public.pair_games (least(a, b), greatest(a, b));
alter table public.pair_games enable row level security;
revoke all on public.pair_games from anon, authenticated;

create or replace function public.pair_record(a uuid, b uuid, winner int, mode text, moves int) returns text
language plpgsql security definer set search_path = '' as $$
begin
  if a is null or b is null or a = b then return 'same'; end if;
  if moves is null or moves < 10 then return 'short'; end if;
  if (select count(*) from public.profiles where id in (a, b)) <> 2 then return 'unknown'; end if;
  insert into public.pair_games (a, b, winner, mode, moves) values (a, b, case when winner in (1, 2) then winner else 0 end, left(coalesce(mode, 'classic'), 12), moves);
  return 'ok';
end $$;
revoke all on function public.pair_record(uuid, uuid, int, text, int) from public, anon, authenticated;
grant execute on function public.pair_record(uuid, uuid, int, text, int) to service_role;

create or replace function public.pair_stats(p text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); t uuid; res jsonb;
begin
  if me is null then raise exception 'not_authenticated'; end if;
  select id into t from public.profiles where name_set and lower(name) = lower(public.norm_name(p));
  if t is null or t = me then return jsonb_build_object('found', false); end if;
  select jsonb_build_object('found', true,
    'p', count(*), 'w', count(*) filter (where (g.a = me and g.winner = 1) or (g.b = me and g.winner = 2)),
    'l', count(*) filter (where (g.a = me and g.winner = 2) or (g.b = me and g.winner = 1)),
    'd', count(*) filter (where g.winner = 0),
    'modes', coalesce((select jsonb_object_agg(m.mode, jsonb_build_object('p', m.p, 'w', m.w, 'l', m.l, 'd', m.d)) from (
        select g2.mode, count(*) p,
          count(*) filter (where (g2.a = me and g2.winner = 1) or (g2.b = me and g2.winner = 2)) w,
          count(*) filter (where (g2.a = me and g2.winner = 2) or (g2.b = me and g2.winner = 1)) l,
          count(*) filter (where g2.winner = 0) d
        from public.pair_games g2 where (g2.a = me and g2.b = t) or (g2.a = t and g2.b = me) group by g2.mode) m), '{}'::jsonb))
  into res from public.pair_games g where (g.a = me and g.b = t) or (g.a = t and g.b = me);
  return res;
end $$;
revoke all on function public.pair_stats(text) from public, anon;
grant execute on function public.pair_stats(text) to authenticated;
