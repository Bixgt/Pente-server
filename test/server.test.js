const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { createPenteServer } = require('../index.js');
const P = require('../pente-core.js');

/* Cliente de prueba: junta todos los mensajes y permite esperar uno por tipo. */
function client(url) {
  const ws = new WebSocket(url); const inbox = []; const waiters = [];
  ws.on('message', (d) => { const m = JSON.parse(String(d)); inbox.push(m); waiters.slice().forEach((w) => w()); });
  const api = {
    ws, inbox,
    open: () => new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); }),
    send: (o) => ws.send(JSON.stringify(o)),
    raw: (s) => ws.send(s),
    next: (pred, ms = 2000) => new Promise((res, rej) => {
      const find = () => { const i = inbox.findIndex(pred); if (i >= 0) { const [m] = inbox.splice(i, 1); return m; } };
      const hit = find(); if (hit) return res(hit);
      const t = setTimeout(() => rej(new Error('timeout esperando mensaje; inbox=' + JSON.stringify(inbox))), ms);
      const w = () => { const m = find(); if (m) { clearTimeout(t); waiters.splice(waiters.indexOf(w), 1); res(m); } };
      waiters.push(w);
    }),
    type: (t, ms) => api.next((m) => m.t === t, ms),
    close: () => new Promise((res) => { if (ws.readyState === 3) return res(); ws.once('close', res); ws.close(); })
  };
  return api;
}

async function setup(cfg) {
  const srv = createPenteServer(cfg || {});
  const port = await srv.listen(0);
  const url = 'ws://127.0.0.1:' + port;
  const clients = [];
  const mk = async () => { const c = client(url); await c.open(); clients.push(c); return c; };
  const teardown = async () => { clients.forEach((c) => c.ws.terminate()); await srv.close(); };
  return { srv, port, url, mk, teardown };
}

// Crea sala con A y une a B. Devuelve ambos y sus datos.
async function pair(env, opts) {
  const a = await env.mk(), b = await env.mk();
  a.send({ t: 'create', name: 'Ana', opts: Object.assign({ tournamentRule: false }, opts) });
  const ja = await a.type('joined'); await a.type('sync');
  b.send({ t: 'join', code: ja.code, name: 'Beto' });
  const jb = await b.type('joined'); await b.type('sync'); await a.type('sync');
  return { a, b, ja, jb, code: ja.code };
}

test('/health responde ok (sirve para despertar el servidor)', async () => {
  const env = await setup();
  const r = await fetch('http://127.0.0.1:' + env.port + '/health');
  assert.equal(r.status, 200); assert.equal((await r.json()).ok, true);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  await env.teardown();
});

test('crear sala: código de 5 caracteres sin letras ambiguas, creador es J1', async () => {
  const env = await setup();
  const a = await env.mk();
  a.send({ t: 'create', name: 'Ana', opts: { tournamentRule: true, exactFive: true } });
  const j = await a.type('joined');
  assert.match(j.code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/);
  assert.equal(j.you, 1); assert.ok(j.token.length >= 32);
  const s = await a.type('sync');
  assert.deepEqual(s.opts, { tournamentRule: true, exactFive: true, size: 19 });
  assert.equal(s.names[1], 'Ana'); assert.equal(s.names[2], ''); assert.deepEqual(s.moves, []);
  await env.teardown();
});

test('unirse: el segundo es J2 y ambos reciben el estado con los dos nombres', async () => {
  const env = await setup();
  const { a, b, ja, jb } = await pair(env);
  assert.equal(jb.you, 2); assert.notEqual(ja.token, jb.token);
  await env.teardown();
});

test('sala inexistente, sala llena y código en minúsculas', async () => {
  const env = await setup();
  const { code } = await pair(env);
  const c = await env.mk();
  c.send({ t: 'join', code: 'ZZZZZ', name: 'X' });
  assert.equal((await c.type('error')).code, 'ROOM_NOT_FOUND');
  c.send({ t: 'join', code, name: 'X' });
  assert.equal((await c.type('error')).code, 'ROOM_FULL');
  await env.teardown();
  const env2 = await setup();
  const a = await env2.mk(); a.send({ t: 'create', name: 'A' }); const j = await a.type('joined'); await a.type('sync');
  const b = await env2.mk(); b.send({ t: 'join', code: j.code.toLowerCase(), name: 'B' });
  assert.equal((await b.type('joined')).you, 2);
  await env2.teardown();
});

test('jugadas: se retransmiten a ambos con número de orden; fuera de turno se rechaza', async () => {
  const env = await setup();
  const { a, b } = await pair(env);
  b.send({ t: 'move', x: 5, y: 5 });                       // B es J2, no le toca
  const e = await b.type('error'); assert.equal(e.code, 'ILLEGAL'); assert.equal(e.detail, 'NOT_YOUR_TURN');
  a.send({ t: 'move', x: 9, y: 9 });
  const ma = await a.type('move'), mb = await b.type('move');
  assert.deepEqual([ma.x, ma.y, ma.n], [9, 9, 1]); assert.deepEqual([mb.x, mb.y, mb.n], [9, 9, 1]);
  b.send({ t: 'move', x: 9, y: 9 });                       // ocupada
  assert.equal((await b.type('error')).detail, 'OCCUPIED');
  b.send({ t: 'move', x: 99, y: 0 });
  assert.equal((await b.type('error')).detail, 'OUT_OF_BOUNDS');
  b.send({ t: 'move', x: 'a', y: 0 });
  assert.equal((await b.type('error')).detail, 'INVALID_COORDS');
  await env.teardown();
});

test('regla de torneo la aplica el servidor (1ª al centro)', async () => {
  const env = await setup();
  const { a } = await pair(env, { tournamentRule: true });
  a.send({ t: 'move', x: 0, y: 0 });
  assert.equal((await a.type('error')).detail, 'MUST_PLAY_CENTER');
  await env.teardown();
});

test('no se puede jugar antes de que entre el rival', async () => {
  const env = await setup();
  const a = await env.mk(); a.send({ t: 'create', name: 'Ana', opts: { tournamentRule: false } }); await a.type('joined'); await a.type('sync');
  a.send({ t: 'move', x: 3, y: 3 });
  assert.equal((await a.type('error')).code, 'WAITING_FOR_RIVAL');
  await env.teardown();
});

test('partida completa: victoria por 5 en línea, luego no se puede seguir jugando', async () => {
  const env = await setup();
  const { a, b } = await pair(env);
  const seq = [[9,9,a],[0,0,b],[10,9,a],[0,2,b],[11,9,a],[0,4,b],[12,9,a],[0,6,b],[13,9,a]];
  for (const [x, y, who] of seq) { who.send({ t: 'move', x, y }); await a.type('move'); await b.type('move'); }
  const oa = await a.type('over'), ob = await b.type('over');
  assert.equal(oa.winner, 1); assert.equal(oa.reason, 'game'); assert.equal(ob.winner, 1);
  b.send({ t: 'move', x: 5, y: 5 });
  assert.equal((await b.type('error')).code, P.ERR.GAME_OVER);
  await env.teardown();
});

test('captura: el servidor y un cliente que repite las jugadas llegan al mismo estado', async () => {
  const env = await setup();
  const { a, b } = await pair(env);
  // J1(K10) J2(L10) J2... armamos un par de J2 flanqueado: J1 en (5,5); J2 en (6,5),(7,5); J1 cierra en (8,5)
  const seq = [[5,5,a],[6,5,b],[0,0,a],[7,5,b],[8,5,a]];
  for (const [x, y, who] of seq) { who.send({ t: 'move', x, y }); await a.type('move'); await b.type('move'); }
  a.send({ t: 'resync' }); const s = await a.type('sync');
  let g = P.createGame({ tournamentRule: false });
  for (const [x, y] of s.moves) g = P.playMove(g, x, y).state;
  assert.equal(g.captures[1], 1); assert.equal(P.get(g, 6, 5), 0); assert.equal(P.get(g, 7, 5), 0);
  await env.teardown();
});

test('exactFive se respeta en el servidor (seis en línea no gana)', async () => {
  const env = await setup();
  const { a, b } = await pair(env, { exactFive: true });
  const seq = [[2,5,a],[0,0,b],[3,5,a],[0,2,b],[4,5,a],[0,4,b],[6,5,a],[0,6,b],[7,5,a],[0,8,b],[5,5,a]];
  for (const [x, y, who] of seq) { who.send({ t: 'move', x, y }); await a.type('move'); await b.type('move'); }
  assert.equal(a.inbox.filter((m) => m.t === 'over').length, 0);
  await env.teardown();
});

test('abandonar: gana el rival y se puede pedir revancha con los lados cambiados', async () => {
  const env = await setup();
  const { a, b } = await pair(env);
  a.send({ t: 'move', x: 9, y: 9 }); await a.type('move'); await b.type('move');
  a.send({ t: 'resign' });
  const o = await b.type('over'); assert.deepEqual([o.winner, o.reason], [2, 'resign']); await a.type('over');
  b.send({ t: 'move', x: 3, y: 3 }); assert.equal((await b.type('error')).code, P.ERR.GAME_OVER);
  a.send({ t: 'rematch' });
  const v = await b.type('rematch'); assert.deepEqual(v.votes, { 1: true, 2: false });
  b.send({ t: 'rematch' });
  const sa = await a.type('sync'), sb = await b.type('sync');
  assert.equal(sa.you, 2); assert.equal(sb.you, 1);            // lados intercambiados
  assert.equal(sa.names[1], 'Beto'); assert.deepEqual(sa.moves, []); assert.equal(sa.over, null);
  b.send({ t: 'move', x: 9, y: 9 });                            // ahora B es J1 y mueve primero
  assert.equal((await b.type('move')).n, 1);
  await env.teardown();
});

test('revancha antes de terminar la partida se rechaza', async () => {
  const env = await setup();
  const { a } = await pair(env);
  a.send({ t: 'rematch' });
  assert.equal((await a.type('error')).code, 'GAME_NOT_OVER');
  await env.teardown();
});

test('reconexión: el rival ve la desconexión, y al volver con el token recupera la partida', async () => {
  const env = await setup();
  const { a, b, ja, code } = await pair(env);
  a.send({ t: 'move', x: 9, y: 9 }); await a.type('move'); await b.type('move');
  await a.close();
  const p = await b.type('presence'); assert.deepEqual(p.connected, { 1: false, 2: true });
  const a2 = await env.mk();
  a2.send({ t: 'rejoin', code, token: ja.token });
  const j = await a2.type('joined'); assert.equal(j.you, 1);
  const s = await a2.type('sync'); assert.deepEqual(s.moves, [[9, 9]]); assert.deepEqual(s.connected, { 1: true, 2: true });
  const p2 = await b.type('presence'); assert.deepEqual(p2.connected, { 1: true, 2: true });
  b.send({ t: 'move', x: 3, y: 3 });
  assert.equal((await a2.type('move')).n, 2);
  await env.teardown();
});

test('rejoin con token falso o sala inexistente falla', async () => {
  const env = await setup();
  const { code } = await pair(env);
  const c = await env.mk();
  c.send({ t: 'rejoin', code, token: 'falso' }); assert.equal((await c.type('error')).code, 'BAD_TOKEN');
  c.send({ t: 'rejoin', code: 'QQQQQ', token: 'x' }); assert.equal((await c.type('error')).code, 'ROOM_NOT_FOUND');
  await env.teardown();
});

test('misma cuenta abierta en otra pestaña: la nueva reemplaza a la vieja', async () => {
  const env = await setup();
  const { a, ja, code, b } = await pair(env);
  const a2 = await env.mk();
  a2.send({ t: 'rejoin', code, token: ja.token }); await a2.type('joined'); await a2.type('sync');
  await new Promise((r) => a.ws.once('close', r));
  b.send({ t: 'move', x: 1, y: 1 });                         // no le toca; solo comprobamos que el servidor sigue sano
  assert.equal((await b.type('error')).detail, 'NOT_YOUR_TURN');
  a2.send({ t: 'move', x: 9, y: 9 }); assert.equal((await a2.type('move')).n, 1);
  await env.teardown();
});

test('reclamar victoria: solo si el rival estuvo desconectado el tiempo configurado', async () => {
  const env = await setup({ forfeitAfterMs: 300 });
  const { a, b } = await pair(env);
  await b.close(); await a.type('presence');
  a.send({ t: 'claimWin' });
  assert.equal((await a.type('error')).code, 'CANNOT_CLAIM');   // demasiado pronto
  await new Promise((r) => setTimeout(r, 350));
  a.send({ t: 'claimWin' });
  const o = await a.type('over'); assert.deepEqual([o.winner, o.reason], [1, 'forfeit']);
  await env.teardown();
});

test('reclamar victoria con el rival conectado se rechaza', async () => {
  const env = await setup({ forfeitAfterMs: 0 });
  const { a } = await pair(env);
  a.send({ t: 'claimWin' });
  assert.equal((await a.type('error')).code, 'CANNOT_CLAIM');
  await env.teardown();
});

test('mensajes basura no tumban al servidor', async () => {
  const env = await setup();
  const a = await env.mk();
  a.raw('esto no es json'); assert.equal((await a.type('error')).code, 'BAD_REQUEST');
  a.raw('123'); assert.equal((await a.type('error')).code, 'BAD_REQUEST');
  a.raw('null'); assert.equal((await a.type('error')).code, 'BAD_REQUEST');
  a.send({ t: 'inventado' }); assert.equal((await a.type('error')).code, 'BAD_REQUEST');
  a.send({ t: 'move', x: 1, y: 1 }); assert.equal((await a.type('error')).code, 'NOT_IN_ROOM');
  a.send({ t: 'ping' }); await a.type('pong');
  await env.teardown();
});

test('nombres: se limpian y se acotan; vacío usa el nombre por defecto', async () => {
  const env = await setup();
  const a = await env.mk();
  a.send({ t: 'create', name: '  <b>Una persona con un nombre larguísimo</b>  ' }); await a.type('joined');
  const s = await a.type('sync'); assert.ok(s.names[1].length <= 18); assert.ok(!/[<>]/.test(s.names[1]));
  const b = await env.mk(); b.send({ t: 'create', name: '   ' }); await b.type('joined');
  assert.equal((await b.type('sync')).names[1], 'Jugador 1');
  await env.teardown();
});

test('mensaje demasiado grande se descarta cortando la conexión', async () => {
  const env = await setup();
  const a = await env.mk();
  const closed = new Promise((r) => a.ws.once('close', r));
  a.raw(JSON.stringify({ t: 'create', name: 'x'.repeat(5000) }));
  await closed;
  await env.teardown();
});

test('límite de mensajes por segundo', async () => {
  const env = await setup();
  const a = await env.mk();
  for (let i = 0; i < 40; i++) a.send({ t: 'ping' });
  const err = await a.type('error'); assert.equal(err.code, 'RATE_LIMIT');
  await env.teardown();
});

test('origen no permitido es rechazado cuando hay lista de orígenes', async () => {
  const env = await setup({ allowedOrigins: ['https://bixgt.github.io'] });
  const bad = new WebSocket(env.url, { headers: { Origin: 'https://sitio-malo.com' } });
  await assert.rejects(new Promise((res, rej) => { bad.once('open', res); bad.once('error', rej); }));
  const ok = new WebSocket(env.url, { headers: { Origin: 'https://bixgt.github.io' } });
  await new Promise((res, rej) => { ok.once('open', res); ok.once('error', rej); });
  ok.terminate();
  await env.teardown();
});

test('dos salas distintas no se mezclan', async () => {
  const env = await setup();
  const p1 = await pair(env), p2 = await pair(env);
  assert.notEqual(p1.code, p2.code);
  p1.a.send({ t: 'move', x: 9, y: 9 }); await p1.a.type('move'); await p1.b.type('move');
  assert.equal(p2.a.inbox.filter((m) => m.t === 'move').length, 0);
  assert.equal(p2.b.inbox.filter((m) => m.t === 'move').length, 0);
  await env.teardown();
});

test('tablero 13x13: la sala lo respeta (centro G7, fuera de 13 se rechaza) y la revancha lo conserva', async () => {
  const env = await setup();
  const { a, b } = await pair(env, { size: 13, tournamentRule: true });
  a.send({ t: 'move', x: 9, y: 9 });                        // en 13x13 el centro es 6,6
  const e = await a.type('error'); assert.equal(e.detail, 'MUST_PLAY_CENTER');
  a.send({ t: 'move', x: 6, y: 6 }); await a.type('move'); await b.type('move');
  b.send({ t: 'move', x: 13, y: 0 });                       // fuera del tablero de 13
  assert.equal((await b.type('error')).detail, 'OUT_OF_BOUNDS');
  a.send({ t: 'resign' }); await a.type('over'); await b.type('over');
  a.send({ t: 'rematch' }); b.send({ t: 'rematch' });
  const s = await a.type('sync'); assert.equal(s.opts.size, 13);
  await env.teardown();
});

test('tamaño de tablero inválido: se usa 19 (nadie puede pedir un tablero raro)', async () => {
  const env = await setup();
  for (const bad of [5, 1000, '13', -1, null, {}]) {
    const a = await env.mk(); a.send({ t: 'create', name: 'X', opts: { size: bad } });
    await a.type('joined'); assert.equal((await a.type('sync')).opts.size, 19);
  }
  await env.teardown();
});
