/*
 * Servidor de salas de Pente.
 *
 * El servidor es el ÁRBITRO: guarda la partida y valida cada jugada con el mismo núcleo de reglas
 * (pente-core.js, copia de src/core/pente.js) que usa el cliente. El cliente nunca decide nada.
 *
 * Alcance de esta versión: salas por código/enlace, 2 jugadores, reconexión, abandono, reclamar victoria
 * si el rival se desconecta, revancha. NO hay cuentas, ni base de datos, ni ranking: todo vive en memoria
 * y se pierde si el servidor se reinicia (esperable en el plan gratuito de Render).
 *
 * Protocolo (JSON). Cliente -> servidor:
 *   {t:'create', name, opts:{tournamentRule, exactFive, size: 13|19, public: bool}}   {t:'join', code, name}   {t:'rejoin', code, token}
 *   {t:'list'}   {t:'spectate', code}      (solo las salas PÚBLICAS se listan y se pueden mirar)
 *   {t:'lobby', on, name}  (entrar/salir del chat del lobby)   {t:'lchat', text, name}  (máx. 160 caracteres, 1 cada 1,2 s, sin links)
 *   {t:'chat', text}   (jugadores y espectadores; máx. 200 caracteres, 1 mensaje cada 0,7 s)
 *   {t:'move', x, y}  {t:'resign'}  {t:'rematch'}  {t:'claimWin'}  {t:'resync'}  {t:'ping'}
 * Servidor -> cliente:
 *   {t:'joined', code, token, you}   (espectador: {t:'joined', code, you:0, spectator:true}, sin token)
 *   {t:'sync', ...estado completo...}   {t:'move', x, y, n}   {t:'rooms', rooms:[...]}   {t:'spectators', n}
 *   {t:'presence', connected}  {t:'over', winner, reason}  {t:'rematch', votes}  {t:'error', code, detail?}  {t:'pong'}
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

  const httpServer = http.createServer((req, res) => {
    // /health sirve para "despertar" al servidor cuando el plan gratuito lo durmió, y para monitoreo.
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.url === '/health' || req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    } else { res.writeHead(404); res.end(); }
  });

  const wss = new WebSocketServer({
    server: httpServer, maxPayload: 2048,
    verifyClient: (info) => !allowedOrigins.length || !info.origin || allowedOrigins.includes(info.origin)
  });

  /* ---------- Helpers de sala ---------- */
  function send(ws, obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
  function seatOf(room, token) { return [1, 2].find((s) => room.seats[s] && room.seats[s].token === token) || 0; }
  function connectedMap(room) { return { 1: !!(room.seats[1] && room.seats[1].ws), 2: !!(room.seats[2] && room.seats[2].ws) }; }
  function toSpectators(room, obj) { room.spectators.forEach((w) => send(w, obj)); }
  function broadcast(room, obj) { [1, 2].forEach((s) => room.seats[s] && send(room.seats[s].ws, obj)); toSpectators(room, obj); }
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
    finish(room, c.current === 1 ? 2 : 1, 'timeout');
  }
  function clockInfo(room) {            // valores "en vivo" al momento de enviar (los clientes cuentan desde ahí, sin depender de relojes ajenos)
    const c = room.clock; if (!c) return { on: false };
    const over = gameOverNow(room), used = over ? 0 : Date.now() - c.since;
    const rem = { 1: c.rem[1], 2: c.rem[2] }; if (!over) rem[c.current] = Math.max(0, rem[c.current] - used);
    return { on: true, total: totalMs, turnMs, rem, current: over ? 0 : c.current, turnLeft: over ? turnMs : Math.max(0, turnMs - used) };
  }

  function freshGame(room) { room.game = P.createGame(room.opts); room.moves = []; room.over = null; room.rematch = { 1: false, 2: false }; clockStop(room); room.clock = null; }

  function snapshot(room, seat) {
    return {
      t: 'sync', code: room.code, you: seat, opts: room.opts, public: room.public, spectators: room.spectators.size,
      names: { 1: room.seats[1] ? room.seats[1].name : '', 2: room.seats[2] ? room.seats[2].name : '' },
      connected: connectedMap(room), moves: room.moves,
      over: room.over, rematch: room.rematch, clock: clockInfo(room),
      disconnectedFor: disconnectedFor(room)
    };
  }
  function disconnectedFor(room) {
    const out = { 1: 0, 2: 0 };
    [1, 2].forEach((s) => { const p = room.seats[s]; if (p && !p.ws && p.leftAt) out[s] = Date.now() - p.leftAt; });
    return out;
  }
  function gameOverNow(room) { return !!room.over || room.game.status !== 'playing'; }

  function finish(room, winner, reason) {
    room.over = { winner, reason }; clockStop(room);
    broadcast(room, { t: 'over', winner, reason, clock: clockInfo(room) });
  }

  /* ---------- Mensajes ---------- */
  function onCreate(ws, msg) {
    if (ws.room) return send(ws, { t: 'error', code: 'ALREADY_IN_ROOM' });
    if (rooms.size >= MAX_ROOMS) return send(ws, { t: 'error', code: 'SERVER_BUSY' });
    const code = newCode(rooms); if (!code) return send(ws, { t: 'error', code: 'SERVER_BUSY' });
    const o = msg.opts || {};
    const opts = { tournamentRule: o.tournamentRule !== false, exactFive: !!o.exactFive, size: o.size === 13 ? 13 : 19, timer: o.timer !== false };   // solo 13 o 19: nada más pasa
    const room = { code, opts, public: o.public === true, spectators: new Set(), seats: { 1: null, 2: null }, game: null, moves: [], over: null, rematch: { 1: false, 2: false }, lastActivity: Date.now(), chat: [], chatSeq: 0, specSeq: 0 };
    freshGame(room);
    const token = newToken();
    room.seats[1] = { name: cleanName(msg.name, 'Jugador 1'), token, ws: null, leftAt: 0 };
    rooms.set(code, room);
    attach(ws, room, 1);
    send(ws, { t: 'joined', code, token, you: 1 });
    send(ws, snapshot(room, 1));
  }

  function onJoin(ws, msg) {
    if (ws.room) return send(ws, { t: 'error', code: 'ALREADY_IN_ROOM' });
    const room = rooms.get(String(msg.code || '').toUpperCase().trim());
    if (!room) return send(ws, { t: 'error', code: 'ROOM_NOT_FOUND' });
    if (room.seats[2]) return send(ws, { t: 'error', code: 'ROOM_FULL' });
    const token = newToken();
    room.seats[2] = { name: cleanName(msg.name, 'Jugador 2'), token, ws: null, leftAt: 0 };
    attach(ws, room, 2); touch(room);
    clockStart(room);                                  // ya hay dos jugadores: corre el reloj del primero
    send(ws, { t: 'joined', code: room.code, token, you: 2 });
    // el creador recibe la foto completa (ahora hay rival); el que entra también
    send(ws, snapshot(room, 2)); sendChatLog(ws, room);
    send(room.seats[1].ws, snapshot(room, 1));
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
    const other = room.seats[seat === 1 ? 2 : 1];
    if (other) send(other.ws, { t: 'presence', connected: connectedMap(room) });
    toSpectators(room, { t: 'presence', connected: connectedMap(room) });
  }

  function attach(ws, room, seat) { ws.room = room; ws.seat = seat; room.seats[seat].ws = ws; room.seats[seat].leftAt = 0; }

  function inRoom(ws) {
    if (ws.spectator) { send(ws, { t: 'error', code: 'NOT_A_PLAYER' }); return null; }
    if (!ws.room || !ws.seat) { send(ws, { t: 'error', code: 'NOT_IN_ROOM' }); return null; }
    return ws.room;
  }

  function onMove(ws, msg) {
    const room = inRoom(ws); if (!room) return;
    if (!room.seats[2]) return send(ws, { t: 'error', code: 'WAITING_FOR_RIVAL' });
    if (gameOverNow(room)) return send(ws, { t: 'error', code: P.ERR.GAME_OVER });
    const r = P.playMove(room.game, msg.x, msg.y, ws.seat);   // el núcleo valida turno, límites, ocupación y reglas
    if (!r.ok) return send(ws, { t: 'error', code: 'ILLEGAL', detail: r.error });
    const c = room.clock;
    if (c && ws.seat === c.current) {                          // ¿llegó a tiempo? (si el temporizador todavía no saltó, se decide acá)
      const used = Date.now() - c.since;
      if (used > clockLimit(room) + 150) { c.rem[c.current] = Math.max(0, c.rem[c.current] - used); return finish(room, ws.seat === 1 ? 2 : 1, 'timeout'); }
      c.rem[c.current] = Math.max(0, c.rem[c.current] - used);
    }
    room.game = r.state; room.moves.push([msg.x, msg.y]); touch(room);
    if (c) { c.current = room.game.current; c.since = Date.now(); }
    if (room.game.status === 'playing') clockArm(room);
    broadcast(room, { t: 'move', x: msg.x, y: msg.y, n: room.moves.length, clock: clockInfo(room) });
    if (room.game.status !== 'playing') finish(room, room.game.winner, room.game.status === 'draw' ? 'draw' : 'game');
  }

  function onResign(ws) {
    const room = inRoom(ws); if (!room || gameOverNow(room) || !room.seats[2]) return;
    finish(room, ws.seat === 1 ? 2 : 1, 'resign'); touch(room);
  }

  function onClaimWin(ws) {
    const room = inRoom(ws); if (!room || gameOverNow(room)) return;
    const rival = ws.seat === 1 ? 2 : 1, p = room.seats[rival];
    if (!p || p.ws || !p.leftAt || Date.now() - p.leftAt < forfeitAfterMs) return send(ws, { t: 'error', code: 'CANNOT_CLAIM' });
    finish(room, ws.seat, 'forfeit'); touch(room);
  }

  function onRematch(ws) {
    const room = inRoom(ws); if (!room) return;
    if (!gameOverNow(room)) return send(ws, { t: 'error', code: 'GAME_NOT_OVER' });
    room.rematch[ws.seat] = true; touch(room);
    if (room.rematch[1] && room.rematch[2]) {
      // se intercambian los lados: quien jugó de J1 pasa a J2
      const a = room.seats[1], b = room.seats[2];
      room.seats[1] = b; room.seats[2] = a;
      if (a.ws) a.ws.seat = 2; if (b.ws) b.ws.seat = 1;
      freshGame(room); clockStart(room);
      [1, 2].forEach((s) => send(room.seats[s].ws, snapshot(room, s)));
      toSpectators(room, snapshot(room, 0));
    } else broadcast(room, { t: 'rematch', votes: room.rematch });
  }

  /* ---------- Salas públicas y espectadores ---------- */
  function publicList() {
    const out = [];
    rooms.forEach((room) => {
      if (!room.public) return;
      const c = connectedMap(room);
      if (!c[1] && !c[2]) return;                                   // sala fantasma: nadie conectado
      out.push({
        code: room.code, size: room.opts.size, tournamentRule: room.opts.tournamentRule, exactFive: room.opts.exactFive,
        names: [room.seats[1] ? room.seats[1].name : '', room.seats[2] ? room.seats[2].name : ''],
        status: !room.seats[2] ? 'waiting' : gameOverNow(room) ? 'over' : 'playing',
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
    if (!room.seats[2]) return send(ws, { t: 'error', code: 'NOT_STARTED' });             // no hay nada que mirar todavía
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
        const other = room.seats[ws.seat === 1 ? 2 : 1];
        if (other) send(other.ws, { t: 'presence', connected: connectedMap(room) });
        toSpectators(room, { t: 'presence', connected: connectedMap(room) });
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
  const srv = createPenteServer({ allowedOrigins });
  srv.listen(port).then((p) => console.log('Pente server escuchando en puerto ' + p + (allowedOrigins.filter(Boolean).length ? ' | orígenes permitidos: ' + allowedOrigins.join(', ') : ' | cualquier origen')));
}
