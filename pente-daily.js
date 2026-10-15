/* Desafío diario de Pente. Lógica pura (sin DOM ni red): la usa el servidor para armar la partida del día.
 *   PenteDaily.dayKey(ms)        -> 'AAAA-MM-DD' (día en hora Argentina, UTC-3)
 *   PenteDaily.spec('AAAA-MM-DD') -> { date, n, size, level, setup:[[x,y],...] }   (igual para todos ese día)
 *   PenteDaily.aiRng(date, k)     -> función de azar fija para la jugada k de la IA (así la máquina juega igual para todos)
 * La posición de salida son 8 fichas alternadas (4 y 4) y mueve la persona (negras). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./pente-core.js'));
  else root.PenteDaily = factory(root.PenteCore);
})(typeof self !== 'undefined' ? self : this, function (P) {
  'use strict';
  var SIZE = 13, SETUP_STONES = 8, DAY0 = Date.UTC(2026, 9, 15);       // el #1 es el 15/10/2026
  var LEVEL_BY_DOW = ['hard', 'easy', 'easy', 'medium', 'medium', 'hard', 'hard'];   // domingo..sábado: lunes y martes suaves, fin de semana duro

  function dayKey(ms) { return new Date((ms === undefined ? Date.now() : ms) - 3 * 3600 * 1000).toISOString().slice(0, 10); }
  function dayNumber(key) { var p = key.split('-'); return Math.round((Date.UTC(+p[0], +p[1] - 1, +p[2]) - DAY0) / 86400000) + 1; }
  function hash(str) {                                                  // cadena -> entero de 32 bits (cyrb53 recortado)
    var h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (var i = 0; i < str.length; i++) { var c = str.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    return (h1 ^ (h1 >>> 15)) >>> 0;
  }
  function mulberry(seed) {
    var a = seed >>> 0;
    return function () { a = (a + 0x6D2B79F5) | 0; var t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  function validKey(k) { return typeof k === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(k) && !isNaN(Date.parse(k)); }

  function spec(key) {
    var rng = mulberry(hash('pente-daily:' + key)), lo = 3, hi = SIZE - 4, tries = 0;
    for (;;) {
      tries++;
      var s = P.createGame({ size: SIZE, tournamentRule: false }), setup = [], seen = {}, ok = true;
      while (setup.length < SETUP_STONES) {
        var x = lo + Math.floor(rng() * (hi - lo + 1)), y = lo + Math.floor(rng() * (hi - lo + 1)), k = x + ',' + y;
        if (seen[k]) continue;
        seen[k] = 1;
        var r = P.playMove(s, x, y, s.current);
        if (!r.ok || r.won || r.captured.length) { ok = false; break; }         // sin capturas ni victorias de entrada
        s = r.state; setup.push([x, y]);
      }
      if (ok && s.status === 'playing' && s.current === 1) {
        return { date: key, n: dayNumber(key), size: SIZE, level: LEVEL_BY_DOW[new Date(key + 'T12:00:00Z').getUTCDay()], setup: setup };
      }
      if (tries > 200) throw new Error('daily: no se pudo armar la posición');
    }
  }
  function startState(sp) {                                              // partida lista para jugar desde la posición del día
    var s = P.createGame({ size: sp.size, tournamentRule: false });
    sp.setup.forEach(function (m) { s = P.playMove(s, m[0], m[1], s.current).state; });
    return s;
  }
  function aiRng(key, k) { return mulberry(hash('pente-daily-ai:' + key + ':' + k)); }

  return { dayKey: dayKey, dayNumber: dayNumber, validKey: validKey, spec: spec, startState: startState, aiRng: aiRng, SIZE: SIZE };
});
