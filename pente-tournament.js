/* PENTE · motor de torneos (lógica pura, sin pantalla ni red).
 *
 * Estructura:  TORNEO → RONDA → DUELO → PARTIDAS.   Un "duelo" es un enfrentamiento entre dos personas (mejor de 1/3/5/7 partidas).
 * El motor NO juega Pente: solo arma cruces, recibe quién ganó cada partida y calcula quién sigue / la tabla.
 * Las partidas reales se juegan con el mismo sistema online de siempre.
 *
 * Formatos:
 *   elim       eliminación directa (el que pierde un duelo, se va). Garantiza 1 duelo por jugador.
 *   rr         todos contra todos. Garantiza n-1 duelos.
 *   swiss      sistema suizo: R rondas, cada ronda enfrenta gente con rendimiento parecido y nadie repite rival.
 *   swiss_cut  suizo + los mejores 2/4/8/16 juegan una eliminatoria final.
 *   rr_cut     todos contra todos + los mejores 2/4/8/16 juegan una eliminatoria final.
 *
 * "Mínimo de duelos": se garantiza por construcción (suizo/todos contra todos) y se comprueba ANTES de empezar.
 * Un descanso ("bye", cuando la cantidad es impar) NO cuenta como duelo: por eso con cantidad impar el suizo juega una ronda extra.
 *
 * El estado es un objeto JSON común (se puede guardar y mandar por red). Todas las funciones devuelven estados nuevos.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PenteTournament = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var FORMATS = ['elim', 'rr', 'swiss', 'swiss_cut', 'rr_cut'];
  var BEST_OF = [1, 3, 5, 7];
  var MAX_PLAYERS = 64, NAME_MAX = 20, BYE = '__bye';
  var FORMAT_NAME = { elim: 'Eliminación directa', rr: 'Todos contra todos', swiss: 'Suizo', swiss_cut: 'Suizo + eliminatoria final', rr_cut: 'Todos contra todos + eliminatoria final' };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function isPow2(x) { return x >= 1 && (x & (x - 1)) === 0; }
  function ceilLog2(x) { var k = 0; while ((1 << k) < x) k++; return k; }
  function floorPow2(x) { var p = 1; while (p * 2 <= x) p *= 2; return p; }
  function evenUp(n) { return n % 2 ? n + 1 : n; }
  function cleanName(s, max) { return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max || NAME_MAX); }

  /* ---------- jugadores ---------- */
  function normPlayers(list) {
    var out = [], names = {}, ids = {}, err = '';
    (Array.isArray(list) ? list : []).forEach(function (p, i) {
      var o = typeof p === 'string' ? { name: p } : (p || {});
      var name = cleanName(o.name), id = String(o.id != null ? o.id : 'p' + (i + 1));
      if (!name) { err = err || 'Hay un jugador sin nombre.'; return; }
      if (names[name.toLowerCase()]) { err = err || 'El nombre "' + name + '" está repetido.'; return; }
      if (ids[id] || id === BYE) { err = err || 'Hay ids repetidos.'; return; }
      names[name.toLowerCase()] = 1; ids[id] = 1; out.push({ id: id, name: name, seed: out.length + 1 });
    });
    return { players: out, error: err };
  }

  /* ---------- configuración ---------- */
  function normCfg(cfg) {
    cfg = cfg || {};
    var pts = cfg.points || {};
    return {
      name: cleanName(cfg.name, 40) || 'Torneo de Pente',
      format: cfg.format, bestOf: Number(cfg.bestOf == null ? 3 : cfg.bestOf), minDuels: Math.floor(Number(cfg.minDuels == null ? 1 : cfg.minDuels)),
      cut: Math.floor(Number(cfg.cut == null ? 4 : cfg.cut)),
      points: { win: pts.win == null ? 3 : Number(pts.win), loss: pts.loss == null ? 0 : Number(pts.loss) }
    };
  }

  /* Cantidad de rondas del suizo para garantizar `min` duelos. Con cantidad impar, quien descansa pierde un duelo → una ronda de más. */
  function swissRounds(n, min) { return min + (n % 2 ? 1 : 0); }
  /* El suizo sin repetir rival siempre se puede armar mientras R <= m/2 (m = cantidad par ≥ n): un grafo regular de grado ≥ m/2 tiene emparejamiento perfecto (Dirac). */
  function swissFeasible(n, R) { return n >= 2 && R >= 1 && R <= evenUp(n) / 2; }
  function swissMaxMin(n) { return Math.max(0, evenUp(n) / 2 - (n % 2 ? 1 : 0)); }

  function roundName(r, K) {
    var left = K - r;                                   // rondas que faltan después de esta
    return left === 0 ? 'Final' : left === 1 ? 'Semifinal' : left === 2 ? 'Cuartos de final' : left === 3 ? 'Octavos de final' : left === 4 ? 'Dieciseisavos de final' : 'Ronda ' + r;
  }

  /* Plan matemático del torneo: cuántas rondas, cuántos duelos y cuántos le tocan como mínimo / máximo a cada jugador. */
  function planOf(n, c) {
    var f = c.format, R, K;
    if (f === 'elim') { K = ceilLog2(n); return { rounds: K, duels: n - 1, min: 1, max: K }; }
    if (f === 'rr') { var m = evenUp(n); return { rounds: m - 1, duels: n * (n - 1) / 2, min: n - 1, max: n - 1 }; }
    if (f === 'rr_cut') { var m2 = evenUp(n); K = ceilLog2(c.cut); return { rounds: m2 - 1 + K, duels: n * (n - 1) / 2 + c.cut - 1, min: n - 1, max: n - 1 + K, rrRounds: m2 - 1, cutRounds: K }; }
    R = swissRounds(n, c.minDuels);
    var sw = { rounds: R, duels: R * Math.floor(n / 2), min: n % 2 ? R - 1 : R, max: R };
    if (f === 'swiss') return sw;
    K = ceilLog2(c.cut);
    return { rounds: R + K, duels: sw.duels + c.cut - 1, min: sw.min, max: R + K, swissRounds: R, cutRounds: K };
  }

  function check(cfg, players) {
    var c = normCfg(cfg), errors = [], warnings = [];
    var n = Array.isArray(players) ? players.length : Math.floor(Number(players));
    function err(code, msg) { errors.push({ code: code, msg: msg }); }
    if (FORMATS.indexOf(c.format) < 0) err('format', 'Elegí un formato de torneo.');
    if (!(n >= 2)) err('players', 'Hacen falta al menos 2 jugadores.');
    else if (n > MAX_PLAYERS) err('players', 'El máximo es ' + MAX_PLAYERS + ' jugadores.');
    if (BEST_OF.indexOf(c.bestOf) < 0) err('bestOf', 'Cada duelo puede ser al mejor de 1, 3, 5 o 7 partidas.');
    if (!(c.minDuels >= 1)) err('minDuels', 'El mínimo de duelos tiene que ser 1 o más.');
    if (c.points.win < c.points.loss) err('points', 'La victoria no puede dar menos puntos que la derrota.');
    if (errors.length) return { ok: false, errors: errors, warnings: warnings, plan: null, cfg: c, n: n };

    if (c.minDuels > n - 1) err('minDuels', 'Con ' + n + ' jugadores nadie puede enfrentar a más de ' + (n - 1) + ' rivales distintos: el mínimo no puede ser ' + c.minDuels + '.');
    else if (c.format === 'elim' && c.minDuels > 1) err('minDuels', 'La eliminación directa solo garantiza 1 duelo: quien pierde la primera vez queda afuera.');
    else if ((c.format === 'rr' || c.format === 'rr_cut') && c.minDuels > n - 1) err('minDuels', 'Todos contra todos da ' + (n - 1) + ' duelos a cada jugador.');
    else if ((c.format === 'swiss' || c.format === 'swiss_cut') && !swissFeasible(n, swissRounds(n, c.minDuels))) {
      err('minDuels', 'Con ' + n + ' jugadores el suizo garantiza como máximo ' + swissMaxMin(n) + ' duelo' + (swissMaxMin(n) === 1 ? '' : 's') + ' (para más conviene todos contra todos).');
    }
    if (c.format === 'swiss_cut' || c.format === 'rr_cut') {
      if (!isPow2(c.cut) || c.cut < 2) err('cut', 'Los que pasan a la eliminatoria tienen que ser 2, 4, 8 o 16.');
      else if (c.cut >= n) err('cut', 'Tienen que pasar menos jugadores que los que participan (' + n + ').');
    }
    if (errors.length) return { ok: false, errors: errors, warnings: warnings, plan: null, cfg: c, n: n };

    var plan = planOf(n, c);
    if ((c.format === 'swiss' || c.format === 'swiss_cut') && plan.rounds && (c.format === 'swiss' ? plan.rounds : plan.swissRounds) < ceilLog2(n)) {
      warnings.push('Con tan pocas rondas puede no quedar un campeón claro; se desempata por victorias, diferencia de partidas y resultado entre empatados.');
    }
    if (n % 2 && c.format !== 'elim') warnings.push('Con cantidad impar, en cada ronda alguien descansa. El descanso da los puntos de una victoria pero no cuenta como duelo.');
    if (c.format === 'elim' && !isPow2(n)) warnings.push('Con ' + n + ' jugadores los mejores sembrados empiezan con descanso en la primera ronda.');
    return { ok: true, errors: [], warnings: warnings, plan: plan, cfg: c, n: n };
  }

  /* Alternativas válidas cuando la configuración pedida no se puede cumplir. */
  function suggest(cfg, players) {
    var c = normCfg(cfg), n = Array.isArray(players) ? players.length : Math.floor(Number(players)), out = [];
    if (!(n >= 2)) return out;
    function add(label, over) {
      var cand = Object.assign({}, c, over);
      var v = check(cand, n);
      if (v.ok && !out.some(function (o) { return JSON.stringify(o.cfg) === JSON.stringify(v.cfg); })) out.push({ label: label, cfg: v.cfg, plan: v.plan });
    }
    var want = Math.max(1, c.minDuels), cutDef = Math.max(2, Math.min(floorPow2(Math.max(2, Math.floor(n / 2))), 8));
    if (want <= n - 1) add('Todos contra todos (cada uno juega ' + (n - 1) + ' duelos)', { format: 'rr', minDuels: Math.min(want, n - 1) });
    if (want <= n - 1 && n >= 3) add('Todos contra todos (' + (n - 1) + ' duelos) y eliminatoria final con los mejores ' + cutDef, { format: 'rr_cut', minDuels: Math.min(want, n - 1), cut: cutDef });
    add('Suizo con ' + want + ' duelos garantizados', { format: 'swiss', minDuels: want });
    add('Suizo (' + want + ' duelos) y eliminatoria final con los mejores ' + cutDef, { format: 'swiss_cut', minDuels: want, cut: cutDef });
    var mx = swissMaxMin(n);
    if (mx >= 1 && mx < want) {
      add('Suizo con ' + mx + ' duelos (el máximo posible)', { format: 'swiss', minDuels: mx });
      add('Suizo (' + mx + ' duelos) y eliminatoria final', { format: 'swiss_cut', minDuels: mx, cut: cutDef });
    }
    if (want > 1) add('Eliminación directa (1 duelo garantizado)', { format: 'elim', minDuels: 1 });
    return out.slice(0, 4);
  }

  function validate(cfg, players) {
    var v = check(cfg, players);
    v.suggestions = v.ok ? [] : suggest(cfg, players);
    return v;
  }

  /* Texto para la pantalla de confirmación ("vista previa"). */
  function preview(cfg, players) {
    var v = validate(cfg, players);
    if (!v.ok) return { ok: false, title: v.cfg.name, lines: [], promises: [], errors: v.errors, suggestions: v.suggestions };
    var c = v.cfg, p = v.plan, need = (c.bestOf + 1) / 2, lines = [], promises = [];
    lines.push('Jugadores: ' + v.n);
    lines.push('Formato: ' + FORMAT_NAME[c.format] + (c.format === 'swiss' ? ' (' + p.rounds + ' rondas)' : c.format === 'swiss_cut' ? ' (' + p.swissRounds + ' rondas + top ' + c.cut + ')' : c.format === 'rr_cut' ? ' (' + p.rrRounds + ' fechas + top ' + c.cut + ')' : ''));
    lines.push('Duelo: ' + (c.bestOf === 1 ? 'una sola partida' : 'mejor de ' + c.bestOf + ' (gana quien llegue a ' + need + ' partidas)'));
    lines.push('Puntos: ' + c.points.win + ' por duelo ganado, ' + c.points.loss + ' por perdido');
    lines.push('En total: ' + p.duels + ' duelos en ' + p.rounds + ' rondas');
    promises.push('Todos jugarán al menos ' + p.min + ' duelo' + (p.min === 1 ? '' : 's') + '.');
    if (c.format === 'elim') promises.push('Quien pierda un duelo queda eliminado.');
    promises.push('Un duelo es un enfrentamiento entre dos personas; puede tener varias partidas. Perder 0-3 cuenta como 1 duelo, no como 3.');
    promises.push('Quien empieza la primera partida de cada duelo se alterna para que nadie tenga siempre la ventaja de mover primero.');
    return { ok: true, title: c.name, lines: lines, promises: promises, warnings: v.warnings, plan: p };
  }

  /* ---------- armado de rondas ---------- */
  function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  /* Mezcla reproducible: la misma semilla da siempre el mismo orden (sirve para sembrar al azar y poder auditarlo). */
  function shuffle(list, seed) {
    var a = list.slice(), rnd = mulberry32(Math.floor(Number(seed)) || 1);
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(rnd() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }

  function newDuel(S, round, idx, a, b) {
    return { id: S.phasePrefix + round + '-' + (idx + 1), a: a, b: b, bye: false, bestOf: S.cfg.bestOf, games: [], score: { a: 0, b: 0 }, winner: null, walkover: false, status: 'pending', opens: (S.duelSeq++ % 2) ? 'b' : 'a' };
  }
  function makeBye(S, round, idx, p) { var d = newDuel(S, round, idx, p, null); d.bye = true; d.status = 'done'; d.winner = p; return d; }

  /* Emparejamiento sin repetir rival: busca el primero (en orden de ranking) que complete a todos. Siempre existe mientras R <= m/2. */
  function matchDFS(list, played) {
    var used = {}, out = [], steps = 0;
    function go() {
      if (++steps > 400000) return false;
      var i = 0; while (i < list.length && used[list[i]]) i++;
      if (i === list.length) return true;
      var p = list[i]; used[p] = 1;
      for (var j = i + 1; j < list.length; j++) {
        var q = list[j];
        if (used[q] || (played[p] && played[p][q])) continue;
        used[q] = 1; out.push([p, q]);
        if (go()) return true;
        out.pop(); used[q] = 0;
      }
      used[p] = 0; return false;
    }
    return go() ? out : null;
  }
  function playedMap(S) {
    var m = {};
    S.rounds.forEach(function (r) { if (r.phase !== 'swiss') return; r.duels.forEach(function (d) {
      var b = d.b == null ? BYE : d.b; (m[d.a] = m[d.a] || {})[b] = 1; (m[b] = m[b] || {})[d.a] = 1;
    }); });
    return m;
  }
  function swissRound(S) {
    var r = S.rounds.length + 1, n = S.players.length, order, pairs;
    var swissDone = S.rounds.filter(function (x) { return x.phase === 'swiss'; }).length;
    var rno = swissDone + 1;
    if (rno === 1) {
      order = S.players.map(function (p) { return p.id; });
      var bye1 = n % 2 ? order.pop() : null, half = order.length / 2;
      pairs = []; for (var i = 0; i < half; i++) pairs.push([order[i], order[i + half]]);
      if (bye1) pairs.push([bye1, BYE]);
    } else {
      var tbl = standings(S, { phase: 'swiss' });
      order = tbl.map(function (x) { return x.id; });
      if (n % 2) order.push(BYE);
      pairs = matchDFS(order, playedMap(S));
      if (!pairs) throw new Error('No se pudo armar la ronda ' + rno + ' sin repetir rivales.');
    }
    var duels = [], idx = 0;
    pairs.forEach(function (pr) {
      if (pr[1] === BYE) duels.push(makeBye(S, r, idx++, pr[0]));
      else if (pr[0] === BYE) duels.push(makeBye(S, r, idx++, pr[1]));
      else duels.push(newDuel(S, r, idx++, pr[0], pr[1]));
    });
    S.phasePrefix = 'S'; duels.forEach(function (d, i) { d.id = 'S' + rno + '-' + (i + 1); });
    S.rounds.push({ n: r, phase: 'swiss', name: 'Ronda ' + rno, duels: duels });
  }

  function rrRounds(S) {
    var ids = S.players.map(function (p) { return p.id; });
    if (ids.length % 2) ids.push(BYE);
    var m = ids.length, arr = ids.slice();
    for (var r = 0; r < m - 1; r++) {
      var duels = [], idx = 0;
      for (var i = 0; i < m / 2; i++) {
        var a = arr[i], b = arr[m - 1 - i];
        var d;
        if (a === BYE || b === BYE) { d = makeBye(S, r + 1, idx++, a === BYE ? b : a); d.rest = true; }
        else { d = (r + i) % 2 ? newDuel(S, r + 1, idx++, b, a) : newDuel(S, r + 1, idx++, a, b); }
        d.id = 'R' + (r + 1) + '-' + (idx);
        duels.push(d);
      }
      S.rounds.push({ n: r + 1, phase: 'rr', name: 'Fecha ' + (r + 1), duels: duels });
      arr.splice(1, 0, arr.pop());                       // método del círculo: el primero queda fijo, el resto rota
    }
  }

  function bracketSeeds(m) { var s = [1, 2]; while (s.length < m) { var next = [], len = s.length * 2; s.forEach(function (x) { next.push(x); next.push(len + 1 - x); }); s = next; } return s.slice(0, m); }
  /* Arma el cuadro completo de eliminación para `ids` (ya ordenados por siembra). Los duelos de rondas posteriores se llenan a medida que hay ganadores. */
  function buildElim(S, ids) {
    var n = ids.length, m = 1; while (m < n) m *= 2;
    var K = ceilLog2(m), base = S.rounds.length, seeds = bracketSeeds(m), cur = [], rounds = [];
    function id(seed) { return seed <= n ? ids[seed - 1] : null; }
    var first = [];
    for (var i = 0; i < m / 2; i++) {
      var a = id(seeds[2 * i]), b = id(seeds[2 * i + 1]), d;
      if (a && b) d = newDuel(S, base + 1, i, a, b);
      else d = makeBye(S, base + 1, i, a || b);
      d.id = 'E1-' + (i + 1); first.push(d);
    }
    rounds.push(first); cur = first;
    for (var r = 2; r <= K; r++) {
      var next = [];
      for (var j = 0; j < cur.length / 2; j++) {
        var nd = newDuel(S, base + r, j, null, null); nd.id = 'E' + r + '-' + (j + 1); next.push(nd);
        cur[2 * j].next = { id: nd.id, slot: 'a' }; cur[2 * j + 1].next = { id: nd.id, slot: 'b' };
      }
      rounds.push(next); cur = next;
    }
    rounds.forEach(function (ds, k) { S.rounds.push({ n: base + k + 1, phase: 'elim', name: roundName(k + 1, K), duels: ds }); });
    // los descansos de la primera ronda ya tienen ganador: se acomodan en la ronda siguiente
    first.forEach(function (d) { if (d.status === 'done') place(S, d); });
  }

  function findDuel(S, id) {
    for (var i = 0; i < S.rounds.length; i++) for (var j = 0; j < S.rounds[i].duels.length; j++) if (S.rounds[i].duels[j].id === id) return S.rounds[i].duels[j];
    return null;
  }
  function place(S, d) {                                  // pasa el ganador de un duelo de eliminación al siguiente cruce
    if (!d.next || !d.winner) return;
    var nx = findDuel(S, d.next.id); nx[d.next.slot] = d.winner;
  }

  /* ---------- creación ---------- */
  function create(cfg, playersIn) {
    var np = normPlayers(playersIn);
    if (np.error) throw new Error(np.error);
    var v = validate(cfg, np.players);
    if (!v.ok) { var e = new Error(v.errors[0].msg); e.validation = v; throw e; }
    var S = { v: 1, cfg: v.cfg, plan: v.plan, players: np.players, rounds: [], status: 'running', phase: v.cfg.format === 'elim' ? 'elim' : (v.cfg.format === 'rr' || v.cfg.format === 'rr_cut') ? 'rr' : 'swiss', champion: null, withdrawn: [], duelSeq: 0, phasePrefix: 'S', log: [] };
    if (v.cfg.format === 'rr' || v.cfg.format === 'rr_cut') rrRounds(S);
    else if (v.cfg.format === 'elim') buildElim(S, S.players.map(function (p) { return p.id; }));
    else swissRound(S);
    autoWalkover(S); advance(S);
    return S;
  }

  /* ---------- resultados ---------- */
  function need(S) { return (S.cfg.bestOf + 1) / 2; }
  function finishDuel(S, d, winner, walkover) {
    d.winner = winner; d.status = 'done'; d.walkover = !!walkover;
    if (S.phase === 'elim' || d.id.charAt(0) === 'E') place(S, d);
  }
  /* games: lista con el id de quien ganó cada partida, en orden. Se puede ir cargando de a una (el duelo queda "en juego"). */
  function recordGames(state, duelId, games) {
    var S = clone(state);
    if (S.status !== 'running') throw new Error('El torneo no está en curso.');
    var d = findDuel(S, duelId);
    if (!d) throw new Error('No existe ese duelo.');
    if (d.bye) throw new Error('Ese cruce es un descanso.');
    if (d.status === 'done') throw new Error('Ese duelo ya terminó.');
    if (!d.a || !d.b) throw new Error('Ese duelo todavía no tiene los dos jugadores.');
    var n = need(S), sa = 0, sb = 0, list = [];
    (games || []).forEach(function (w) {
      if (sa >= n || sb >= n) throw new Error('Sobran partidas: el duelo ya estaba definido.');
      if (w !== d.a && w !== d.b) throw new Error('El ganador de una partida tiene que ser uno de los dos jugadores del duelo.');
      if (w === d.a) sa++; else sb++;
      list.push(w);
    });
    d.games = list; d.score = { a: sa, b: sb }; d.status = list.length ? 'playing' : 'pending';
    if (sa >= n || sb >= n) finishDuel(S, d, sa >= n ? d.a : d.b, false);
    logGames(S, duelId, list);
    autoWalkover(S); advance(S);
    return S;
  }
  /* Cada acción queda en un registro: sirve para deshacer (se rearma el torneo repitiendo todo menos lo último). */
  function logGames(S, id, list) {
    var l = S.log[S.log.length - 1];
    if (l && l.t === 'games' && l.id === id) { if (list.length) l.games = list.slice(); else S.log.pop(); }
    else if (list.length) S.log.push({ t: 'games', id: id, games: list.slice() });
  }

  /* El organizador resuelve un duelo a mano (abandono, problema técnico…). Queda marcado como walkover. */
  function forfeit(state, duelId, winnerId) {
    var S = clone(state), d = findDuel(S, duelId);
    if (!d || d.bye || d.status === 'done' || !d.a || !d.b) throw new Error('Ese duelo no se puede resolver así.');
    if (winnerId !== d.a && winnerId !== d.b) throw new Error('El ganador tiene que ser uno de los dos jugadores.');
    finishDuel(S, d, winnerId, true); S.log.push({ t: 'forfeit', id: duelId, winner: winnerId });
    autoWalkover(S); advance(S);
    return S;
  }

  /* Un jugador se retira: pierde por walkover todos sus duelos pendientes (los presentes y los que lleguen). */
  function withdraw(state, playerId) {
    var S = clone(state);
    if (!S.players.some(function (p) { return p.id === playerId; })) throw new Error('Ese jugador no está en el torneo.');
    if (S.withdrawn.indexOf(playerId) < 0) { S.withdrawn.push(playerId); S.log.push({ t: 'withdraw', id: playerId }); }
    autoWalkover(S); advance(S);
    return S;
  }
  /* Rearma el torneo desde cero repitiendo el registro. */
  function replay(state, log) {
    var S = create(state.cfg, state.players);
    log.forEach(function (e) {
      if (e.t === 'games') S = recordGames(S, e.id, e.games);
      else if (e.t === 'forfeit') S = forfeit(S, e.id, e.winner);
      else if (e.t === 'withdraw') S = withdraw(S, e.id);
    });
    if (state.meta) S.meta = state.meta;
    return S;
  }
  /* Deshace lo último: la última partida cargada, el último resultado resuelto a mano o el último retiro. */
  function undo(state) {
    var log = (state.log || []).slice(); if (!log.length) return state;
    var last = log.pop();
    if (last.t === 'games' && last.games.length > 1) log.push({ t: 'games', id: last.id, games: last.games.slice(0, -1) });
    return replay(state, log);
  }
  /* Corregir un resultado: reabre ese duelo. Se rearma el torneo con todo lo anterior y se pierde lo que dependía de ese resultado (los cruces y resultados posteriores);
   * los retiros hechos después se conservan. Un duelo resuelto solo por un retiro (sin resultado cargado) no se puede reabrir: hay que deshacer el retiro. */
  function rewind(state, duelId) {
    var log = (state.log || []), cut = -1, i;
    for (i = 0; i < log.length; i++) if ((log[i].t === 'games' || log[i].t === 'forfeit') && log[i].id === duelId) { cut = i; break; }
    if (cut < 0) throw new Error('Ese duelo no tiene un resultado cargado que se pueda corregir.');
    var later = log.slice(cut + 1).filter(function (e) { return e.t === 'withdraw'; });
    return replay(state, log.slice(0, cut).concat(later));
  }
  function autoWalkover(S) {
    var changed = true;
    while (changed) {
      changed = false;
      S.rounds.forEach(function (r) { r.duels.forEach(function (d) {
        if (d.status === 'done' || d.bye || !d.a || !d.b) return;
        var wa = S.withdrawn.indexOf(d.a) >= 0, wb = S.withdrawn.indexOf(d.b) >= 0;
        if (!wa && !wb) return;
        var win = wa && wb ? (seedOf(S, d.a) < seedOf(S, d.b) ? d.a : d.b) : (wa ? d.b : d.a);
        finishDuel(S, d, win, true); changed = true;
      }); });
    }
  }
  function seedOf(S, id) { for (var i = 0; i < S.players.length; i++) if (S.players[i].id === id) return S.players[i].seed; return 999; }

  function roundsDone(S, phase) { return S.rounds.filter(function (r) { return r.phase === phase; }); }
  function allDone(r) { return r.duels.every(function (d) { return d.status === 'done'; }); }

  /* Avanza el torneo: siguiente ronda de suizo, paso a la eliminatoria final o cierre con campeón. */
  function advance(S) {
    var guard = 0;
    while (S.status === 'running' && guard++ < 200) {
      var f = S.cfg.format, last = S.rounds[S.rounds.length - 1];
      if (f === 'rr') {
        if (S.rounds.every(allDone)) { finish(S); }
        return;
      }
      if (f === 'elim') {
        if (S.rounds.every(allDone)) finish(S);
        return;
      }
      if (f === 'rr_cut') {                                     // todos contra todos: cuando terminan todas las fechas, los mejores pasan a la eliminatoria
        if (S.phase === 'rr') {
          if (!S.rounds.every(allDone)) return;
          var tb = standings(S, { phase: 'rr' }).filter(function (x) { return S.withdrawn.indexOf(x.id) < 0; });
          var ct = Math.min(S.cfg.cut, floorPow2(tb.length));
          if (ct < 2) { finish(S); return; }
          S.phase = 'elim'; S.phasePrefix = 'E';
          buildElim(S, tb.slice(0, ct).map(function (x) { return x.id; }));
          autoWalkover(S); continue;
        }
        if (S.rounds.every(allDone)) finish(S);
        return;
      }
      // suizo / suizo + corte
      if (S.phase === 'swiss') {
        if (!allDone(last)) return;
        var played = roundsDone(S, 'swiss').length, R = S.plan.swissRounds || S.plan.rounds;
        if (played < R) { swissRound(S); autoWalkover(S); continue; }
        if (f === 'swiss') { finish(S); return; }
        var tbl = standings(S, { phase: 'swiss' }).filter(function (x) { return S.withdrawn.indexOf(x.id) < 0; });
        var cut = Math.min(S.cfg.cut, floorPow2(tbl.length));
        if (cut < 2) { finish(S); return; }
        S.phase = 'elim'; S.phasePrefix = 'E';
        buildElim(S, tbl.slice(0, cut).map(function (x) { return x.id; }));
        autoWalkover(S); continue;
      }
      if (S.rounds.every(allDone)) finish(S);
      return;
    }
  }
  function finish(S) {
    S.status = 'finished';
    var r = ranking(S);
    S.champion = r.length ? r[0].id : null;
  }

  /* ---------- clasificación ---------- */
  function emptyRow(p) { return { id: p.id, name: p.name, seed: p.seed, duels: 0, dw: 0, dl: 0, gw: 0, gl: 0, diff: 0, pts: 0, byes: 0 }; }
  /* Tabla con desempates fijos y sin ambigüedad:
   *   1) puntos  2) duelos ganados  3) diferencia de partidas  4) partidas ganadas
   *   5) resultado entre los empatados (duelos ganados solo entre ellos)  6) orden de siembra. */
  function standings(state, opts) {
    var S = state, phase = (opts && opts.phase) || (S.cfg.format === 'elim' ? 'elim' : (S.cfg.format === 'rr' || S.cfg.format === 'rr_cut') ? 'rr' : 'swiss');
    var rows = {}, h2h = {};
    S.players.forEach(function (p) { rows[p.id] = emptyRow(p); });
    S.rounds.forEach(function (r) { if (r.phase !== phase) return; r.duels.forEach(function (d) {
      if (d.status !== 'done') return;
      if (d.bye) { if (d.rest) return; var rb = rows[d.a]; rb.byes++; if (phase === 'swiss') rb.pts += S.cfg.points.win; return; }
      var A = rows[d.a], B = rows[d.b], win = d.winner === d.a ? A : B, lose = win === A ? B : A;
      A.duels++; B.duels++; win.dw++; lose.dl++; win.pts += S.cfg.points.win; lose.pts += S.cfg.points.loss;
      if (!d.walkover) { A.gw += d.score.a; A.gl += d.score.b; B.gw += d.score.b; B.gl += d.score.a; }
      (h2h[win.id] = h2h[win.id] || {})[lose.id] = (h2h[win.id][lose.id] || 0) + 1;
    }); });
    var list = Object.keys(rows).map(function (k) { var r = rows[k]; r.diff = r.gw - r.gl; return r; });
    function key(r) { return [r.pts, r.dw, r.diff, r.gw]; }
    function cmpKey(a, b) { var ka = key(a), kb = key(b); for (var i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return kb[i] - ka[i]; return 0; }
    list.sort(function (a, b) { return cmpKey(a, b) || a.seed - b.seed; });
    // resultado entre empatados (mini-liga dentro de cada grupo empatado)
    var out = [], i = 0;
    while (i < list.length) {
      var j = i; while (j + 1 < list.length && cmpKey(list[j + 1], list[i]) === 0) j++;
      var grp = list.slice(i, j + 1);
      if (grp.length > 1) {
        var ids = {}; grp.forEach(function (g) { ids[g.id] = 1; });
        grp.forEach(function (g) { g.h2h = 0; Object.keys(h2h[g.id] || {}).forEach(function (o) { if (ids[o]) g.h2h += h2h[g.id][o]; }); });
        grp.sort(function (a, b) { return b.h2h - a.h2h || a.seed - b.seed; });
      }
      out = out.concat(grp); i = j + 1;
    }
    out.forEach(function (r, k) { r.pos = k + 1; });
    return out;
  }

  /* Posición final de todos. Con eliminatoria manda hasta dónde llegó cada uno; el resto va por la tabla previa. */
  function ranking(state) {
    var S = state, f = S.cfg.format;
    var base = f === 'elim' ? S.players.map(emptyRow) : standings(S, { phase: (f === 'rr' || f === 'rr_cut') ? 'rr' : 'swiss' });
    if (f === 'elim' || f === 'swiss_cut' || f === 'rr_cut') {
      var elimRounds = S.rounds.filter(function (r) { return r.phase === 'elim'; }), K = elimRounds.length, reach = {}, inElim = {};
      elimRounds.forEach(function (r, k) { r.duels.forEach(function (d) {
        [d.a, d.b].forEach(function (p) { if (p) { inElim[p] = 1; reach[p] = Math.max(reach[p] || 0, k + 1); } });
        if (d.status === 'done' && d.winner && !d.bye) reach[d.winner] = Math.max(reach[d.winner] || 0, k + 2);
        if (d.bye && d.winner) reach[d.winner] = Math.max(reach[d.winner] || 0, k + 2);
      }); });
      var seedPos = {}; base.forEach(function (r, i) { seedPos[r.id] = i; });
      if (f === 'elim') base.forEach(function (r, i) { seedPos[r.id] = r.seed; });
      var withElim = base.filter(function (r) { return inElim[r.id]; }), rest = base.filter(function (r) { return !inElim[r.id]; });
      withElim.sort(function (a, b) { return (reach[b.id] || 0) - (reach[a.id] || 0) || seedPos[a.id] - seedPos[b.id]; });
      base = withElim.concat(rest);
      base.forEach(function (r) { r.reach = inElim[r.id] ? (reach[r.id] || 0) : 0; });          // hasta qué ronda de la eliminatoria llegó (0 = no jugó la eliminatoria)
    }
    return base.map(function (r, i) { var o = Object.assign({}, r); o.pos = i + 1; return o; });
  }
  /* Podio: { gold:[ids], silver:[ids], bronze:[ids] } (null si el torneo no terminó). Con eliminatoria no hay partido por el tercer puesto:
   * los dos que perdieron la semifinal comparten el bronce. En tabla (suizo / todos contra todos) manda la tabla con sus desempates. */
  function podium(state) {
    if (!state || state.status !== 'finished') return null;
    var r = ranking(state), out = { gold: [], silver: [], bronze: [] };
    if (!r.length) return out;
    out.gold = [r[0].id]; if (r.length > 1) out.silver = [r[1].id];
    if (r.length > 2) {
      var third = r[2];
      if (third.reach > 0 && r[1].reach > third.reach && r[0].reach > third.reach) out.bronze = r.filter(function (x) { return x.reach === third.reach; }).map(function (x) { return x.id; });
      else out.bronze = [third.id];
    }
    return out;
  }

  /* Quién abre la partida número k (0, 1, 2…) de un duelo: se alterna. */
  function opener(duel, k) { var first = duel.opens === 'b' ? duel.b : duel.a, second = first === duel.a ? duel.b : duel.a; return k % 2 === 0 ? first : second; }
  /* Próximos duelos que se pueden jugar ya (los dos jugadores definidos y sin terminar). */
  function pending(state) { var out = []; state.rounds.forEach(function (r) { r.duels.forEach(function (d) { if (d.status !== 'done' && !d.bye && d.a && d.b) out.push({ round: r.name, duel: d }); }); }); return out; }
  function nameOf(state, id) { for (var i = 0; i < state.players.length; i++) if (state.players[i].id === id) return state.players[i].name; return id == null ? '' : String(id); }

  return {
    FORMATS: FORMATS, BEST_OF: BEST_OF, MAX_PLAYERS: MAX_PLAYERS, FORMAT_NAME: FORMAT_NAME,
    validate: validate, preview: preview, create: create, recordGames: recordGames, forfeit: forfeit, withdraw: withdraw, undo: undo, rewind: rewind,
    standings: standings, ranking: ranking, podium: podium, pending: pending, opener: opener, nameOf: nameOf, shuffle: shuffle,
    swissMaxMin: swissMaxMin
  };
});
