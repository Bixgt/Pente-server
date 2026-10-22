/* IA de Pente (rival offline). Lógica pura, sin DOM ni red: funciona en el navegador (window.PenteAI) y en Node (require).
 *
 *   PenteAI.chooseMove(state, { level: 'beginner'|'easy'|'medium'|'hard', timeMs, rng }) -> {x, y}
 *
 * Cómo piensa (en cristiano):
 *  1. Mira solo las casillas cercanas a fichas ya puestas (si no, serían cientos de jugadas inútiles).
 *  2. Les pone una nota rápida: cuánto arma una línea propia, cuánto bloquea una del rival, si captura.
 *  3. Se queda con las mejores y "mira hacia adelante" jugando y respondiendo (búsqueda alfa-beta),
 *     puntuando el tablero por líneas abiertas, pares capturados y pares propios vulnerables.
 *  Siempre juega la victoria inmediata si la hay. Respeta las reglas porque juega con el mismo núcleo (PenteCore).
 *
 * Niveles:  beginner = mira 1 jugada y casi no tapa nada: deja pasar cuatros y se despista seguido (en pantalla: "Fácil")
 *           easy   = mira 1 jugada, con ruido y despistes (se le puede ganar siendo principiante)
 *           medium = mira 2 jugadas (ve que le ganás en la siguiente y la tapa)
 *           hard   = profundización iterativa hasta 4 jugadas dentro de un tiempo (por defecto 700 ms)
 * No es invencible: es un rival decente para jugar sin conexión, no un motor de torneo. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./pente-core.js'));
  else root.PenteAI = factory(root.PenteCore);
})(typeof self !== 'undefined' ? self : this, function (P) {
  'use strict';

  var AXES = [[1, 0], [0, 1], [1, 1], [1, -1]];
  var WIN = 1000000;

  // block4 / block3: probabilidad de tapar un cuatro (o una captura que gana) / un tres abierto cuando lo ve (solo niveles de 1 jugada)
  var LEVELS = {
    beginner: { depth: 1, width: 8, timeMs: 0, noise: 1.4, slipTop: 8, slipChance: 0.7, seesWin: 0.35, block4: 0.95, block3: 0.7, ignoreObvious: true },
    easy:   { depth: 1, width: 6,  timeMs: 0,   noise: 0.55, slipTop: 5, slipChance: 0.35, seesWin: 0.85, block4: 0.97, block3: 0.75 },
    medium: { depth: 2, width: 10, timeMs: 350, noise: 0.08, slipTop: 1, slipChance: 0,    seesWin: 1, vary: 300 },
    hard:   { depth: 4, width: 12, timeMs: 700, noise: 0,    slipTop: 1, slipChance: 0,    seesWin: 1, vary: 150 }       // vary: entre jugadas casi igual de buenas (a esta distancia de la mejor) elige una al azar: así no repite siempre la misma
  };

  // Valor de una racha de L fichas con "open" extremos libres (0, 1 o 2).
  function lineScore(L, open) {
    if (L >= 5) return 100000;
    if (open === 0) return 0;
    if (L === 4) return open === 2 ? 20000 : 4000;
    if (L === 3) return open === 2 ? 1800 : 220;
    if (L === 2) return open === 2 ? 120 : 16;
    return open === 2 ? 6 : 1;
  }

  // Rivales de "p": uno en 2 jugadores (o por equipos), todos los que siguen en juego en "todos contra todos"
  function rivalsOf(s, p) {
    if (!s.ffa) return [P.opponent(p)];
    var out = []; for (var q = 1; q <= 4; q++) if (q !== p && !s.out[q]) out.push(q);
    return out;
  }
  function cellAt(s, x, y) { return (x < 0 || y < 0 || x >= s.size || y >= s.size) ? -1 : s.board[y * s.size + x]; }   // -1 = fuera

  /* Nota rápida de poner "p" en (x,y): líneas que arma + líneas del rival que tapa + capturas. Barata: se usa para ordenar jugadas. */
  function quick(s, x, y, p) {
    var rv = rivalsOf(s, p), total = 0, a, d, L, open, cx, cy, v, ri;
    for (a = 0; a < 4; a++) {
      var dx = AXES[a][0], dy = AXES[a][1], blockBest = 0;
      for (var side = 0; side < 1 + rv.length; side++) {     // side 0: yo armo; después, tapo a cada rival (como si él pusiera acá); se toma el rival más peligroso
        var who = side ? rv[side - 1] : p; L = 1; open = 0;
        for (d = 1; d < 5; d++) { cx = x + dx * d; cy = y + dy * d; v = cellAt(s, cx, cy); if (v === who) L++; else { if (v === 0) open++; break; } }
        for (d = 1; d < 5; d++) { cx = x - dx * d; cy = y - dy * d; v = cellAt(s, cx, cy); if (v === who) L++; else { if (v === 0) open++; break; } }
        var ls = lineScore(L, open);
        if (side) blockBest = Math.max(blockBest, ls * 0.92); else total += ls;
      }
      total += blockBest;
    }
    var tw = s.options.capturesToWin, caps = P.captureInfo(s, x, y, p).points;
    if (caps) total += 1900 * caps + (s.captures[p] + caps >= tw ? 90000 : s.captures[p] >= tw - 2 ? 1500 : 0);
    var q = rv[0], theirs = 0;
    for (ri = 0; ri < rv.length; ri++) { var tp = P.captureInfo({ size: s.size, board: s.board, options: s.options }, x, y, rv[ri]).points; if (tp > theirs) { theirs = tp; q = rv[ri]; } }      // si ÉL jugara acá, ¿capturaría? tapar vale
    if (theirs) total += 1100 * theirs + (s.captures[q] + theirs >= tw ? 80000 : 0);
    var c = (s.size - 1) / 2; total -= (Math.abs(x - c) + Math.abs(y - c)) * 0.3;                 // desempate: el centro vale un poquito
    return total;
  }

  /* Evaluación estática del tablero desde el punto de vista de "p": líneas abiertas, pares capturados y pares vulnerables. */
  function evaluate(s, p) {
    var n = s.size, b = s.board, score = 0, a, x, y, v, vr = P.VARIANT_RULES[s.options.variant] || P.VARIANT_RULES.classic, vuln = vr.sizes.length ? vr.sizes[0] : -1;
    for (a = 0; a < 4; a++) {
      var dx = AXES[a][0], dy = AXES[a][1];
      for (y = 0; y < n; y++) for (x = 0; x < n; x++) {
        v = b[y * n + x]; if (!v) continue;
        var px = x - dx, py = y - dy;
        if (px >= 0 && py >= 0 && px < n && py < n && b[py * n + px] === v) continue;       // no es el inicio de la racha
        var L = 1, cx = x + dx, cy = y + dy;
        while (cx >= 0 && cy >= 0 && cx < n && cy < n && b[cy * n + cx] === v) { L++; cx += dx; cy += dy; }
        var after = (cx >= 0 && cy >= 0 && cx < n && cy < n) ? b[cy * n + cx] : -1, before = (px >= 0 && py >= 0 && px < n && py < n) ? b[py * n + px] : -1;
        var open = (after === 0 ? 1 : 0) + (before === 0 ? 1 : 0), sc = lineScore(L, open);
        if (L === vuln && ((after === 0 && before > 0 && before !== v) || (before === 0 && after > 0 && after !== v))) sc -= 650;   // par con un rival de un lado y hueco del otro: lo pueden capturar
        score += (v === p) ? sc : -sc * (s.ffa ? 0.55 : 1.05);
      }
    }
    var rvs = rivalsOf(s, p), q = rvs[0], cd = s.captures[p], qmax = 0; rvs.forEach(function (r) { cd -= s.captures[r] / rvs.length; if (s.captures[r] > qmax) { qmax = s.captures[r]; q = r; } });
    var tw = s.options.capturesToWin;
    score += cd * 1000;
    if (s.captures[p] >= tw - 1) score += 3500; if (s.captures[q] >= tw - 1) score -= 3800;
    return score;
  }

  /* Casillas a considerar: vacías, a distancia <= 2 de alguna ficha, y legales (regla de torneo incluida). */
  function candidates(s) {
    var n = s.size, b = s.board, mark = new Uint8Array(n * n), any = false, out = [], x, y, i, j;
    for (y = 0; y < n; y++) for (x = 0; x < n; x++) {
      if (!b[y * n + x]) continue;
      any = true;
      for (j = -2; j <= 2; j++) for (i = -2; i <= 2; i++) {
        var xx = x + i, yy = y + j;
        if (xx >= 0 && yy >= 0 && xx < n && yy < n && !b[yy * n + xx]) mark[yy * n + xx] = 1;
      }
    }
    if (!any) { var c = (n - 1) / 2; return P.validateMove(s, c, c) ? P.legalMoves(s).slice(0, 1) : [{ x: c, y: c }]; }
    for (i = 0; i < n * n; i++) if (mark[i]) { x = i % n; y = (i - x) / n; if (!P.validateMove(s, x, y)) out.push({ x: x, y: y }); }
    if (!out.length) {                                       // p. ej. 3ª jugada con regla de torneo: lo legal más cerca del centro
      var all = P.legalMoves(s), cc = (n - 1) / 2;
      all.sort(function (m1, m2) { return (Math.max(Math.abs(m1.x - cc), Math.abs(m1.y - cc)) - Math.max(Math.abs(m2.x - cc), Math.abs(m2.y - cc))) || (m1.y - m2.y) || (m1.x - m2.x); });
      out = all.slice(0, 12);
    }
    return out;
  }

  function ordered(s, width, noiseFn) {
    var p = s.current, cs = candidates(s);
    cs.forEach(function (m) { m.q0 = quick(s, m.x, m.y, p); m.q = m.q0 + (noiseFn ? noiseFn() : 0); });
    cs.sort(function (a, b) { return b.q - a.q; });
    return width ? cs.slice(0, width) : cs;
  }

  function chooseMove(state, opts) {
    opts = opts || {};
    var lv = LEVELS[opts.level] || LEVELS.medium, rng = opts.rng || Math.random;
    var budget = opts.timeMs === undefined ? lv.timeMs : opts.timeMs;
    var me = state.current, t0 = Date.now(), aborted = false, nodes = 0;

    var cands = ordered(state, 0, lv.noise ? function () { return (rng() - 0.5) * lv.noise * 2000; } : null);
    if (!cands.length) return null;

    // 1) ¿gano ya? (en "fácil" a veces no lo ve)
    if (rng() < lv.seesWin) {
      var top = cands.slice(0, 40);
      for (var i = 0; i < top.length; i++) { var r0 = P.playMove(state, top[i].x, top[i].y); if (r0.ok && r0.won && r0.state.winner === me) return opts.rank ? { x: top[i].x, y: top[i].y, ranked: [{ x: top[i].x, y: top[i].y, v: WIN }] } : { x: top[i].x, y: top[i].y }; }
    }

    // 2b) todos contra todos: no hay búsqueda a varias jugadas (con tres rivales no sirve el alfa-beta): se elige entre las mejores por nota rápida + cómo queda el tablero
    if (state.ffa && lv.depth > 1) {
      var base = evaluate(state, me), top2 = cands.slice(0, lv.width + 2), bestF = null, bestS = -Infinity, scored = [];
      top2.forEach(function (c) {
        var rr = P.playMove(state, c.x, c.y); if (!rr.ok) return;
        var sc = rr.won ? 1e9 : c.q0 * 0.6 + (evaluate(rr.state, me) - base) * 0.4;
        scored.push([c, sc]);
        if (sc > bestS) { bestS = sc; bestF = c; }
      });
      if (bestF && bestS < 1e8 && lv.vary) { var near = scored.filter(function (e) { return e[1] >= bestS - lv.vary; }); bestF = near[Math.floor(rng() * near.length)][0]; }
      if (bestF) return { x: bestF.x, y: bestF.y };
    }
    // 2) fácil: elige entre las mejores por nota rápida (a veces se equivoca)
    if (lv.depth === 1) {
      // lo obvio no se le escapa: tapar un 4 (o ganar por capturas) casi siempre, y tapar/armar un 3 abierto la mayoría de las veces
      var best0 = cands.reduce(function (a, b) { return b.q0 > a.q0 ? b : a; }, cands[0]);
      if (best0.q0 >= 80000 && rng() < lv.block4) return { x: best0.x, y: best0.y };
      if (best0.q0 >= 1500 && rng() < lv.block3) return { x: best0.x, y: best0.y };
      if (lv.ignoreObvious && best0.q0 >= 1500 && cands.length > 1) {         // si no lo tapó, tampoco lo "elige de casualidad": mira para otro lado
        var others = cands.filter(function (c) { return c !== best0; }).slice(0, lv.slipTop), mo = others[Math.floor(rng() * others.length)];
        return { x: mo.x, y: mo.y };
      }
      var pick = rng() < lv.slipChance ? Math.min(cands.length, lv.slipTop) : Math.min(cands.length, lv.depth === 1 && lv.noise > 1 ? 3 : 2);
      var m = cands[Math.floor(rng() * pick)];
      return { x: m.x, y: m.y };
    }

    // 3) medio / difícil: alfa-beta; en "difícil" con profundización iterativa dentro del tiempo
    function negamax(s, depth, alpha, beta, ply) {
      if ((++nodes & 63) === 0 && budget && Date.now() - t0 > budget) aborted = true;
      if (aborted) return 0;
      if (depth === 0) return evaluate(s, s.current);
      var list = ordered(s, lv.width, null), best = -Infinity;
      if (!list.length) return 0;
      for (var i = 0; i < list.length; i++) {
        var r = P.playMove(s, list[i].x, list[i].y);
        if (!r.ok) continue;
        var v;
        if (r.won) v = (r.state.winner === s.current ? WIN - ply : -WIN + ply);
        else if (r.draw) v = 0;
        else v = -negamax(r.state, depth - 1, -beta, -alpha, ply + 1);
        if (aborted) return 0;
        if (v > best) best = v;
        if (best > alpha) alpha = best;
        if (alpha >= beta) break;
      }
      return best === -Infinity ? 0 : best;
    }

    var rootList = cands.slice(0, lv.width + 4), bestMove = rootList[0], maxDepth = lv.depth, vary = opts.vary !== undefined ? opts.vary : (lv.vary || 0), doneRoot = null, doneBest = -Infinity;
    for (var depth = 1; depth <= maxDepth; depth++) {
      var bestV = -Infinity, bestHere = null, alpha = -Infinity;
      for (var k = 0; k < rootList.length; k++) {
        var mv = rootList[k], r = P.playMove(state, mv.x, mv.y);
        if (!r.ok) continue;
        var v;
        if (r.won) v = WIN;
        else if (r.draw) v = 0;
        else v = -negamax(r.state, depth - 1, -Infinity, vary && alpha > -Infinity ? -(alpha - vary) : -alpha, 1);       // ventana más ancha: las jugadas casi igual de buenas quedan con su valor exacto
        if (aborted) break;
        v += lv.noise ? (rng() - 0.5) * lv.noise * 400 : 0;
        mv.v = v;
        if (v > bestV) { bestV = v; bestHere = mv; }
        if (bestV > alpha) alpha = bestV;
      }
      if (aborted) break;                                   // se acabó el tiempo: vale lo de la profundidad anterior
      if (bestHere) {
        bestMove = bestHere; doneBest = bestV; doneRoot = rootList.filter(function (m) { return m.v !== undefined; }).map(function (m) { return [m, m.v]; });
        rootList.sort(function (a, b) { return (b.v === undefined ? -Infinity : b.v) - (a.v === undefined ? -Infinity : a.v); });   // la mejor primero en la próxima vuelta
      }
      if (bestV >= WIN - 50) break;                         // ya ve una victoria forzada
      if (budget && Date.now() - t0 > budget * 0.6) break;  // no alcanza el tiempo para otra capa
    }
    if (vary && !opts.rank && doneRoot && doneBest < WIN - 50 && doneBest > -WIN + 50) {      // sin victoria ni derrota a la vista: entre las casi mejores, una al azar
      var close = doneRoot.filter(function (e) { return e[1] >= doneBest - vary; });
      if (close.length > 1) bestMove = close[Math.floor(rng() * close.length)][0];
    }
    if (opts.rank) {                                       // para el entrenador: las jugadas con su valor, la mejor primero (las muy peores no tienen valor exacto: solo una cota)
      var ranked = (doneRoot || [[bestMove, 0]]).map(function (e) { return { x: e[0].x, y: e[0].y, v: e[1] }; }).sort(function (a, b) { return b.v - a.v; });
      return { x: ranked[0].x, y: ranked[0].y, ranked: ranked };
    }
    return { x: bestMove.x, y: bestMove.y };
  }

  return { WIN: WIN, chooseMove: chooseMove, evaluate: evaluate, candidates: candidates, LEVELS: LEVELS };
});
