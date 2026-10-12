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
 *   {t:'create', name, opts:{tournamentRule, exactFive, size: 13|19}}   {t:'join', code, name}   {t:'rejoin', code, token}
 *   {t:'move', x, y}  {t:'resign'}  {t:'rematch'}  {t:'claimWin'}  {t:'resync'}  {t:'ping'}
 * Servidor -> cliente:
 *   {t:'joined', code, token, you}   {t:'sync', ...estado completo...}   {t:'move', x, y, n}
 *   {t:'presence', connected}  {t:'over', winner, reason}  {t:'rematch', votes}  {t:'error', code, detail?}  {t:'pong'}
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
const FORFEIT_AFTER_MS = 60 * 1000;           // el rival puede reclamar victoria si estuvo desconectado este tiempo
const ROOM_IDLE_TTL_MS = 2 * 60 * 60 * 1000;  // sala sin actividad: se borra
const HEARTBEAT_MS = 25 * 1000;
const MAX_MSGS_PER_SEC = 12;

function cleanName(s, fallback) {
  s = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, MAX_NAME);
  return s || fallback;
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
  function broadcast(room, obj) { [1, 2].forEach((s) => room.seats[s] && send(room.seats[s].ws, obj)); }
  function touch(room) { room.lastActivity = Date.now(); }

  function freshGame(room) { room.game = P.createGame(room.opts); room.moves = []; room.over = null; room.rematch = { 1: false, 2: false }; }

  function snapshot(room, seat) {
    return {
      t: 'sync', code: room.code, you: seat, opts: room.opts,
      names: { 1: room.seats[1] ? room.seats[1].name : '', 2: room.seats[2] ? room.seats[2].name : '' },
      connected: connectedMap(room), moves: room.moves,
      over: room.over, rematch: room.rematch,
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
    room.over = { winner, reason };
    broadcast(room, { t: 'over', winner, reason });
  }

  /* ---------- Mensajes ---------- */
  function onCreate(ws, msg) {
    if (rooms.size >= MAX_ROOMS) return send(ws, { t: 'error', code: 'SERVER_BUSY' });
    const code = newCode(rooms); if (!code) return send(ws, { t: 'error', code: 'SERVER_BUSY' });
    const o = msg.opts || {};
    const opts = { tournamentRule: o.tournamentRule !== false, exactFive: !!o.exactFive, size: o.size === 13 ? 13 : 19 };   // solo 13 o 19: nada más pasa
    const room = { code, opts, seats: { 1: null, 2: null }, game: null, moves: [], over: null, rematch: { 1: false, 2: false }, lastActivity: Date.now() };
    freshGame(room);
    const token = newToken();
    room.seats[1] = { name: cleanName(msg.name, 'Jugador 1'), token, ws: null, leftAt: 0 };
    rooms.set(code, room);
    attach(ws, room, 1);
    send(ws, { t: 'joined', code, token, you: 1 });
    send(ws, snapshot(room, 1));
  }

  function onJoin(ws, msg) {
    const room = rooms.get(String(msg.code || '').toUpperCase().trim());
    if (!room) return send(ws, { t: 'error', code: 'ROOM_NOT_FOUND' });
    if (room.seats[2]) return send(ws, { t: 'error', code: 'ROOM_FULL' });
    const token = newToken();
    room.seats[2] = { name: cleanName(msg.name, 'Jugador 2'), token, ws: null, leftAt: 0 };
    attach(ws, room, 2); touch(room);
    send(ws, { t: 'joined', code: room.code, token, you: 2 });
    // el creador recibe la foto completa (ahora hay rival); el que entra también
    send(ws, snapshot(room, 2));
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
    send(ws, snapshot(room, seat));
    const other = room.seats[seat === 1 ? 2 : 1];
    if (other) send(other.ws, { t: 'presence', connected: connectedMap(room) });
  }

  function attach(ws, room, seat) { ws.room = room; ws.seat = seat; room.seats[seat].ws = ws; room.seats[seat].leftAt = 0; }

  function inRoom(ws) { if (!ws.room || !ws.seat) { send(ws, { t: 'error', code: 'NOT_IN_ROOM' }); return null; } return ws.room; }

  function onMove(ws, msg) {
    const room = inRoom(ws); if (!room) return;
    if (!room.seats[2]) return send(ws, { t: 'error', code: 'WAITING_FOR_RIVAL' });
    if (gameOverNow(room)) return send(ws, { t: 'error', code: P.ERR.GAME_OVER });
    const r = P.playMove(room.game, msg.x, msg.y, ws.seat);   // el núcleo valida turno, límites, ocupación y reglas
    if (!r.ok) return send(ws, { t: 'error', code: 'ILLEGAL', detail: r.error });
    room.game = r.state; room.moves.push([msg.x, msg.y]); touch(room);
    broadcast(room, { t: 'move', x: msg.x, y: msg.y, n: room.moves.length });
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
      freshGame(room);
      [1, 2].forEach((s) => send(room.seats[s].ws, snapshot(room, s)));
    } else broadcast(room, { t: 'rematch', votes: room.rematch });
  }

  /* ---------- Conexiones ---------- */
  wss.on('connection', (ws) => {
    ws.isAlive = true; ws.room = null; ws.seat = 0; ws.bucket = { n: 0, t: Date.now() };
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (data) => {
      ws.isAlive = true;
      const now = Date.now();
      if (now - ws.bucket.t > 1000) ws.bucket = { n: 0, t: now };
      if (++ws.bucket.n > MAX_MSGS_PER_SEC) return send(ws, { t: 'error', code: 'RATE_LIMIT' });
      let msg; try { msg = JSON.parse(String(data)); } catch (e) { return send(ws, { t: 'error', code: 'BAD_REQUEST' }); }
      if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return send(ws, { t: 'error', code: 'BAD_REQUEST' });
      switch (msg.t) {
        case 'create': return onCreate(ws, msg);
        case 'join': return onJoin(ws, msg);
        case 'rejoin': return onRejoin(ws, msg);
        case 'move': return onMove(ws, msg);
        case 'resign': return onResign(ws);
        case 'rematch': return onRematch(ws);
        case 'claimWin': return onClaimWin(ws);
        case 'resync': { const r = inRoom(ws); return r && send(ws, snapshot(r, ws.seat)); }
        case 'ping': return send(ws, { t: 'pong' });
        default: return send(ws, { t: 'error', code: 'BAD_REQUEST' });
      }
    });
    ws.on('close', () => {
      const room = ws.room; if (!room) return;
      const p = room.seats[ws.seat];
      if (p && p.ws === ws) {                         // si ya lo reemplazó otra conexión, no se marca como ido
        p.ws = null; p.leftAt = Date.now();
        const other = room.seats[ws.seat === 1 ? 2 : 1];
        if (other) send(other.ws, { t: 'presence', connected: connectedMap(room) });
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
