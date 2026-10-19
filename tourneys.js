/* PENTE · torneos online (servidor).
 * Los torneos duran días: cada cambio se guarda en un almacén (Supabase en producción, memoria en las pruebas) y se vuelve a cargar cuando alguien
 * se conecta, así que sobreviven a que Render duerma o se reinicie. Lo que NO se guarda: las partidas en juego (se vuelven a jugar) y quién está conectado.
 * El motor (cruces, tabla, quién sigue) es el mismo del cliente: pente-tournament.js. Acá solo se coordina la gente y las salas.
 *
 * Mensajes del cliente (todos llevan code y, salvo tcreate/tjoin, el token de quien los manda):
 *   tcreate {name, cfg:{format,bestOf,minDuels,cut}, game:{variant,blitz,bullet,tournamentRule,exactFive,size,timer}, pname, jwt, dev}
 *   tjoin {code, name, jwt}      trejoin {code, token}      tleave      tclose (organizador)
 *   tinvite {to: uid de un amigo, jwt, avatar, country}  (organizador, mientras está abierto)
 *   tstart (organizador)   tcfg {cfg} (organizador, antes de empezar)   tplay {duel}   tunplay {duel}
 *   tforfeit {duel, winner} (organizador)                   twithdraw {pid} (uno mismo o el organizador)
 * Del servidor: tsnap (foto completa, a cada participante con lo suyo), terror {code}, tinvite, tinviteRes, tclosed.
 * Cuando los dos de un duelo tocan "Jugar", el servidor arma una sala con los dos sentados y le pone a cada uno en tsnap.go
 * { code, token, you } para que entre con un rejoin normal. Al terminar la partida, el resultado se carga solo.
 *
 * Almacén (ctx.store): get(code) → {…}|null · put(code, {owner, status, data}) · del(code) · openByOwner(dev) → [codes] · prune(cutoffMs). Todo devuelve promesas. */
'use strict';
const PT = require('./pente-tournament.js');

const MAX_TOURNEYS = 200, MAX_PLAYERS = 32, NAME_MAX = 40;
const KEEP_MS = 45 * 24 * 3600e3, EVICT_MS = 30 * 60e3;      // en el almacén se conserva 45 días sin actividad; de la memoria se descarga a los 30 min sin nadie conectado

module.exports = function makeTourneys(ctx) {
  const { send, cleanName, cleanDev, newToken, newCode, presence, friendsDb, dailyUid, makeRoom, rooms, store } = ctx;
  const map = new Map(), loading = new Map(), safe = (p) => Promise.resolve(p).catch(() => null);
  let lastPrune = 0;
  const err = (ws, code, detail) => send(ws, { t: 'terror', code, detail });
  const tname = (s) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
  const byPid = (T, pid) => T.players.find((p) => p.pid === pid);
  const findDuel = (S, id) => { let d = null; S.rounds.forEach((r) => r.duels.forEach((x) => { if (x.id === id) d = x; })); return d; };
  const codeOf = (c) => String(c || '').toUpperCase().trim();

  /* ---------- guardar / cargar ---------- */
  function pack(T) {          // lo que se guarda (sin conexiones, sin partidas en juego)
    return { code: T.code, owner: T.owner, name: T.name, status: T.status, cfg: T.cfg, game: T.game, seq: T.seq, orgPid: T.orgPid, S: T.S, created: T.created, last: T.last,
      players: T.players.map((p) => ({ pid: p.pid, name: p.name, uid: p.uid, token: p.token })) };
  }
  function hydrate(d) {
    return { code: d.code, owner: d.owner || '', name: d.name, status: d.status, cfg: d.cfg, game: d.game, seq: d.seq || 0, orgPid: d.orgPid, S: d.S || null, created: d.created || Date.now(), last: d.last || Date.now(), touched: Date.now(),
      players: (d.players || []).map((p) => ({ pid: p.pid, name: p.name, uid: p.uid || '', token: p.token, ws: null, go: null })), ready: {}, rooms: {}, note: '' };
  }
  function save(T) { T.last = Date.now(); return safe(store.put(T.code, { owner: T.owner, status: T.status, data: pack(T) })); }
  function load(code) {
    code = codeOf(code); if (!/^[A-Z0-9]{5}$/.test(code)) return Promise.resolve(null);
    if (map.has(code)) return Promise.resolve(map.get(code));
    if (loading.has(code)) return loading.get(code);
    const pr = safe(store.get(code)).then((d) => {
      loading.delete(code);
      if (!d || typeof d !== 'object' || !d.code || !Array.isArray(d.players)) return null;
      const T = map.get(code) || hydrate(d); map.set(code, T); return T;
    });
    loading.set(code, pr); return pr;
  }

  function readyOf(T) { const o = {}; Object.keys(T.ready).forEach((k) => { if (T.ready[k].size) o[k] = [...T.ready[k]]; }); return o; }
  function watchOf(T) { const o = {}; Object.keys(T.rooms).forEach((id) => { const r = rooms.get(T.rooms[id]); if (r && !r.over) o[id] = r.code; }); return o; }      // duelo → sala en juego (para mirarla)
  function canWatch(code, token) { const T = map.get(String(code || '')); return !!T && T.players.some((x) => x.token === String(token || '')); }
  function snap(T, p) {
    let S = null; if (T.S) { S = JSON.parse(JSON.stringify(T.S)); S.log = []; }
    const live = p && p.go && rooms.get(p.go.code) && !rooms.get(p.go.code).over ? p.go : null;
    return {
      t: 'tsnap', code: T.code, name: T.name, status: T.status, org: T.orgPid, you: p ? { pid: p.pid, org: p.pid === T.orgPid } : null,
      players: T.players.map((x) => ({ pid: x.pid, name: x.name, online: !!x.ws, acct: !!x.uid })),
      cfg: T.cfg, game: T.game, S, ready: readyOf(T), playing: Object.keys(T.rooms), watch: watchOf(T), go: live, note: T.note || ''
    };
  }
  function push(T) { T.touched = Date.now(); T.players.forEach((p) => { if (p.ws) send(p.ws, snap(T, p)); }); }
  const commit = (T) => save(T).then(() => push(T));      // cambio de verdad (se guarda y se avisa); push solo = cambio de presencia o de partida en juego
  async function auth(ws, msg) {
    const T = await load(msg.code);
    if (!T) { err(ws, 'TN_NOT_FOUND'); return null; }
    const p = T.players.find((x) => x.token === String(msg.token || ''));
    if (!p) { err(ws, 'BAD_TOKEN'); return null; }
    return { T, p };
  }
  async function orgOnly(ws, msg) { const a = await auth(ws, msg); if (!a) return null; if (a.p.pid !== a.T.orgPid) { err(ws, 'NOT_ORGANIZER'); return null; } return a; }
  function bind(T, p, ws) { if (p.ws && p.ws !== ws) { try { p.ws.close(4000, 'replaced'); } catch (e) {} } p.ws = ws; ws.tn = { code: T.code, pid: p.pid }; }

  async function closeNow(T, why) {
    map.delete(T.code); await safe(store.del(T.code));
    T.players.forEach((p) => { if (p.ws) { send(p.ws, { t: 'tclosed', code: T.code, why }); p.ws.tn = null; } });
  }
  async function closeOwned(dev) {
    const codes = (await safe(store.openByOwner(dev))) || [];
    map.forEach((T) => { if (T.owner === dev && T.status === 'open' && !codes.includes(T.code)) codes.push(T.code); });
    for (const c of codes) { const T = await load(c); if (T && T.owner === dev && T.status === 'open') await closeNow(T, 'replaced'); }
  }

  function cleanCfg(c) {
    c = c && typeof c === 'object' ? c : {};
    const n = Math.floor(Number(c.minDuels));
    return {
      name: tname(c.name) || 'Torneo de Pente', format: PT.FORMATS.includes(c.format) ? c.format : 'swiss_cut',
      bestOf: PT.BEST_OF.includes(Number(c.bestOf)) ? Number(c.bestOf) : 3, minDuels: n >= 1 && n <= 63 ? n : 2, cut: [2, 4, 8, 16].includes(Number(c.cut)) ? Number(c.cut) : 4
    };
  }
  function addPlayer(T, ws, name, uid) {
    const low = name.toLowerCase();
    if (uid) { const same = T.players.find((x) => x.uid === uid); if (same) { bind(T, same, ws); return same; } }
    if (T.players.length >= MAX_PLAYERS) { err(ws, 'TN_FULL'); return null; }
    if (T.players.some((x) => x.name.toLowerCase() === low)) { err(ws, 'TN_NAME'); return null; }
    const p = { pid: 'p' + (++T.seq), name, uid: uid || '', token: newToken(), ws: null, go: null };
    T.players.push(p); bind(T, p, ws); return p;
  }

  async function onCreate(ws, msg) {
    if (ws.tn) return err(ws, 'ALREADY_IN_TOURNEY');
    if (map.size >= MAX_TOURNEYS) return err(ws, 'SERVER_BUSY');
    let code = null; for (let i = 0; i < 20 && !code; i++) { const c = newCode(map); if (c && !(await load(c))) code = c; }
    if (!code) return err(ws, 'SERVER_BUSY');
    const dev = cleanDev(msg.dev); if (dev) await closeOwned(dev);
    const cfg = cleanCfg(Object.assign({}, msg.cfg, { name: msg.name != null ? msg.name : (msg.cfg || {}).name }));
    const uid = await safe(dailyUid(ws, msg.jwt));
    if (ws.readyState !== 1 || ws.tn) return;
    const T = { code, owner: dev, name: cfg.name, status: 'open', cfg, game: ctx.cleanOpts(Object.assign({}, msg.game, { players: 2, ffa: false })), players: [], seq: 0, orgPid: '', S: null, ready: {}, rooms: {}, created: Date.now(), last: Date.now(), touched: Date.now(), note: '' };
    map.set(code, T);
    const p = addPlayer(T, ws, cleanName(msg.pname, 'Organizador'), uid); if (!p) { map.delete(code); return; }
    T.orgPid = p.pid;
    await save(T);
    send(ws, { t: 'tjoined', code, token: p.token, pid: p.pid, org: true });
    push(T);
  }
  async function onJoin(ws, msg) {
    const T = await load(msg.code);
    if (!T) return err(ws, 'TN_NOT_FOUND');
    if (ws.tn && ws.tn.code !== T.code) return err(ws, 'ALREADY_IN_TOURNEY');
    const uid = await safe(dailyUid(ws, msg.jwt));
    if (ws.readyState !== 1) return;
    const known = uid && T.players.find((x) => x.uid === uid);        // la misma cuenta vuelve a entrar: es la misma persona (también con el torneo ya empezado)
    if (T.status !== 'open' && !known) return err(ws, 'TN_STARTED');
    const fresh = !known, p = known ? (bind(T, known, ws), known) : addPlayer(T, ws, cleanName(msg.name, 'Jugador'), uid);
    if (!p) return;
    if (fresh) await save(T);
    send(ws, { t: 'tjoined', code: T.code, token: p.token, pid: p.pid, org: p.pid === T.orgPid });
    push(T);
  }
  async function onRejoin(ws, msg) {
    const a = await auth(ws, msg); if (!a) return;
    bind(a.T, a.p, ws); send(ws, { t: 'tjoined', code: a.T.code, token: a.p.token, pid: a.p.pid, org: a.p.pid === a.T.orgPid });
    push(a.T);
  }
  async function onStart(ws, msg) {
    const a = await orgOnly(ws, msg); if (!a) return; const T = a.T;
    if (T.status !== 'open') return err(ws, 'TN_STARTED');
    const order = PT.shuffle(T.players.map((p) => p.pid), Math.floor(Math.random() * 1e6) + 1);          // sorteo de cabezas de serie
    let S;
    try { S = PT.create(T.cfg, order.map((pid) => ({ id: pid, name: byPid(T, pid).name }))); } catch (e) { return err(ws, 'TN_INVALID', String(e.message || '').slice(0, 200)); }
    T.S = S; T.status = S.status === 'finished' ? 'finished' : 'running'; await commit(T);
  }
  async function onCfg(ws, msg) {                                      // el organizador corrige el formato mientras se juntan los participantes (p. ej. aplicar una sugerencia)
    const a = await orgOnly(ws, msg); if (!a) return; const T = a.T;
    if (T.status !== 'open') return err(ws, 'TN_STARTED');
    T.cfg = cleanCfg(Object.assign({}, msg.cfg, { name: T.cfg.name })); await commit(T);
  }
  async function onPlay(ws, msg) {
    const a = await auth(ws, msg); if (!a) return; const { T, p } = a;
    if (T.status !== 'running') return err(ws, 'TN_NOT_RUNNING');
    const d = findDuel(T.S, String(msg.duel || ''));
    if (!d || d.status === 'done' || d.bye || !d.a || !d.b || (d.a !== p.pid && d.b !== p.pid)) return err(ws, 'TN_BAD_DUEL');
    if (T.rooms[d.id] && rooms.get(T.rooms[d.id]) && !rooms.get(T.rooms[d.id]).over) { push(T); return; }       // ya hay una partida en juego: se vuelve a mandar su acceso
    delete T.rooms[d.id];
    const set = T.ready[d.id] || (T.ready[d.id] = new Set()); set.add(p.pid);
    if (set.has(d.a) && set.has(d.b)) startGame(T, d);
    push(T);
  }
  function startGame(T, d) {
    const first = PT.opener(d, d.games.length), second = first === d.a ? d.b : d.a, pf = byPid(T, first), ps = byPid(T, second);
    const tk = [newToken(), newToken()];
    const room = makeRoom(T.game, [{ name: pf.name, uid: pf.uid, token: tk[0] }, { name: ps.name, uid: ps.uid, token: tk[1] }], { code: T.code, duelId: d.id, pids: { 1: first, 2: second } });
    if (!room) { T.note = 'busy'; return; }
    T.rooms[d.id] = room.code; T.ready[d.id] = new Set(); T.note = '';
    pf.go = { code: room.code, token: tk[0], you: 1 }; ps.go = { code: room.code, token: tk[1], you: 2 };
  }
  async function onUnplay(ws, msg) { const a = await auth(ws, msg); if (!a) return; const s = a.T.ready[String(msg.duel || '')]; if (s) s.delete(a.p.pid); push(a.T); }

  /* La partida de una sala de torneo terminó: se carga el resultado en el duelo (una partida a la vez). Un empate se vuelve a jugar. */
  function gameOver(room, winner) {
    const tr = room.tourney; if (!tr) return;
    const T = map.get(tr.code); if (!T || !T.S) return;
    delete T.rooms[tr.duelId]; T.players.forEach((p) => { if (p.go && p.go.code === room.code) p.go = null; });
    const pid = tr.pids[winner], d = findDuel(T.S, tr.duelId);
    if (!pid) { T.note = 'draw'; push(T); return; }
    if (d && d.status !== 'done') {
      try { T.S = PT.recordGames(T.S, d.id, d.games.concat([pid])); T.note = ''; } catch (e) { /* ya lo había resuelto el organizador */ }
      if (T.S.status === 'finished') T.status = 'finished';
    }
    commit(T);
  }
  async function onForfeit(ws, msg) {
    const a = await orgOnly(ws, msg); if (!a) return; const T = a.T;
    if (T.status !== 'running') return err(ws, 'TN_NOT_RUNNING');
    try { T.S = PT.forfeit(T.S, String(msg.duel || ''), String(msg.winner || '')); } catch (e) { return err(ws, 'TN_BAD_DUEL', String(e.message || '').slice(0, 120)); }
    delete T.rooms[String(msg.duel)]; T.ready[String(msg.duel)] = new Set(); if (T.S.status === 'finished') T.status = 'finished'; await commit(T);
  }
  function removeFrom(T, pid) {
    if (T.status === 'open') { T.players = T.players.filter((p) => p.pid !== pid); return true; }
    if (T.status === 'running') { try { T.S = PT.withdraw(T.S, pid); if (T.S.status === 'finished') T.status = 'finished'; return true; } catch (e) { return false; } }
    return false;
  }
  async function onWithdraw(ws, msg) {
    const a = await auth(ws, msg); if (!a) return; const { T, p } = a;
    const pid = String(msg.pid || p.pid);
    if (pid !== p.pid && p.pid !== T.orgPid) return err(ws, 'NOT_ORGANIZER');
    if (pid === T.orgPid && T.status === 'open') return err(ws, 'ORG_CANNOT_LEAVE');
    const target = byPid(T, pid); if (!target) return err(ws, 'BAD_REQUEST');
    if (!removeFrom(T, pid)) return err(ws, 'TN_BAD_DUEL');
    if (target.ws) { send(target.ws, { t: 'tclosed', code: T.code, why: pid === p.pid ? 'left' : 'kicked' }); target.ws.tn = null; }
    Object.keys(T.ready).forEach((k) => T.ready[k].delete(pid));
    await commit(T);
  }
  async function onClose(ws, msg) { const a = await orgOnly(ws, msg); if (!a) return; await closeNow(a.T, 'owner'); }

  const AV_OK = /^[a-z][a-z0-9]{0,15}$|^c(\.[a-z]{3,12}){5}$/;
  async function onInvite(ws, msg) {
    const bad = (reason) => send(ws, { t: 'tinviteRes', ok: false, reason, to: String(msg.to || '') });
    const a = await orgOnly(ws, msg); if (!a) return; const { T, p } = a;
    if (T.status !== 'open') return bad('started');
    const now = Date.now(); if (now - (ws.lastTInvite || 0) < 800) return bad('rate'); ws.lastTInvite = now;
    const to = String(msg.to || ''); if (!/^[0-9a-f-]{36}$/i.test(to)) return bad('bad');
    if (T.players.some((x) => x.uid === to)) return bad('already');
    try {
      const from = await dailyUid(ws, msg.jwt);
      if (!from || from === to) return bad('bad');
      let friends = false; try { friends = await friendsDb.are(from, to); } catch (e) { return bad('error'); }
      if (!friends) return bad('notfriends');
      const live = [...(presence.get(to) || [])].filter((w) => w.readyState === 1);
      if (!live.length) return bad('offline');
      const av = AV_OK.test(String(msg.avatar || '')) ? String(msg.avatar) : '', co = /^[A-Z]{2}$/.test(String(msg.country || '')) ? String(msg.country) : '';
      live.forEach((w) => send(w, { t: 'tinvite', code: T.code, name: T.name, from: { name: p.name, avatar: av, country: co }, cfg: T.cfg, game: { size: T.game.size, variant: T.game.variant, blitz: !!T.game.blitz, bullet: !!T.game.bullet } }));
      send(ws, { t: 'tinviteRes', ok: true, to });
    } catch (e) { bad('error'); }
  }

  const HANDLERS = { tcreate: onCreate, tjoin: onJoin, trejoin: onRejoin, tstart: onStart, tcfg: onCfg, tplay: onPlay, tunplay: onUnplay, tforfeit: onForfeit, twithdraw: onWithdraw, tleave: onWithdraw, tclose: onClose, tinvite: onInvite };
  function handle(ws, msg) {
    const h = HANDLERS[msg.t]; if (!h) return false;
    Promise.resolve().then(() => h(ws, msg)).catch(() => err(ws, 'SERVER_ERROR'));
    return true;
  }
  function onSocketClose(ws) {
    const k = ws.tn; if (!k) return; const T = map.get(k.code); if (!T) return;
    const p = byPid(T, k.pid); if (p && p.ws === ws) { p.ws = null; push(T); }
  }
  /* Cada tanto: se descargan de la memoria los torneos sin nadie conectado (siguen guardados) y se borran los viejos del almacén. */
  function sweep(now) {
    map.forEach((T, code) => { if (now - T.touched > EVICT_MS && !T.players.some((p) => p.ws) && !Object.keys(T.rooms).length) map.delete(code); });
    if (now - lastPrune > 6 * 3600e3) { lastPrune = now; safe(store.prune(now - KEEP_MS)); }
  }

  return { handle, onSocketClose, gameOver, sweep, map, canWatch };
};
