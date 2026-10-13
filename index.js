/*
 * Servidor de salas de Pente.
 *
 * El servidor es el ÁRBITRO: guarda la partida y valida cada jugada con el mismo núcleo de reglas
 * (pente-core.js, copia de src/core/pente.js) que usa el cliente. El cliente nunca decide nada.
 *
 * Alcance de esta versión: salas por código/enlace, 2 jugadores (o 4: 2 contra 2, opts.players = 4), reconexión, abandono, reclamar victoria
 * si el rival se desconecta, revancha. Las salas viven en memoria (se pierden si el servidor se reinicia).
 * Si se configuran SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_KEY, las partidas entre dos cuentas verificadas se registran en Supabase.
 *
 * Protocolo (JSON). Cliente -> servidor:
 *   {t:'create', name, jwt?, opts:{tournamentRule, exactFive, size: 13|19, players: 2|4, public: bool}}   {t:'join', code, name, jwt?}   {t:'rejoin', code, token}
 *   {t:'list'}   {t:'spectate', code}      (solo las salas PÚBLICAS se listan y se pueden mirar)
 *   {t:'lobby', on, name}  (entrar/salir del chat del lobby)   {t:'lchat', text, name}  (máx. 160 caracteres, 1 cada 1,2 s, sin links)
 *   {t:'chat', text}   (jugadores y espectadores; máx. 200 caracteres, 1 mensaje cada 0,7 s)
 *   {t:'seat', seat}   (4 jugadores, antes de empezar: pasarse a un asiento libre = elegir equipo)
 *   {t:'move', x, y}  {t:'resign'}  {t:'rematch'}  {t:'claimWin'}  {t:'resync'}  {t:'ping'}
 * Servidor -> cliente:
 *   {t:'joined', code, token, you}   (espectador: {t:'joined', code, you:0, spectator:true}, sin token)
 *   {t:'sync', ...estado completo...}   {t:'move', x, y, n}   {t:'rooms', rooms:[...]}   {t:'spectators', n}
 *   {t:'presence', connected}  {t:'over', winner, reason}  {t:'rematch', votes}  {t:'error', code, detail?}  {t:'pong'}
 * Modo 4 jugadores: asientos 1-4 (turno en ese orden; 1 y 3 son el equipo 1, 2 y 4 el equipo 2). `you` es el asiento; `winner` en
 * `over` es el EQUIPO (1|2) que ganó (en 2 jugadores equipo = asiento). Las salas de 4 no registran estadísticas todavía.
 * Los espectadores reciben lo mismo que los jugadores (sync, move, over, presence) pero no pueden jugar.
 */
'use strict';
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const P = require('./pente-core.js');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // sin I, O, 0, 1 (se confunden)
const CODE_LENGTH = 5;
const MAX_NAME = 18;
const MAX_ROOMS = 500;
const MAX_SPECTATORS = 20;                    // por sala
const MAX_LISTED = 50;                        // salas públicas que devuelve el listado
const FORFEIT_AFTER_MS = 60 * 1000;           // el rival puede reclamar victoria si estuvo desconectado este tiempo
const ROOM_IDLE_TTL_MS = 2 * 60 * 60 * 1000;  // sala sin actividad: se borra
const HEARTBEAT_MS = 25 * 1000;
const TOTAL_MS = 10 * 60 * 1000;             // reloj: tiempo total por jugador
const TURN_MS = 60 * 1000;                   // reloj: tiempo máximo por jugada
const MAX_MSGS_PER_SEC = 12;
const MAX_CHAT = 200;                         // caracteres por mensaje de chat
const CHAT_HISTORY = 50;                      // mensajes que se recuerdan por sala (para el que entra tarde)
const LOBBY_HISTORY = 40, LOBBY_GAP_MS = 1200, LOBBY_MAX = 160;   // chat del lobby: se recuerdan 40, 1 mensaje cada 1,2 s, 160 caracteres
const CHAT_GAP_MS = 700;                      // mínimo entre dos mensajes de la misma persona

function cleanName(s, fallback) {
  s = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, MAX_NAME);
  return s || fallback;
}
function cleanChat(s) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_CHAT);
}
function newCode(rooms) {
  for (let tries = 0; tries < 50; tries++) {
    let c = '';
    for (let i = 0; i < CODE_LENGTH; i++) c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}
const newToken = () => crypto.randomBytes(16).toString('hex');

function createPenteServer(config) {
  config = config || {};
  const allowedOrigins = (config.allowedOrigins || []).filter(Boolean);
  const forfeitAfterMs = config.forfeitAfterMs != null ? config.forfeitAfterMs : FORFEIT_AFTER_MS;
  const totalMs = config.totalMs != null ? config.totalMs : TOTAL_MS, turnMs = config.turnMs != null ? config.turnMs : TURN_MS;
  const rooms = new Map();
  /* Cuentas: el navegador manda su sesión de Supabase (jwt); el servidor la verifica con Supabase y recuerda el uid.
   * Las partidas terminadas entre DOS cuentas verificadas se registran en Supabase (online.sql). Sin esto, no se cuenta nada. */
  const sbUrl = String(config.supabaseUrl || '').replace(/\/+$/, ''), sbAnon = config.supabaseKey || '', sbService = config.supabaseServiceKey || '';
  const jwtCache = new Map();
  const verifyToken = config.verifyToken || ((jwt) => {
    if (!sbUrl || !sbAnon || !jwt) return Promise.resolve(null);
    const hit = jwtCache.get(jwt); if (hit && hit.until > Date.now()) return Promise.resolve(hit.uid);
    return fetch(sbUrl + '/auth/v1/user', { headers: { apikey: sbAnon, Authorization: 'Bearer ' + jwt } })
      .then((r) => (r.ok ? r.json() : null)).then((u) => {
        const uid = u && typeof u.id === 'string' && /^[0-9a-f-]{36}$/i.test(u.id) ? u.id : null;
        if (uid) { if (jwtCache.size > 500) jwtCache.clear(); jwtCache.set(jwt, { uid, until: Date.now() + 5 * 60 * 1000 }); }
        return uid;
      }).catch(() => null);
  });
  const recordResult = config.recordResult || ((rec) => {
    if (!sbUrl || !sbService) return Promise.resolve('off');
    return fetch(sbUrl + '/rest/v1/rpc/record_online', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, svcHeaders()), body: JSON.stringify({ a: rec.a, b: rec.b, winner: rec.winner, moves: rec.moves, reason: rec.reason }) })
      .then((r) => (r.ok ? r.json() : 'error')).catch(() => 'error');
  });
  const MIN_MOVES = config.minMoves != null ? config.minMoves : 10;   // partidas más cortas no cuentan (evita regalar victorias)

  /* Entrar con nombre + contraseña. El servidor busca el email de esa cuenta (el navegador nunca lo ve), pide la sesión a Supabase
   * y se la devuelve. Mismo mensaje para "nombre inexistente" y "contraseña mala". Límite de intentos por IP y por nombre. */
  const tries = new Map();
  function tooMany(key) {
    const now = Date.now(); const a = (tries.get(key) || []).filter((t) => now - t < 10 * 60 * 1000);
    a.push(now); tries.set(key, a); if (tries.size > 5000) tries.clear();
    return a.length > 10;
  }
  const sbFetch = (path, opts) => fetch(sbUrl + path, opts);
  // Las claves nuevas (sb_secret_...) NO son JWT: van solo en "apikey". Las viejas (service_role, empiezan con eyJ) van en los dos.
  const svcHeaders = (extra) => Object.assign({ apikey: sbService }, /^sb_/.test(sbService) ? {} : { Authorization: 'Bearer ' + sbService }, extra);
  const configured = () => !!(sbUrl && sbAnon && sbService);
  const fail = (status, why) => { console.log('[login] ' + why); return { status, body: { error: 'server_error', why } }; };
  const doLogin = config.login || (async (name, password) => {
    if (!configured()) return fail(503, 'not_configured');
    try {
      // login_lookup (password.sql) devuelve el email de esa cuenta SOLO a la clave secret; el navegador nunca lo ve
      const l = await sbFetch('/rest/v1/rpc/login_lookup', { method: 'POST', headers: svcHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ p: name }) });
      if (!l.ok) return fail(503, 'lookup_' + l.status + (l.status === 404 ? '_falta_password.sql' : l.status === 401 || l.status === 403 ? '_clave_secret' : ''));
      const email = await l.json(); if (typeof email !== 'string' || email.indexOf('@') < 1) return { status: 401, body: { error: 'bad_credentials' } };
      const t = await sbFetch('/auth/v1/token?grant_type=password', { method: 'POST', headers: { apikey: sbAnon, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
      if (t.status === 429) return { status: 429, body: { error: 'rate' } };
      if (!t.ok) {
        let j = null; try { j = await t.json(); } catch (e) {}
        const code = String((j && (j.error_code || j.code)) || '');
        if (t.status === 400 && (!code || code === 'invalid_credentials')) return { status: 401, body: { error: 'bad_credentials' } };
        return fail(502, 'token_' + t.status + (code ? '_' + code : ''));          // p. ej. proveedor de email con contraseña desactivado
      }
      const d = await t.json();
      return { status: 200, body: { access_token: d.access_token, refresh_token: d.refresh_token, expires_in: d.expires_in, expires_at: d.expires_at, user: { id: d.user && d.user.id, email: d.user && d.user.email } } };
    } catch (e) { return fail(503, 'unreachable'); }
  });
  function onLoginHttp(req, res, cors) {
    const reply = (st, o) => { res.writeHead(st, Object.assign({ 'Content-Type': 'application/json' }, cors)); res.end(JSON.stringify(o)); };
    let buf = '', dead = false;
    req.on('data', (c) => { buf += c; if (buf.length > 2048 && !dead) { dead = true; reply(413, { error: 'big' }); req.destroy(); } });
    req.on('end', async () => {
      if (dead) return;
      let b; try { b = JSON.parse(buf); } catch (e) { return reply(400, { error: 'bad' }); }
      const name = String(b && b.name != null ? b.name : '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 40), pw = b && typeof b.password === 'string' ? b.password : '';
      if (!name || pw.length < 6 || pw.length > 200) return reply(401, { error: 'bad_credentials' });
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      if (tooMany('ip:' + ip) | tooMany('n:' + name.toLowerCase())) return reply(429, { error: 'rate' });
      const r = await doLogin(name, pw); reply(r.status, r.body);
    });
  }

  const httpServer = http.createServer((req, res) => {
    // /health sirve para "despertar" al servidor cuando el plan gratuito lo durmió, y para monitoreo.
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.url === '/login') {
      const origin = req.headers.origin, okOrigin = !allowedOrigins.length || !origin || allowedOrigins.includes(origin);
      const cors = { 'Access-Control-Allow-Origin': allowedOrigins.length && origin ? origin : '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', Vary: 'Origin' };
      if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
      if (!okOrigin || req.method !== 'POST') { res.writeHead(403, cors); return res.end(); }
      return onLoginHttp(req, res, cors);
    }
    if (req.url === '/health' || req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, rooms: rooms.size, accounts: !!(sbUrl && sbAnon && sbService) }));   // accounts: ¿están cargadas las 3 variables de Supabase?
    } else { res.writeHead(404); res.end(); }
  });

  const wss = new WebSocketServer({
    server: httpServer, maxPayload: 2048,
    verifyClient: (info) => !allowedOrigins.length || !info.origin || allowedOrigins.includes(info.origin)
  });

  /* ---------- Helpers de sala ---------- */
  function send(ws, obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
  const seatList = (room) => (room.opts.players === 4 ? [1, 2, 3, 4] : [1, 2]);
  const isFull = (room) => seatList(room).every((s) => !!room.seats[s]);
  const teamOf = (seat) => (seat % 2 === 1 ? 1 : 2);
  const otherTeam = (team) => (team === 1 ? 2 : 1);
  function seatOf(room, token) { return seatList(room).find((s) => room.seats[s] && room.seats[s].token === token) || 0; }
  function connectedMap(room) { const o = {}; seatList(room).forEach((s) => { o[s] = !!(room.seats[s] && room.seats[s].ws); }); return o; }
  function toSpectators(room, obj) { room.spectators.forEach((w) => send(w, obj)); }
  function broadcast(room, obj) { seatList(room).forEach((s) => room.seats[s] && send(room.seats[s].ws, obj)); toSpectators(room, obj); }
  function announcePresence(room) { broadcast(room, { t: 'presence', connected: connectedMap(room) }); }
  function announceSpectators(room) { broadcast(room, { t: 'spectators', n: room.spectators.size }); }
  function touch(room) { room.lastActivity = Date.now(); }

  /* ---------- Reloj (lo manda el servidor: es el árbitro) ----------
   * Cada jugador tiene totalMs para toda la partida y turnMs por jugada. Si se acaba cualquiera de los dos, pierde.
   * El reloj arranca cuando entra el segundo jugador (y en cada revancha). Los clientes solo lo muestran. */
  function clockStop(room) { if (room.clockTimer) { clearTimeout(room.clockTimer); room.clockTimer = null; } }
  function clockLimit(room) { const c = room.clock; return Math.min(c.rem[c.current], turnMs); }
  function clockStart(room) {
    clockStop(room); room.clock = null;
    if (!room.opts.timer) return;
    room.clock = { rem: { 1: totalMs, 2: totalMs }, current: 1, since: Date.now() };
    clockArm(room);
  }
  function clockArm(room) {
    clockStop(room); const c = room.clock; if (!c || gameOverNow(room)) return;
    const wait = Math.max(0, clockLimit(room) - (Date.now() - c.since)) + 30;     // un pelín de margen para el viaje de la jugada
    room.clockTimer = setTimeout(() => clockExpire(room), wait); if (room.clockTimer.unref) room.clockTimer.unref();
  }
  function clockExpire(room) {
    room.clockTimer = null; const c = room.clock; if (!c || gameOverNow(room)) return;
    if (Date.now() - c.since < clockLimit(room)) return clockArm(room);
    c.rem[c.current] = Math.max(0, c.rem[c.current] - (Date.now() - c.since));
    finish(room, otherTeam(c.current), 'timeout');
  }
  function clockInfo(room) {            // valores "en vivo" al momento de enviar (los clientes cuentan desde ahí, sin depender de relojes ajenos)
    const c = room.clock; if (!c) return { on: false };
    const over = gameOverNow(room), used = over ? 0 : Date.now() - c.since;
    const rem = { 1: c.rem[1], 2: c.rem[2] }; if (!over) rem[c.current] = Math.max(0, rem[c.current] - used);
    return { on: true, total: totalMs, turnMs, rem, current: over ? 0 : c.current, turnLeft: over ? turnMs : Math.max(0, turnMs - used) };
  }

  function freshGame(room) { room.game = P.createGame(room.opts); room.moves = []; room.recorded = false; room.over = null; room.rematch = noVotes(room); clockStop(room); room.clock = null; }
  function noVotes(room) { const o = {}; seatList(room).forEach((s) => { o[s] = false; }); return o; }

  function snapshot(room, seat) {
    return {
      t: 'sync', code: room.code, you: seat, opts: room.opts, public: room.public, spectators: room.spectators.size,
      names: (() => { const o = {}; seatList(room).forEach((s) => { o[s] = room.seats[s] ? room.seats[s].name : ''; }); return o; })(),
      connected: connectedMap(room), moves: room.moves,
      over: room.over, rematch: room.rematch, clock: clockInfo(room),
      disconnectedFor: disconnectedFor(room)
    };
  }
  function disconnectedFor(room) {
    const out = {};
    seatList(room).forEach((s) => { out[s] = 0; });
    seatList(room).forEach((s) => { const p = room.seats[s]; if (p && !p.ws && p.leftAt) out[s] = Date.now() - p.leftAt; });
    return out;
  }
  function gameOverNow(room) { return !!room.over || room.game.status !== 'playing'; }

  function finish(room, winner, reason) {
    room.over = { winner, reason }; clockStop(room);
    broadcast(room, { t: 'over', winner, reason, clock: clockInfo(room) });
    record(room, winner, reason);
  }
  // Solo cuenta si juegan dos cuentas distintas y verificadas, y la partida tuvo un mínimo de jugadas. Una vez por partida.
  function record(room, winner, reason) {
    const s1 = room.seats[1], s2 = room.seats[2];
    if (room.recorded || room.opts.players === 4 || !s1 || !s2 || !s1.uid || !s2.uid || s1.uid === s2.uid || room.moves.length < MIN_MOVES) return;
    room.recorded = true;
    Promise.resolve(recordResult({ a: s1.uid, b: s2.uid, winner: winner === 1 || winner === 2 ? winner : 0, moves: room.moves.length, reason })).catch(() => {});
  }
  function bindAccount(seat, jwt) {
    if (!jwt || typeof jwt !== 'string' || jwt.length > 4000) return;
    Promise.resolve(verifyToken(jwt)).then((uid) => { if (uid) seat.uid = uid; }).catch(() => {});
  }

  /* ---------- Mensajes ---------- */
  function onCreate(ws, msg) {
    if (ws.room) return send(ws, { t: 'error', code: 'ALREADY_IN_ROOM' });
    if (rooms.size >= MAX_ROOMS) return send(ws, { t: 'error', code: 'SERVER_BUSY' });
    const code = newCode(rooms); if (!code) return send(ws, { t: 'error', code: 'SERVER_BUSY' });
    const o = msg.opts || {};
    const opts = { tournamentRule: o.tournamentRule !== false, exactFive: !!o.exactFive, size: o.size === 13 ? 13 : 19, timer: o.timer !== false, players: o.players === 4 ? 4 : 2 };   // solo 13 o 19: nada más pasa
    const room = { code, opts, public: o.public === true, spectators: new Set(), seats: { 1: null, 2: null, 3: null, 4: null }, game: null, moves: [], over: null, rematch: null, lastActivity: Date.now(), chat: [], chatSeq: 0, specSeq: 0 };
    freshGame(room);
    const token = newToken();
    room.seats[1] = { name: cleanName(msg.name, 'Jugador 1'), token, ws: null, leftAt: 0, uid: '' }; bindAccount(room.seats[1], msg.jwt);
    rooms.set(code, room);
    attach(ws, room, 1);
    send(ws, { t: 'joined', code, token, you: 1 });
    send(ws, snapshot(room, 1));
  }

  function onJoin(ws, msg) {
    if (ws.room) return send(ws, { t: 'error', code: 'ALREADY_IN_ROOM' });
    const room = rooms.get(String(msg.code || '').toUpperCase().trim());
    if (!room) return send(ws, { t: 'error', code: 'ROOM_NOT_FOUND' });
    const seat = seatList(room).find((s) => !room.seats[s]);
    if (!seat) return send(ws, { t: 'error', code: 'ROOM_FULL' });
    const token = newToken();
    room.seats[seat] = { name: cleanName(msg.name, 'Jugador ' + seat), token, ws: null, leftAt: 0, uid: '' }; bindAccount(room.seats[seat], msg.jwt);
    attach(ws, room, seat); touch(room);
    if (isFull(room)) clockStart(room);                // ya están todos: corre el reloj del primero
    send(ws, { t: 'joined', code: room.code, token, you: seat });
    // el que entra recibe la foto completa; los que ya estaban también (hay un asiento más ocupado, o ya empezó)
    send(ws, snapshot(room, seat)); sendChatLog(ws, room);
    seatList(room).forEach((s) => { if (s !== seat && room.seats[s]) send(room.seats[s].ws, snapshot(room, s)); });
  }

  /* 4 jugadores: antes de que empiece, cada uno puede pasarse a un asiento libre (así elige equipo: 1 y 3 contra 2 y 4). */
  function onSeat(ws, msg) {
    const room = inRoom(ws); if (!room) return;
    if (room.opts.players !== 4 || isFull(room) || room.moves.length) return send(ws, { t: 'error', code: 'CANNOT_MOVE_SEAT' });
    const to = Math.floor(Number(msg.seat)), from = ws.seat;
    if (!seatList(room).includes(to) || to === from) return send(ws, { t: 'error', code: 'BAD_REQUEST' });
    if (room.seats[to]) return send(ws, { t: 'error', code: 'SEAT_TAKEN' });
    room.seats[to] = room.seats[from]; room.seats[from] = null; ws.seat = to; touch(room);
    send(ws, { t: 'joined', code: room.code, token: room.seats[to].token, you: to });
    seatList(room).forEach((x) => { if (room.seats[x]) send(room.seats[x].ws, snapshot(room, x)); });
  }

  function onRejoin(ws, msg) {
    const room = rooms.get(String(msg.code || '').toUpperCase().trim());
    if (!room) return send(ws, { t: 'error', code: 'ROOM_NOT_FOUND' });
    const seat = seatOf(room, String(msg.token || ''));
    if (!seat) return send(ws, { t: 'error', code: 'BAD_TOKEN' });
    const p = room.seats[seat];
    if (p.ws && p.ws !== ws) { try { p.ws.close(4000, 'replaced'); } catch (e) {} }   // la sesión nueva reemplaza a la vieja
    attach(ws, room, seat); touch(room);
    send(ws, { t: 'joined', code: room.code, token: p.token, you: seat });
    send(ws, snapshot(room, seat)); sendChatLog(ws, room);
    announcePresence(room);
  }

  function attach(ws, room, seat) { ws.room = room; ws.seat = seat; room.seats[seat].ws = ws; room.seats[seat].leftAt = 0; }

  function inRoom(ws) {
    if (ws.spectator) { send(ws, { t: 'error', code: 'NOT_A_PLAYER' }); return null; }
    if (!ws.room || !ws.seat) { send(ws, { t: 'error', code: 'NOT_IN_ROOM' }); return null; }
    return ws.room;
  }

  function onMove(ws, msg) {
    const room = inRoom(ws); if (!room) return;
    if (!isFull(room)) return send(ws, { t: 'error', code: 'WAITING_FOR_RIVAL' });
    if (gameOverNow(room)) return send(ws, { t: 'error', code: P.ERR.GAME_OVER });
    const r = P.playMoveSeat(room.game, msg.x, msg.y, ws.seat);   // el núcleo valida turno (por asiento), límites, ocupación y reglas
    if (!r.ok) return send(ws, { t: 'error', code: 'ILLEGAL', detail: r.error });
    const c = room.clock;
    if (c && teamOf(ws.seat) === c.current) {                          // ¿llegó a tiempo? (si el temporizador todavía no saltó, se decide acá)
      const used = Date.now() - c.since;
      if (used > clockLimit(room) + 150) { c.rem[c.current] = Math.max(0, c.rem[c.current] - used); return finish(room, otherTeam(c.current), 'timeout'); }
      c.rem[c.current] = Math.max(0, c.rem[c.current] - used);
    }
    room.game = r.state; room.moves.push([msg.x, msg.y]); touch(room);
    if (c) { c.current = room.game.current; c.since = Date.now(); }
    if (room.game.status === 'playing') clockArm(room);
    broadcast(room, { t: 'move', x: msg.x, y: msg.y, n: room.moves.length, clock: clockInfo(room) });
    if (room.game.status !== 'playing') finish(room, room.game.winner, room.game.status === 'draw' ? 'draw' : 'game');
  }

  function onResign(ws) {
    const room = inRoom(ws); if (!room || gameOverNow(room) || !isFull(room)) return;
    finish(room, otherTeam(teamOf(ws.seat)), 'resign'); touch(room);
  }

  function onClaimWin(ws) {
    const room = inRoom(ws); if (!room || gameOverNow(room)) return;
    const myTeam = teamOf(ws.seat);
    const gone = seatList(room).some((s) => { const p = room.seats[s]; return teamOf(s) !== myTeam && p && !p.ws && p.leftAt && Date.now() - p.leftAt >= forfeitAfterMs; });
    if (!gone) return send(ws, { t: 'error', code: 'CANNOT_CLAIM' });
    finish(room, myTeam, 'forfeit'); touch(room);
  }

  function onRematch(ws) {
    const room = inRoom(ws); if (!room) return;
    if (!gameOverNow(room)) return send(ws, { t: 'error', code: 'GAME_NOT_OVER' });
    room.rematch[ws.seat] = true; touch(room);
    if (seatList(room).every((s) => room.rematch[s])) {
      // se rotan los asientos (en 2 jugadores se intercambian los lados; en 4 cada uno pasa al asiento siguiente: el equipo que movía primero pasa a mover segundo)
      const old = {}, n = seatList(room).length;
      seatList(room).forEach((s) => { old[s] = room.seats[s]; });
      seatList(room).forEach((s) => { const to = (s % n) + 1; room.seats[to] = old[s]; if (old[s].ws) old[s].ws.seat = to; });
      freshGame(room); clockStart(room);
      seatList(room).forEach((s) => send(room.seats[s].ws, snapshot(room, s)));
      toSpectators(room, snapshot(room, 0));
    } else broadcast(room, { t: 'rematch', votes: room.rematch });
  }

  /* ---------- Salas públicas y espectadores ---------- */
  function publicList() {
    const out = [];
    rooms.forEach((room) => {
      if (!room.public) return;
      const c = connectedMap(room);
      if (!Object.keys(c).some((k) => c[k])) return;                // sala fantasma: nadie conectado
      out.push({
        code: room.code, size: room.opts.size, tournamentRule: room.opts.tournamentRule, exactFive: room.opts.exactFive,
        players: room.opts.players,
        names: seatList(room).map((s) => (room.seats[s] ? room.seats[s].name : '')),
        status: !isFull(room) ? 'waiting' : gameOverNow(room) ? 'over' : 'playing',
        moves: room.moves.length, spectators: room.spectators.size, at: room.lastActivity
      });
    });
    out.sort((a, b) => b.at - a.at);
    return out.slice(0, MAX_LISTED).map((r) => { delete r.at; return r; });
  }

  function onSpectate(ws, msg) {
    if (ws.room) return send(ws, { t: 'error', code: 'ALREADY_IN_ROOM' });
    const room = rooms.get(String(msg.code || '').toUpperCase().trim());
    if (!room) return send(ws, { t: 'error', code: 'ROOM_NOT_FOUND' });
    if (!room.public) return send(ws, { t: 'error', code: 'PRIVATE_ROOM' });             // las salas privadas son solo para jugadores
    if (!isFull(room)) return send(ws, { t: 'error', code: 'NOT_STARTED' });             // no hay nada que mirar todavía
    if (room.spectators.size >= MAX_SPECTATORS) return send(ws, { t: 'error', code: 'SPECTATORS_FULL' });
    ws.room = room; ws.seat = 0; ws.spectator = true; room.spectators.add(ws); touch(room);
    ws.cid = 's' + (++room.specSeq); ws.name = cleanName(msg.name, 'Espectador');
    send(ws, { t: 'joined', code: room.code, you: 0, spectator: true, id: ws.cid });
    send(ws, snapshot(room, 0)); sendChatLog(ws, room);
    announceSpectators(room);
  }


  /* ---------- Chat (jugadores y espectadores comparten la sala) ---------- */
  function sendChatLog(ws, room) { if (room.chat.length) send(ws, { t: 'chatlog', msgs: room.chat }); }
  function onChat(ws, msg) {
    const room = ws.room; if (!room) return send(ws, { t: 'error', code: 'NOT_IN_ROOM' });
    const text = cleanChat(msg.text); if (!text) return;
    const now = Date.now();
    if (ws.lastChat && now - ws.lastChat < CHAT_GAP_MS) return send(ws, { t: 'error', code: 'CHAT_RATE' });
    ws.lastChat = now;
    const seat = ws.spectator ? 0 : ws.seat;
    const m = { id: seat ? 'p' + seat : ws.cid, name: seat ? room.seats[seat].name : ws.name, seat, text, n: ++room.chatSeq };
    room.chat.push(m); if (room.chat.length > CHAT_HISTORY) room.chat.shift();
    touch(room);
    broadcast(room, Object.assign({ t: 'chat' }, m));
  }

  /* ---------- Chat del lobby (la pantalla de salas públicas) ---------- */
  const lobby = { log: [], seq: 0, members: new Set(), last: null };
  function lobbySend(ws, o) { send(ws, o); }
  function lobbyCount() { lobby.members.forEach((w) => send(w, { t: 'lobbyn', n: lobby.members.size })); }
  function lobbyLeave(ws) { if (ws.lobby) { ws.lobby = false; lobby.members.delete(ws); lobbyCount(); } }
  function onLobby(ws, msg) {
    if (msg.on === false) return lobbyLeave(ws);
    if (ws.room) return send(ws, { t: 'error', code: 'BAD_REQUEST' });
    ws.lname = cleanName(msg.name, 'Invitado');
    if (!ws.lobby) { ws.lobby = true; ws.lid = 'l' + (++lobby.seq); lobby.members.add(ws); }
    send(ws, { t: 'lchatlog', msgs: lobby.log, me: ws.lid }); lobbyCount();
  }
  function onLobbyChat(ws, msg) {
    if (!ws.lobby) return send(ws, { t: 'error', code: 'NOT_IN_LOBBY' });
    const text = cleanChat(msg.text).slice(0, LOBBY_MAX); if (!text) return;
    if (/https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|gg|ly|me|xyz|ar)\b/i.test(text)) return send(ws, { t: 'error', code: 'LINK_BLOCKED' });   // sin links: el lobby es público
    const now = Date.now();
    if (ws.lastLobby && now - ws.lastLobby < LOBBY_GAP_MS) return send(ws, { t: 'error', code: 'CHAT_RATE' });
    if (ws.lastLobbyText === text && now - ws.lastLobby < 30000) return send(ws, { t: 'error', code: 'CHAT_RATE' });   // el mismo mensaje repetido
    ws.lastLobby = now; ws.lastLobbyText = text;
    if (msg.name) ws.lname = cleanName(msg.name, ws.lname || 'Invitado');
    const m = { id: ws.lid, name: ws.lname || 'Invitado', text, n: ++lobby.seq, at: now };
    lobby.log.push(m); if (lobby.log.length > LOBBY_HISTORY) lobby.log.shift();
    lobby.members.forEach((w) => send(w, Object.assign({ t: 'lchat' }, m)));
  }

  /* ---------- Conexiones ---------- */
  wss.on('connection', (ws) => {
    ws.isAlive = true; ws.room = null; ws.seat = 0; ws.spectator = false; ws.bucket = { n: 0, t: Date.now() };
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (data) => {
      ws.isAlive = true;
      const now = Date.now();
      if (now - ws.bucket.t > 1000) ws.bucket = { n: 0, t: now };
      if (++ws.bucket.n > MAX_MSGS_PER_SEC) return send(ws, { t: 'error', code: 'RATE_LIMIT' });
      let msg; try { msg = JSON.parse(String(data)); } catch (e) { return send(ws, { t: 'error', code: 'BAD_REQUEST' }); }
      if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return send(ws, { t: 'error', code: 'BAD_REQUEST' });
      switch (msg.t) {
        case 'create': lobbyLeave(ws); return onCreate(ws, msg);
        case 'join': lobbyLeave(ws); return onJoin(ws, msg);
        case 'rejoin': lobbyLeave(ws); return onRejoin(ws, msg);
        case 'list': return send(ws, { t: 'rooms', rooms: publicList() });
        case 'spectate': lobbyLeave(ws); return onSpectate(ws, msg);
        case 'chat': return onChat(ws, msg);
        case 'lobby': return onLobby(ws, msg);
        case 'lchat': return onLobbyChat(ws, msg);
        case 'move': return onMove(ws, msg);
        case 'seat': return onSeat(ws, msg);
        case 'resign': return onResign(ws);
        case 'rematch': return onRematch(ws);
        case 'claimWin': return onClaimWin(ws);
        case 'resync': { if (!ws.room) return send(ws, { t: 'error', code: 'NOT_IN_ROOM' }); return send(ws, snapshot(ws.room, ws.seat)); }
        case 'ping': return send(ws, { t: 'pong' });
        default: return send(ws, { t: 'error', code: 'BAD_REQUEST' });
      }
    });
    ws.on('close', () => {
      lobbyLeave(ws);
      const room = ws.room; if (!room) return;
      if (ws.spectator) { room.spectators.delete(ws); announceSpectators(room); return; }
      const p = room.seats[ws.seat];
      if (p && p.ws === ws) {                         // si ya lo reemplazó otra conexión, no se marca como ido
        p.ws = null; p.leftAt = Date.now();
        announcePresence(room);
      }
    });
    ws.on('error', () => {});
  });

  // Latido: detecta conexiones muertas y mantiene vivas las de los proxies. Limpia salas viejas.
  const timer = setInterval(() => {
    wss.clients.forEach((ws) => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; try { ws.ping(); } catch (e) {} });
    const now = Date.now();
    rooms.forEach((room, code) => { if (now - room.lastActivity > ROOM_IDLE_TTL_MS) rooms.delete(code); });
  }, config.heartbeatMs || HEARTBEAT_MS);
  timer.unref();

  return {
    httpServer, wss, rooms,
    listen: (port) => new Promise((res) => httpServer.listen(port, () => res(httpServer.address().port))),
    close: () => new Promise((res) => { clearInterval(timer); wss.clients.forEach((c) => c.terminate()); wss.close(() => httpServer.close(() => res())); })
  };
}

module.exports = { createPenteServer };

if (require.main === module) {
  const port = parseInt(process.env.PORT, 10) || 8787;
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim());
  const srv = createPenteServer({ allowedOrigins, supabaseUrl: process.env.SUPABASE_URL, supabaseKey: process.env.SUPABASE_ANON_KEY, supabaseServiceKey: process.env.SUPABASE_SERVICE_KEY });
  srv.listen(port).then((p) => console.log('Pente server escuchando en puerto ' + p + (allowedOrigins.filter(Boolean).length ? ' | orígenes permitidos: ' + allowedOrigins.join(', ') : ' | cualquier origen')));
}
