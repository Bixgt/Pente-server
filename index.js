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
 *   {t:'create', name, jwt?, opts:{ffa: bool (4 jugadores, todos contra todos), variant: 'classic'|'pairs3'|'triples'|'gomoku', blitz: bool, bullet: bool (1 min por jugador), tournamentRule, exactFive, size: 13|19, players: 2|4, public: bool}}   {t:'join', code, name, jwt?}   {t:'rejoin', code, token}
 *   {t:'list'}   {t:'spectate', code}      (solo las salas PÚBLICAS se listan y se pueden mirar)
 *   {t:'lobby', on, name}  (entrar/salir del chat del lobby)   {t:'lchat', text, name}  (máx. 160 caracteres, 1 cada 1,2 s, sin links)
 *   {t:'chat', text}   (jugadores y espectadores; máx. 200 caracteres, 1 mensaje cada 0,7 s)
 *   {t:'bot', level: 'beginner'|'easy'|'medium'|'hard', seat?}   {t:'botoff', seat}   (4 jugadores, antes de empezar: sumar o sacar un bot; lo juega el servidor)
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
const AI = require('./pente-ai.js');
const D = require('./pente-daily.js');
const XP = require('./pente-xp.js');

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
const BULLET_MS = 60 * 1000;                // bullet: 1 minuto por jugador en total, sin tiempo por jugada
const BLITZ_MS = 3 * 60 * 1000;               // blitz: 3 minutos por jugador en total, sin tiempo por jugada
const BOT_LEVELS = ['beginner', 'easy', 'medium', 'hard'];      // bots que se pueden sumar a una sala de 4 (la máquina juega desde el servidor)
const BOT_THINK_MS = { beginner: [900, 1800], easy: [900, 1700], medium: [700, 1400], hard: [500, 1000] }, BOT_CALC_MS = { beginner: 0, easy: 0, medium: 300, hard: 450 };
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
  const totalMs = config.totalMs != null ? config.totalMs : TOTAL_MS, turnMs = config.turnMs != null ? config.turnMs : TURN_MS, blitzMs = config.blitzMs != null ? config.blitzMs : BLITZ_MS, bulletMs = config.bulletMs != null ? config.bulletMs : BULLET_MS;
  const roomTotal = (room) => (room.opts.bullet ? bulletMs : room.opts.blitz ? blitzMs : totalMs), roomTurn = (room) => (room.opts.blitz || room.opts.bullet ? 0 : turnMs);   // 0 = sin límite por jugada
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
  const teamOf = (room, seat) => (room.opts.ffa ? seat : seat % 2 === 1 ? 1 : 2);   // en todos contra todos cada asiento es su propio equipo
  const clockKeys = (room) => (room.opts.ffa ? [1, 2, 3, 4] : [1, 2]);
  const otherTeam = (team) => (team === 1 ? 2 : 1);
  function seatOf(room, token) { return seatList(room).find((s) => room.seats[s] && room.seats[s].token === token) || 0; }
  function connectedMap(room) { const o = {}; seatList(room).forEach((s) => { o[s] = !!(room.seats[s] && (room.seats[s].ws || room.seats[s].bot)); }); return o; }
  const botsOf = (room) => { const o = {}; seatList(room).forEach((s) => { if (room.seats[s] && room.seats[s].bot) o[s] = room.seats[s].level; }); return o; };
  const humanOnline = (room) => seatList(room).some((s) => room.seats[s] && room.seats[s].ws);
  function toSpectators(room, obj) { room.spectators.forEach((w) => send(w, obj)); }
  function broadcast(room, obj) { seatList(room).forEach((s) => room.seats[s] && send(room.seats[s].ws, obj)); toSpectators(room, obj); }
  function announcePresence(room) { broadcast(room, { t: 'presence', connected: connectedMap(room) }); }
  function announceSpectators(room) { broadcast(room, { t: 'spectators', n: room.spectators.size }); }
  function touch(room) { room.lastActivity = Date.now(); }

  /* ---------- Reloj (lo manda el servidor: es el árbitro) ----------
   * Cada jugador tiene totalMs para toda la partida y turnMs por jugada. Si se acaba cualquiera de los dos, pierde.
   * El reloj arranca cuando entra el segundo jugador (y en cada revancha). Los clientes solo lo muestran. */
  function clockStop(room) { if (room.clockTimer) { clearTimeout(room.clockTimer); room.clockTimer = null; } }
  function clockLimit(room) { const c = room.clock, tm = roomTurn(room); return tm ? Math.min(c.rem[c.current], tm) : c.rem[c.current]; }
  function clockStart(room) {
    clockStop(room); room.clock = null;
    if (!room.opts.timer) return;
    room.clock = { rem: {}, current: 1, since: Date.now(), started: false }; clockKeys(room).forEach((k) => { room.clock.rem[k] = roomTotal(room); });   // started: el reloj corre desde la PRIMERA ficha, no desde que se llena la sala
    clockArm(room);
  }
  function clockArm(room) {
    clockStop(room); const c = room.clock; if (!c || !c.started || gameOverNow(room)) return;
    const wait = Math.max(0, clockLimit(room) - (Date.now() - c.since)) + 30;     // un pelín de margen para el viaje de la jugada
    room.clockTimer = setTimeout(() => clockExpire(room), wait); if (room.clockTimer.unref) room.clockTimer.unref();
  }
  function clockExpire(room) {
    room.clockTimer = null; const c = room.clock; if (!c || !c.started || gameOverNow(room)) return;
    if (Date.now() - c.since < clockLimit(room)) return clockArm(room);
    c.rem[c.current] = Math.max(0, c.rem[c.current] - (Date.now() - c.since));
    if (room.opts.ffa) return eliminateSeat(room, c.current, 'timeout');
    finish(room, otherTeam(c.current), 'timeout');
  }
  function clockInfo(room) {            // valores "en vivo" al momento de enviar (los clientes cuentan desde ahí, sin depender de relojes ajenos)
    const c = room.clock; if (!c) return { on: false };
    const over = gameOverNow(room), used = over || !c.started ? 0 : Date.now() - c.since;
    const rem = Object.assign({}, c.rem); if (!over && c.started) rem[c.current] = Math.max(0, rem[c.current] - used);
    const tm = roomTurn(room);
    return { on: true, started: !!c.started, total: roomTotal(room), turnMs: tm, blitz: !!(room.opts.blitz || room.opts.bullet), bullet: !!room.opts.bullet, rem, current: over ? 0 : c.current, turnLeft: !tm ? 0 : over ? tm : Math.max(0, tm - used) };
  }

  function freshGame(room) { room.game = P.createGame(room.opts); room.moves = []; room.outs = []; room.recorded = false; room.over = null; room.rematch = noVotes(room); clockStop(room); room.clock = null; }
  function noVotes(room) { const o = {}; seatList(room).forEach((s) => { o[s] = !!(room.seats[s] && room.seats[s].bot); }); return o; }   // los bots siempre aceptan la revancha

  function snapshot(room, seat) {
    return {
      t: 'sync', code: room.code, you: seat, opts: room.opts, public: room.public, spectators: room.spectators.size,
      names: (() => { const o = {}; seatList(room).forEach((s) => { o[s] = room.seats[s] ? room.seats[s].name : ''; }); return o; })(),
      connected: connectedMap(room), bots: botsOf(room), moves: room.moves, outs: room.outs,
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
    if (room.recorded || room.opts.players === 4 || room.opts.variant !== 'classic' || room.opts.blitz || room.opts.bullet || !s1 || !s2 || !s1.uid || !s2.uid || s1.uid === s2.uid || room.moves.length < MIN_MOVES) return;
    room.recorded = true;
    const day = todayKey(), gid = 'online:' + require('crypto').randomUUID(), w = winner === 1 || winner === 2 ? winner : 0;
    [1, 2].forEach((k) => { grantXp(room.seats[k].uid, gid, XP.onlineGain(w === k), 'online', day, XP.ONLINE_DAILY_CAP); });
    Promise.resolve(recordResult({ a: s1.uid, b: s2.uid, winner: winner === 1 || winner === 2 ? winner : 0, moves: room.moves.length, reason })).catch(() => {});
  }
  function bindAccount(seat, jwt) {
    if (!jwt || typeof jwt !== 'string' || jwt.length > 4000) return;
    Promise.resolve(verifyToken(jwt)).then((uid) => { if (uid) seat.uid = uid; }).catch(() => {});
  }

  /* ---------- Presencia e invitaciones a amigos ----------
   * Con la sesión iniciada, el navegador mantiene una conexión liviana ({t:'hi', jwt}) para que sus amigos puedan invitarlo a jugar.
   * El anfitrión crea la sala (con hold:true: nadie más puede sentarse) y manda {t:'invite', to, code}; si el amigo está conectado y
   * es amigo de verdad (se chequea en la base), recibe la invitación. Si acepta entra con el código; si no, la sala se libera. */
  const presence = new Map();                                      // uid -> conexiones de esa cuenta
  const sbFriends = () => ({
    are: async (a, b) => {
      const q = encodeURIComponent, r = await fetch(sbUrl + '/rest/v1/friendships?status=eq.accepted&or=(and(a.eq.' + q(a) + ',b.eq.' + q(b) + '),and(a.eq.' + q(b) + ',b.eq.' + q(a) + '))&select=a&limit=1', { headers: svcHeaders() });
      if (!r.ok) throw new Error('sb ' + r.status); return (await r.json()).length > 0;
    },
  });
  const friendsDb = config.friendsDb || (sbUrl && sbService ? sbFriends() : { are: async () => false });
  const presenceDel = (ws) => { if (!ws.suid) return; const set = presence.get(ws.suid); if (set) { set.delete(ws); if (!set.size) presence.delete(ws.suid); } ws.suid = null; };
  function onHi(ws, msg) {
    dailyUid(ws, msg.jwt).then((uid) => {
      if (!uid) return send(ws, { t: 'hi', ok: false });
      if (ws.suid && ws.suid !== uid) presenceDel(ws);
      ws.suid = uid; if (!presence.has(uid)) presence.set(uid, new Set()); presence.get(uid).add(ws);
      send(ws, { t: 'hi', ok: true });
    });
  }
  const AV_OK = /^[a-z][a-z0-9]{0,15}$|^c(\.[a-z]{3,12}){5}$/;
  function onInvite(ws, msg) {
    const room = ws.room, bad = (reason) => send(ws, { t: 'inviteRes', ok: false, reason });
    if (!room || ws.spectator || ws.seat !== 1 || !room.seats[1] || room.seats[1].ws !== ws || isFull(room)) return bad('bad');
    const now = Date.now(); if (now - (ws.lastInvite || 0) < 3000) return bad('rate'); ws.lastInvite = now;
    const to = String(msg.to || '');
    if (!/^[0-9a-f-]{36}$/i.test(to)) return bad('bad');
    dailyUid(ws, msg.jwt).then(async (from) => {
      if (!from || from === to) return bad('bad');
      let friends = false; try { friends = await friendsDb.are(from, to); } catch (e) { return bad('error'); }
      if (!friends) return bad('notfriends');
      const live = [...(presence.get(to) || [])].filter((w) => w.readyState === 1);
      if (!live.length) { room.reserved = ''; return bad('offline'); }
      room.reserved = to;
      const av = AV_OK.test(String(msg.avatar || '')) ? String(msg.avatar) : '', co = /^[A-Z]{2}$/.test(String(msg.country || '')) ? String(msg.country) : '';
      const pl = { t: 'invite', code: room.code, from: { name: room.seats[1].name, avatar: av, country: co }, watch: !!room.public, opts: { size: room.opts.size, variant: room.opts.variant, blitz: !!room.opts.blitz, bullet: !!room.opts.bullet } };
      live.forEach((w) => send(w, pl)); send(ws, { t: 'inviteRes', ok: true, code: room.code });
    }).catch(() => bad('error'));
  }
  function onInviteNo(ws, msg) {
    const room = rooms.get(String(msg.code || '').toUpperCase().trim());
    if (!room || !ws.suid || room.reserved !== ws.suid) return;
    room.reserved = '';
    const s = room.seats[1]; if (s && s.ws) send(s.ws, { t: 'inviteDeclined', code: room.code, name: cleanName(msg.name, 'Tu amigo'), reason: msg.reason === 'busy' ? 'busy' : 'no' });
  }
  function joinGuarded(ws, msg) {                                  // una sala reservada para un amigo solo la puede ocupar esa cuenta
    const room = rooms.get(String(msg.code || '').toUpperCase().trim());
    if (!room || !room.reserved || isFull(room)) return onJoin(ws, msg);
    Promise.resolve(msg.jwt ? verifyToken(msg.jwt) : null).catch(() => null).then((uid) => {
      if (uid && uid === room.reserved) return onJoin(ws, msg);
      send(ws, { t: 'error', code: 'RESERVED' });
    });
  }

  /* ---------- Mensajes ---------- */
  function onCreate(ws, msg) {
    if (ws.room) return send(ws, { t: 'error', code: 'ALREADY_IN_ROOM' });
    if (rooms.size >= MAX_ROOMS) return send(ws, { t: 'error', code: 'SERVER_BUSY' });
    const code = newCode(rooms); if (!code) return send(ws, { t: 'error', code: 'SERVER_BUSY' });
    const o = msg.opts || {};
    const variant = P.VARIANTS.includes(o.variant) ? o.variant : 'classic';
    const ffa = o.players === 4 && o.ffa === true;
    const opts = { ffa, variant, blitz: o.blitz === true && o.bullet !== true, bullet: o.bullet === true, tournamentRule: variant === 'gomoku' || ffa ? false : o.tournamentRule !== false, exactFive: variant === 'gomoku' ? false : !!o.exactFive, size: o.size === 13 ? 13 : 19, timer: o.blitz === true || o.bullet === true ? true : o.timer !== false, players: o.players === 4 ? 4 : 2 };   // blitz siempre lleva reloj   // solo 13 o 19: nada más pasa
    const room = { code, opts, public: o.public === true, reserved: o.hold === true ? '*' : '',  spectators: new Set(), seats: { 1: null, 2: null, 3: null, 4: null }, game: null, moves: [], over: null, rematch: null, lastActivity: Date.now(), chat: [], chatSeq: 0, specSeq: 0 };
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
    if (isFull(room)) botMaybeMove(room);                // si el primero en mover es un bot, piensa
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

  // Todos contra todos: un asiento queda afuera (abandono, tiempo o desconexión larga). Sus fichas quedan; se saltea su turno. Si queda uno, gana.
  function eliminateSeat(room, seat, reason) {
    const r = P.eliminate(room.game, seat); if (!r.ok) return false;
    const wasCurrent = room.game.current === seat;
    room.game = r.state; room.outs.push([room.moves.length, seat]); touch(room);
    const c = room.clock;
    if (c && wasCurrent && room.game.status === 'playing') { c.current = room.game.current; c.since = Date.now(); }
    broadcast(room, { t: 'out', seat, reason, at: room.moves.length, clock: clockInfo(room) });
    if (room.game.status !== 'playing') { finish(room, room.game.winner, 'last'); return true; }
    clockArm(room); botMaybeMove(room);
    return true;
  }
  function onMove(ws, msg) {
    const room = inRoom(ws); if (!room) return;
    const err = applyMove(room, ws.seat, msg.x, msg.y);
    if (err) send(ws, { t: 'error', code: err.code, detail: err.detail });
  }
  // Juega una jugada de un asiento (persona o bot). Devuelve null si salió bien o {code, detail?}.
  function applyMove(room, seat, x, y) {
    if (!isFull(room)) return { code: 'WAITING_FOR_RIVAL' };
    if (gameOverNow(room)) return { code: P.ERR.GAME_OVER };
    const r = P.playMoveSeat(room.game, x, y, seat);   // el núcleo valida turno (por asiento), límites, ocupación y reglas
    if (!r.ok) return { code: 'ILLEGAL', detail: r.error };
    const c = room.clock;
    if (c && !c.started) { c.started = true; c.since = Date.now(); }                // primera ficha: arranca el reloj
    if (c && teamOf(room, seat) === c.current) {                          // ¿llegó a tiempo? (si el temporizador todavía no saltó, se decide acá)
      const used = Date.now() - c.since;
      if (used > clockLimit(room) + 150) {
        c.rem[c.current] = Math.max(0, c.rem[c.current] - used);
        if (room.opts.ffa) eliminateSeat(room, c.current, 'timeout'); else finish(room, otherTeam(c.current), 'timeout');
        return null;
      }
      c.rem[c.current] = Math.max(0, c.rem[c.current] - used);
    }
    room.game = r.state; room.moves.push([x, y]); touch(room);
    if (c) { c.current = room.game.current; c.since = Date.now(); }
    if (room.game.status === 'playing') clockArm(room);
    broadcast(room, { t: 'move', x, y, n: room.moves.length, clock: clockInfo(room) });
    if (room.game.status !== 'playing') finish(room, room.game.winner, room.game.status === 'draw' ? 'draw' : 'game');
    else botMaybeMove(room);
    return null;
  }

  /* ---------- Bots (solo salas de 4): ocupan un asiento y juegan desde el servidor ---------- */
  function botMaybeMove(room) {
    if (room.botTimer || !isFull(room) || gameOverNow(room) || rooms.get(room.code) !== room) return;
    const seat = P.seatToMove(room.game), p = room.seats[seat];
    if (!p || !p.bot) return;
    const th = BOT_THINK_MS[p.level] || BOT_THINK_MS.medium, wait = th[0] + Math.random() * (th[1] - th[0]);
    room.botTimer = setTimeout(() => {
      room.botTimer = null;
      if (rooms.get(room.code) !== room || !isFull(room) || gameOverNow(room) || P.seatToMove(room.game) !== seat || room.seats[seat] !== p) return;
      let m = null;
      try { m = AI.chooseMove(room.game, { level: p.level, timeMs: BOT_CALC_MS[p.level] }); } catch (e) { m = null; }
      if (!m) { const l = P.legalMoves(room.game); m = l[Math.floor(Math.random() * l.length)]; }
      if (m) applyMove(room, seat, m.x, m.y);
    }, wait);
    if (room.botTimer.unref) room.botTimer.unref();
  }
  function fullStart(room) {                // acaba de completarse la sala: arranca el reloj, todos reciben la foto y, si le toca a un bot, piensa
    clockStart(room);
    seatList(room).forEach((x) => { if (room.seats[x]) send(room.seats[x].ws, snapshot(room, x)); });
    botMaybeMove(room);
  }
  function onBot(ws, msg) {
    const room = inRoom(ws); if (!room) return;
    if (room.opts.players !== 4 || isFull(room) || room.moves.length) return send(ws, { t: 'error', code: 'CANNOT_ADD_BOT' });
    const level = BOT_LEVELS.includes(msg.level) ? msg.level : 'medium';
    const seat = msg.seat ? Math.floor(Number(msg.seat)) : seatList(room).find((x) => !room.seats[x]);
    if (!seatList(room).includes(seat)) return send(ws, { t: 'error', code: 'BAD_REQUEST' });
    if (room.seats[seat]) return send(ws, { t: 'error', code: 'SEAT_TAKEN' });
    room.seats[seat] = { name: 'Bot ' + seat, token: newToken(), ws: null, leftAt: 0, uid: '', bot: true, level }; touch(room);
    room.rematch = noVotes(room);
    if (isFull(room)) return fullStart(room);
    seatList(room).forEach((x) => { if (room.seats[x]) send(room.seats[x].ws, snapshot(room, x)); });
  }
  function onBotOff(ws, msg) {
    const room = inRoom(ws); if (!room) return;
    const seat = Math.floor(Number(msg.seat)), p = room.seats[seat];
    if (room.opts.players !== 4 || !p || !p.bot || isFull(room) || room.moves.length) return send(ws, { t: 'error', code: 'CANNOT_ADD_BOT' });
    room.seats[seat] = null; touch(room);
    seatList(room).forEach((x) => { if (room.seats[x]) send(room.seats[x].ws, snapshot(room, x)); });
  }

  function onResign(ws) {
    const room = inRoom(ws); if (!room || gameOverNow(room) || !isFull(room)) return;
    if (room.opts.ffa) { eliminateSeat(room, ws.seat, 'resign'); return; }
    finish(room, otherTeam(teamOf(room, ws.seat)), 'resign'); touch(room);
  }

  function onClaimWin(ws) {
    const room = inRoom(ws); if (!room || gameOverNow(room)) return;
    const myTeam = teamOf(room, ws.seat);
    const goneSeats = seatList(room).filter((s) => { const p = room.seats[s]; return teamOf(room, s) !== myTeam && p && !p.ws && p.leftAt && Date.now() - p.leftAt >= forfeitAfterMs; });
    if (!goneSeats.length) return send(ws, { t: 'error', code: 'CANNOT_CLAIM' });
    if (room.opts.ffa) {                                   // en todos contra todos se saca a los ausentes (si quedás solo, ganás)
      let any = false; goneSeats.forEach((s) => { if (!room.game.out[s] && !gameOverNow(room)) any = eliminateSeat(room, s, 'forfeit') || any; });
      if (!any) send(ws, { t: 'error', code: 'CANNOT_CLAIM' });
      return;
    }
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
      botMaybeMove(room);
    } else broadcast(room, { t: 'rematch', votes: room.rematch });
  }

  /* ---------- Salas públicas y espectadores ---------- */
  function publicList() {
    const out = [];
    rooms.forEach((room) => {
      if (!room.public) return;
      if (room.reserved && !isFull(room)) return;                    // sala armada para un amigo: no se ofrece a otros mientras espera
      const c = connectedMap(room);
      if (!humanOnline(room)) return;                                // sala fantasma: ninguna persona conectada (los bots no cuentan)
      out.push({
        code: room.code, size: room.opts.size, tournamentRule: room.opts.tournamentRule, exactFive: room.opts.exactFive,
        players: room.opts.players,
        names: seatList(room).map((s) => (room.seats[s] ? room.seats[s].name : '')), bots: Object.keys(botsOf(room)).length,
        variant: room.opts.variant, blitz: !!room.opts.blitz, bullet: !!room.opts.bullet, ffa: !!room.opts.ffa,
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

  /* ---------- Desafío diario ----------
   * Una partida por cuenta y por día contra la máquina, desde la misma posición para todos. El servidor es el árbitro: valida cada jugada,
   * juega por la máquina (con azar fijo del día) y mide el tiempo (desde la primera ficha hasta el final). El cliente nunca manda su puntaje.
   * Con Supabase (supabase/daily.sql) el intento y las jugadas se guardan: si Render se reinicia se retoma la partida y el día no se puede repetir.
   * Sin Supabase todo vive en memoria (sirve para probar). */
  const dailyGames = new Map();                                    // 'uid|AAAA-MM-DD' -> partida
  const todayKey = config.dayKey || (() => D.dayKey());
  const memDb = () => {                                            // base en memoria (pruebas / sin Supabase)
    const rows = new Map();
    return {
      load: async (uid, day) => rows.get(uid + '|' + day) || null,
      save: async (row) => { rows.set(row.uid + '|' + row.day, Object.assign({}, rows.get(row.uid + '|' + row.day), row)); },
      day: async (day) => [...rows.values()].filter((r) => r.day === day && (r.finished || r.moves >= 1)),
      history: async (uid, from) => [...rows.values()].filter((r) => r.uid === uid && (r.finished || r.moves >= 1) && r.day >= from).map((r) => r.day),
      names: async (uids) => { const o = {}; uids.forEach((u) => { const r = [...rows.values()].find((x) => x.uid === u && x.name); o[u] = { name: r ? r.name : 'Jugador', avatar: '' }; }); return o; },
    };
  };
  const sbDailyDb = () => {                                        // base en Supabase (tabla daily_scores, solo con la clave secret)
    const get = (path) => fetch(sbUrl + '/rest/v1/' + path, { headers: svcHeaders() }).then((r) => (r.ok ? r.json() : Promise.reject(new Error('sb ' + r.status))));
    const q = (v) => encodeURIComponent(v);
    return {
      load: async (uid, day) => { const a = await get('daily_scores?uid=eq.' + q(uid) + '&day=eq.' + q(day) + '&select=*&limit=1'); return a[0] || null; },
      save: async (row) => {
        const body = Object.assign({}, row); delete body.name;
        const r = await fetch(sbUrl + '/rest/v1/daily_scores?on_conflict=uid,day', { method: 'POST', headers: svcHeaders({ 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }), body: JSON.stringify(body) });
        if (!r.ok) throw new Error('sb ' + r.status);
      },
      history: async (uid, from) => (await get('daily_scores?uid=eq.' + q(uid) + '&or=(finished.eq.true,moves.gte.1)&day=gte.' + q(from) + '&select=day&limit=20')).map((r) => r.day),
      day: (day) => get('daily_scores?day=eq.' + q(day) + '&or=(finished.eq.true,moves.gte.1)&select=uid,finished,win,draw,moves,ms,level,captures,reason&limit=1000'),
      names: async (uids) => {
        const o = {}; if (!uids.length) return o;
        const a = await get('profiles?id=in.(' + uids.map(q).join(',') + ')&select=id,name,avatar,country:prefs->>country');
        a.forEach((p) => { o[p.id] = { name: p.name || 'Jugador', avatar: p.avatar || '', country: /^[A-Z]{2}$/.test(p.country || '') ? p.country : '' }; }); return o;
      },
    };
  };
  /* XP verificado: lo reparte SOLO el servidor (desafío diario terminado, partida online entre dos cuentas). Cada premio tiene una clave única (no se cobra dos veces).
   * Base: supabase/xp.sql (xp_ledger + profiles.xp_v). Sin Supabase queda en memoria (para probar). */
  const memXp = () => {
    const ledger = new Map(), tot = new Map();
    return {
      grant: async (uid, key, amount, kind, day, cap) => {
        if (cap && [...ledger.values()].filter((r) => r.uid === uid && r.kind === kind && r.day === day).length >= cap) return -2;
        if (ledger.has(uid + '|' + key)) return -1;
        ledger.set(uid + '|' + key, { uid, kind, day }); const t = (tot.get(uid) || 0) + amount; tot.set(uid, t); return t;
      },
      totals: async (uids) => { const o = {}; uids.forEach((u) => { o[u] = tot.get(u) || 0; }); return o; },
    };
  };
  /* Nivel que ven los demás: el mayor entre el XP verificado y el que la cuenta sincronizó en su perfil (stats.xp.t, ver supabase/xp2.sql) */
  const shownXp = (v, xpt) => Math.max(Number(v) || 0, /^[0-9]{1,8}$/.test(String(xpt)) ? Math.min(Number(xpt), 10000000) : 0);
  const sbXp = () => {
    const q = encodeURIComponent;
    return {
      grant: async (uid, key, amount, kind, day, cap) => {
        const r = await fetch(sbUrl + '/rest/v1/rpc/grant_xp', { method: 'POST', headers: svcHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ p_uid: uid, p_key: key, p_amount: amount, p_kind: kind, p_day: day, p_cap: cap || 0 }) });
        if (!r.ok) throw new Error('sb ' + r.status); return r.json();
      },
      totals: async (uids) => {
        const o = {}; if (!uids.length) return o;
        const r = await fetch(sbUrl + '/rest/v1/profiles?id=in.(' + uids.map(q).join(',') + ')&select=id,xp_v,xpt:stats->xp->>t', { headers: svcHeaders() });
        if (!r.ok) throw new Error('sb ' + r.status);
        (await r.json()).forEach((p) => { o[p.id] = shownXp(p.xp_v, p.xpt); }); return o;
      },
    };
  };
  const xpStore = config.xpStore || (sbUrl && sbService ? sbXp() : memXp());
  function grantXp(uid, key, amount, kind, day, cap) {
    return Promise.resolve().then(() => xpStore.grant(uid, key, amount, kind, day, cap)).then((t) => { if (t > 0) boardCache.clear(); return t; }).catch((e) => { console.log('[xp] no se pudo dar: ' + (e && e.message)); return null; });
  }
  const dailyDb = config.dailyDb || (sbUrl && sbService ? sbDailyDb() : memDb());
  function dailyPrune(today) { const lim = D.addDays(today, -2); for (const k of dailyGames.keys()) { if (k.slice(-10) < lim) dailyGames.delete(k); } }
  function dailyUid(ws, jwt) {                                    // cuenta verificada de esta conexión (se recuerda tras la primera vez)
    if (ws.dailyUid && !jwt) return Promise.resolve(ws.dailyUid);
    if (!jwt || typeof jwt !== 'string' || jwt.length > 4000) return Promise.resolve(ws.dailyUid || null);
    return Promise.resolve(verifyToken(jwt)).then((uid) => { if (uid) ws.dailyUid = uid; return uid || ws.dailyUid || null; }).catch(() => null);
  }
  function dailyView(sp, g) {
    const v = { t: 'daily', date: sp.date, n: sp.n, level: sp.level, size: sp.size, setup: sp.setup, status: !g ? 'new' : g.result ? 'done' : 'playing', moves: g ? g.moves : [], result: g && g.result || null };
    if (g && !g.result) v.elapsed = g.startedAt ? Date.now() - g.startedAt : 0;
    return v;
  }
  function dailyFinish(g, win, reason) {
    const st = g.state, now = Date.now();
    g.result = { win: !!win, draw: !win && st.status === 'draw', reason, moves: g.humanMoves, ms: g.startedAt ? now - g.startedAt : 0, captures: st.captures[1] || 0, level: g.sp.level, date: g.sp.date, n: g.sp.n };
    boardCache.clear();
    if (g.humanMoves >= 3) dailyXp(g);
  }
  // XP verificado del desafío: 30 + 30 si ganó + racha (días seguidos jugados) + 25 la primera vez. Una sola vez por día y cuenta.
  async function dailyXp(g) {
    try {
      const days = new Set(await dailyDb.history(g.uid, D.addDays(g.sp.date, -8)).catch(() => [])); days.add(g.sp.date);
      let streak = 0; for (let d = g.sp.date; days.has(d); d = D.addDays(d, -1)) streak++;
      const first = (await dailyDb.history(g.uid, '2000-01-01').catch(() => [g.sp.date])).filter((d) => d !== g.sp.date).length === 0;
      await grantXp(g.uid, 'daily:' + g.sp.date, XP.dailyGain(!!(g.result && g.result.win), streak, first), 'daily', g.sp.date, 0);
    } catch (e) { console.log('[xp] diario: ' + (e && e.message)); }
  }
  // Una jugada de la persona + la respuesta de la máquina. Devuelve { err } o { ai }.
  function dailyStep(g, x, y) {
    const r = P.playMove(g.state, x, y, 1);                           // la persona siempre es el jugador 1 (negras)
    if (!r.ok) return { err: r.error };
    if (!g.startedAt) g.startedAt = Date.now();                       // el tiempo corre desde la primera ficha
    g.state = r.state; g.humanMoves++; g.moves.push([x, y, 1]);
    if (r.state.status !== 'playing') { dailyFinish(g, r.state.status === 'won' && r.state.winner === 1, 'game'); return { ai: null }; }
    let a = null;
    try { a = AI.chooseMove(g.state, { level: g.sp.level, timeMs: 0, rng: D.aiRng(g.sp.date, g.moves.length) }); } catch (e) { a = null; }   // sin límite de tiempo: la máquina juega igual para todos
    if (!a) a = P.legalMoves(g.state)[0];
    const ar = P.playMove(g.state, a.x, a.y, 2);
    if (!ar.ok) { dailyFinish(g, false, 'error'); return { ai: null }; }
    g.state = ar.state; g.moves.push([a.x, a.y, 2]);
    if (ar.state.status !== 'playing') dailyFinish(g, false, 'game');
    return { ai: { x: a.x, y: a.y } };
  }
  function dailyRow(g) {
    const r = g.result;
    return { uid: g.uid, day: g.sp.date, n: g.sp.n, level: g.sp.level, finished: !!r, win: !!(r && r.win), draw: !!(r && r.draw), reason: r ? r.reason : null, moves: g.humanMoves, ms: r ? r.ms : 0, captures: r ? r.captures : 0,
      human: g.moves.filter((m) => m[2] === 1).map((m) => [m[0], m[1]]), started_at: g.startedAt ? new Date(g.startedAt).toISOString() : null, updated_at: new Date().toISOString(), name: g.name };
  }
  function dailyPersist(g) {                                      // en orden y sin frenar la partida; un error de base no corta el juego
    g.saving = (g.saving || Promise.resolve()).then(() => dailyDb.save(dailyRow(g))).catch((e) => { console.log('[daily] no se pudo guardar: ' + (e && e.message)); });
    return g.saving;
  }
  function dailyRestore(sp, uid, row) {                           // la máquina juega igual siempre: con las jugadas de la persona se reconstruye todo
    const g = { sp, uid, state: D.startState(sp), moves: [], humanMoves: 0, startedAt: row.started_at ? Date.parse(row.started_at) : 0, result: null, name: row.name };
    for (const m of Array.isArray(row.human) ? row.human : []) { if (g.result || !Array.isArray(m) || dailyStep(g, m[0], m[1]).err) break; }
    if (row.finished) g.result = { win: !!row.win, draw: !!row.draw, reason: row.reason || 'game', moves: row.moves, ms: row.ms, captures: row.captures || 0, level: sp.level, date: sp.date, n: sp.n };
    return g;
  }
  async function dailyFind(uid, sp) {                             // en memoria, o en la base si el servidor se reinició
    const key = uid + '|' + sp.date; let g = dailyGames.get(key); if (g) return g;
    let row = null; try { row = await dailyDb.load(uid, sp.date); } catch (e) { console.log('[daily] no se pudo leer: ' + (e && e.message)); }
    if (!row) return null;
    g = dailyGames.get(key); if (g) return g;
    g = dailyRestore(sp, uid, row); dailyGames.set(key, g); return g;
  }
  async function onDailyInfo(ws, msg) {
    const sp = D.spec(todayKey()), uid = await dailyUid(ws, msg.jwt);
    if (!uid) return send(ws, Object.assign(dailyView(sp, null), { needAccount: true }));
    const g = await dailyFind(uid, sp), v = dailyView(sp, g); v.played = await playedDays(uid, sp);
    send(ws, v);
  }
  // Días en que esta cuenta jugó (con al menos una ficha), para que la racha sea la misma en todos sus aparatos
  async function playedDays(uid, sp) {
    try { return [...new Set(await dailyDb.history(uid, D.addDays(sp.date, -45)))].sort().slice(-46); } catch (e) { return []; }
  }
  async function onDailyStart(ws, msg) {
    const sp = D.spec(todayKey()), uid = await dailyUid(ws, msg.jwt);
    if (!uid) return send(ws, { t: 'error', code: 'NEED_ACCOUNT' });
    let g = await dailyFind(uid, sp);
    if (!g) {
      if (dailyGames.size > 20000) return send(ws, { t: 'error', code: 'SERVER_BUSY' });
      dailyPrune(sp.date);
      const key = uid + '|' + sp.date;
      g = dailyGames.get(key);                                    // por si otra conexión lo creó mientras esperábamos
      if (!g) { g = { sp, uid, state: D.startState(sp), moves: [], humanMoves: 0, startedAt: 0, result: null, name: cleanName(msg.name, 'Jugador') }; dailyGames.set(key, g); await dailyPersist(g); }   // el intento queda guardado desde ya
    }
    if (msg.name && !g.name) g.name = cleanName(msg.name, 'Jugador');
    ws.dailyG = g; const v = dailyView(sp, g); v.played = await playedDays(uid, sp); send(ws, v);
  }
  function dailyGame(ws) { return ws.dailyG || null; }
  function onDailyMove(ws, msg) {
    const g = dailyGame(ws); if (!g) return send(ws, { t: 'error', code: 'NOT_IN_DAILY' });
    if (g.result) return send(ws, { t: 'error', code: 'GAME_OVER' });
    const x = msg.x, y = msg.y;
    if (!Number.isInteger(x) || !Number.isInteger(y)) return send(ws, { t: 'error', code: 'BAD_REQUEST' });
    const r = dailyStep(g, x, y);
    if (r.err) return send(ws, { t: 'error', code: 'ILLEGAL', detail: r.err, daily: true });
    dailyPersist(g);
    send(ws, { t: 'dailyMove', x, y, ai: r.ai, n: g.humanMoves, result: g.result });
  }
  function onDailyResign(ws) {
    const g = dailyGame(ws); if (!g) return send(ws, { t: 'error', code: 'NOT_IN_DAILY' });
    if (!g.result) { dailyFinish(g, false, 'resign'); dailyPersist(g); }
    send(ws, { t: 'dailyMove', x: -1, y: -1, ai: null, n: g.humanMoves, result: g.result });
  }
  /* Ranking: del día y de la semana (lunes a domingo). Se calcula con las filas terminadas y se guarda unos segundos para no cargar la base. */
  const boardCache = new Map();
  const BOARD_TTL_MS = config.boardTtlMs != null ? config.boardTtlMs : 15000, BOARD_TOP = 50;
  async function buildBoard(today) {
    const hit = boardCache.get(today); if (hit && hit.until > Date.now()) return hit.val;
    const from = D.weekStart(today), days = []; for (let d = from; d <= today; d = D.addDays(d, 1)) days.push(d);
    const rows = await Promise.all(days.map((d) => dailyDb.day(d).catch(() => [])));
    const byDay = {}; days.forEach((d, i) => { byDay[d] = rows[i]; });
    const dayRank = D.rankDay(byDay[today]), weekRank = D.rankWeek(byDay);
    const uids = [...new Set(dayRank.concat(weekRank).map((r) => r.uid))];
    const names = await dailyDb.names(uids).catch(() => ({})), xps = await Promise.resolve(xpStore.totals(uids)).catch(() => ({}));
    const val = { today, from, dayRank, weekRank, names, xps };
    boardCache.set(today, { val, until: Date.now() + BOARD_TTL_MS }); if (boardCache.size > 8) boardCache.clear();
    return val;
  }
  async function onDailyBoard(ws, msg) {
    const uid = await dailyUid(ws, msg.jwt), today = todayKey();
    let b; try { b = await buildBoard(today); } catch (e) { return send(ws, { t: 'error', code: 'SERVER_ERROR' }); }
    const nm = (u) => (b.names[u] && b.names[u].name) || 'Jugador', av = (u) => (b.names[u] && b.names[u].avatar) || '', co = (u) => (b.names[u] && b.names[u].country) || '', xp = (u) => b.xps[u] || 0;
    const dayRow = (r) => ({ rank: r.rank, name: nm(r.uid), avatar: av(r.uid), country: co(r.uid), xp: xp(r.uid), playing: !!r.playing, win: !!r.win, draw: !!r.draw, moves: r.moves, ms: r.ms, me: r.uid === uid });
    const weekRow = (r) => ({ rank: r.rank, name: nm(r.uid), avatar: av(r.uid), country: co(r.uid), xp: xp(r.uid), points: r.points, wins: r.wins, played: r.played, moves: r.moves, ms: r.ms, me: r.uid === uid });
    const cut = (list, f) => { const top = list.slice(0, BOARD_TOP).map(f); const mine = list.findIndex((r) => r.uid === uid); return { rows: top, mine: mine >= BOARD_TOP ? f(list[mine]) : null, total: list.length }; };
    send(ws, { t: 'dailyBoard', date: b.today, weekFrom: b.from, today: cut(b.dayRank, dayRow), week: cut(b.weekRank, weekRow) });
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
        case 'join': lobbyLeave(ws); return joinGuarded(ws, msg);
        case 'hi': return onHi(ws, msg);
        case 'invite': return onInvite(ws, msg);
        case 'inviteNo': return onInviteNo(ws, msg);
        case 'rejoin': lobbyLeave(ws); return onRejoin(ws, msg);
        case 'list': return send(ws, { t: 'rooms', rooms: publicList() });
        case 'spectate': lobbyLeave(ws); return onSpectate(ws, msg);
        case 'chat': return onChat(ws, msg);
        case 'lobby': return onLobby(ws, msg);
        case 'lchat': return onLobbyChat(ws, msg);
        case 'move': return onMove(ws, msg);
        case 'seat': return onSeat(ws, msg);
        case 'bot': return onBot(ws, msg);
        case 'botoff': return onBotOff(ws, msg);
        case 'resign': return onResign(ws);
        case 'rematch': return onRematch(ws);
        case 'claimWin': return onClaimWin(ws);
        case 'resync': { if (!ws.room) return send(ws, { t: 'error', code: 'NOT_IN_ROOM' }); return send(ws, snapshot(ws.room, ws.seat)); }
        case 'dailyInfo': return void onDailyInfo(ws, msg);
        case 'dailyStart': return void onDailyStart(ws, msg);
        case 'dailyMove': return onDailyMove(ws, msg);
        case 'dailyResign': return onDailyResign(ws);
        case 'dailyBoard': return void onDailyBoard(ws, msg);
        case 'ping': return send(ws, { t: 'pong' });
        default: return send(ws, { t: 'error', code: 'BAD_REQUEST' });
      }
    });
    ws.on('close', () => {
      lobbyLeave(ws); presenceDel(ws);
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
