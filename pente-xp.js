/* XP y niveles de Pente. Lógica pura (sin DOM ni red): se prueba en Node.
 * El estado vive dentro de las estadísticas del perfil: stats.xp = { t: XP total, f: [primeras veces], day: 'AAAA-MM-DD', cas: XP "casual" de ese día, dd: último desafío diario premiado }.
 * OJO: lo informa el navegador, así que sirve para motivar y para destrabar premios, no para competir. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PenteXP = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var MAX_LEVEL = 60, MIN_MOVES = 10, CASUAL_CAP = 50, CAP = 10000000;
  var TITLE_AT = [1, 4, 8, 13, 19, 26, 34, 43];                       // nivel desde el que rige cada título (xp.title.1 ... xp.title.8)
  var GEM_LEVEL = { oro: 6, neon: 9, coral: 12, obsidiana: 16, galaxia: 22 };                    // las 9 piedras de siempre son libres
  // Personalizar avatar: nivel desde el que se puede elegir cada pieza (lo que no figura es libre desde el nivel 1)
  var PART_LEVEL = {
    face: { enfadado: 3, sorprendido: 6, pensando: 10, seguro: 15 },
    color: { dorado: 2, verde: 4, rojo: 8, gris: 14, negro: 19, morado: 60 },
    hair: { pinchudo: 5, raya: 7, melena: 9, gorro: 11, vincha: 13, despeinado: 15, cortina: 17, colita: 19, rodetes: 22, gorraAtras: 25 },
    hairColor: { pelirrojo: 3, gris: 9, rosa: 12, azul: 16, violeta: 21, verde: 26, blanco: 32 }
  };
  var FIRSTS = { tutorial: 50, daily: 25 };                          // premio por única vez; 'mode:<modo>' vale 20

  function num(v) { v = Math.floor(Number(v)); return isFinite(v) && v > 0 ? Math.min(v, CAP) : 0; }
  function need(level) { return 90 + 10 * level; }                    // XP para pasar del nivel `level` al siguiente (100, 110, 120...)
  function cumulative(level) { var s = 0; for (var l = 1; l < level; l++) s += need(l); return s; }   // XP total con la que se llega a ese nivel
  function levelOf(total) {
    total = num(total); var l = 1, left = total;
    while (l < MAX_LEVEL && left >= need(l)) { left -= need(l); l++; }
    var max = l >= MAX_LEVEL, n = need(l);
    return { level: l, into: max ? 0 : left, need: max ? 0 : n, pct: max ? 100 : Math.round(100 * left / n), max: max, total: total };
  }
  function titleIndex(level) { var k = 1; TITLE_AT.forEach(function (lv, i) { if (level >= lv) k = i + 1; }); return k; }
  function validFirst(s) { return typeof s === 'string' && (FIRSTS[s] != null || /^mode:[a-z0-9]{1,12}$/.test(s)); }
  function validDay(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ''; }
  function clean(x) {
    x = x && typeof x === 'object' ? x : {};
    var f = Array.isArray(x.f) ? x.f.filter(validFirst) : [], seen = {};
    f = f.filter(function (k) { if (seen[k]) return false; seen[k] = 1; return true; }).sort().slice(0, 40);
    return { t: num(x.t), f: f, day: validDay(x.day), cas: Math.min(num(x.cas), CASUAL_CAP), dd: validDay(x.dd) };
  }
  function merge(local, base, remote) {                               // como los contadores: lo nuevo de la nube + lo que ESTE aparato sumó desde la última sincronización
    var l = clean(local), b = clean(base), r = clean(remote), o = {};
    o.t = num(r.t + Math.max(0, l.t - b.t));
    o.f = clean({ f: r.f.concat(l.f) }).f;
    var ld = l.day, rd = r.day;
    if (ld && ld >= rd) { o.day = ld; o.cas = ld === rd ? Math.max(l.cas, r.cas) : l.cas; } else { o.day = rd; o.cas = r.cas; }
    o.dd = l.dd > r.dd ? l.dd : r.dd;
    return clean(o);
  }
  function unlocksAt(level) {                                         // premios que se destraban justo en ese nivel
    var out = [];
    Object.keys(GEM_LEVEL).forEach(function (id) { if (GEM_LEVEL[id] === level) out.push({ type: 'gem', id: id }); });
    return out;
  }
  function nextUnlock(level) {                                        // el próximo premio por destrabar (para mostrarlo en el perfil)
    var best = null;
    Object.keys(PART_LEVEL).forEach(function (k) { Object.keys(PART_LEVEL[k]).forEach(function (id) { var lv = PART_LEVEL[k][id]; if (lv > level && (!best || lv < best.level)) best = { type: 'part', kind: k, id: id, level: lv }; }); });
    Object.keys(GEM_LEVEL).forEach(function (id) { var lv = GEM_LEVEL[id]; if (lv > level && (!best || lv < best.level)) best = { type: 'gem', id: id, level: lv }; });
    return best;
  }
  function partLevel(kind, id) { return (PART_LEVEL[kind] && PART_LEVEL[kind][id]) || 1; }
  function partOk(kind, id, level) { return level >= partLevel(kind, id); }
  function partsAt(level) {                                          // piezas de personaje que se destraban justo en ese nivel
    var out = []; Object.keys(PART_LEVEL).forEach(function (k) { Object.keys(PART_LEVEL[k]).forEach(function (id) { if (PART_LEVEL[k][id] === level) out.push({ kind: k, id: id }); }); }); return out;
  }
  function gemOk(id, level) { return !GEM_LEVEL[id] || level >= GEM_LEVEL[id]; }

  /* ev: { k:'daily', win, moves, streak, date } | { k:'online'|'ai'|'local', win, draw, moves, mode } | { k:'first', id }
   * today: 'AAAA-MM-DD' (para el tope diario). Devuelve { xp (nuevo estado), gained, parts:[{k,n}], from, to, ups, unlocked:[{type,id,level}] } */
  /* Evento: viernes y sábado se gana el doble de XP al jugar (partidas y desafío; los premios por única vez no se duplican). `today` es 'AAAA-MM-DD'. */
  function eventMult(today) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(today || ''); if (!m) return 1;
    var wd = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay();   // 0 = domingo ... 5 = viernes, 6 = sábado
    return wd === 5 || wd === 6 ? 2 : 1;
  }
  function award(xp, ev, today) {
    var s = clean(xp), parts = [], cas = false, ms = ev.moves || 0, mult = eventMult(today);
    function add(k, n, casual) { if (n > 0) { var once = k.indexOf('first:') === 0; parts.push({ k: k, n: once ? n : n * mult, casual: !!casual, x2: !once && mult > 1 }); } }
    function first(id) { if (validFirst(id) && s.f.indexOf(id) < 0) { s.f.push(id); add('first:' + id, id.indexOf('mode:') === 0 ? 20 : FIRSTS[id]); } }
    if (s.day !== today) { s.day = today; s.cas = 0; }
    if (ev.k === 'daily') {
      if (s.dd !== ev.date && ms >= 3) {
        s.dd = ev.date; add('daily', 30); if (ev.win) add('win', 30);
        var st = Math.max(0, Math.min(7, ev.streak || 0)); if (st > 1) add('streak', 5 * st);
        first('daily');
      }
    } else if (ev.k === 'online' || ev.k === 'ai' || ev.k === 'local') {
      if (ms >= MIN_MOVES) {
        if (ev.k === 'online') { add('played', 20); if (ev.win) add('win', 20); }
        else {                                                        // contra la máquina o en el mismo aparato: con tope diario para que no se pueda farmear
          var room = Math.max(0, CASUAL_CAP - s.cas), played = 5, won = ev.k === 'ai' && ev.win ? 5 : 0, g1 = Math.min(played, room), g2 = Math.min(won, room - g1);
          add('played', g1, true); add('win', g2, true); s.cas += g1 + g2;                                      // el tope se cuenta en XP "base": en el evento el tope en pantalla también se duplica
        }
        if (ev.mode) first('mode:' + ev.mode);
      }
    } else if (ev.k === 'first') first(ev.id);
    var gained = parts.reduce(function (a, p) { return a + p.n; }, 0), from = levelOf(s.t), t1 = num(s.t + gained), to = levelOf(t1);
    s.t = t1;
    var unlocked = []; for (var l = from.level + 1; l <= to.level; l++) {
      unlocksAt(l).forEach(function (u) { unlocked.push({ type: u.type, id: u.id, level: l }); });
      var pa = partsAt(l); if (pa.length) unlocked.push({ type: 'parts', n: pa.length, level: l });
    }
    return { xp: clean(s), gained: gained, parts: parts, from: from, to: to, ups: to.level - from.level, unlocked: unlocked };
  }

  /* Lo que reconoce el SERVIDOR (verificado): desafío diario terminado y partida online entre dos cuentas. Mismos números que award(). */
  var ONLINE_DAILY_CAP = 10;                                          // partidas online por día que dan XP verificado (evita que dos amigos se regalen XP)
  function dailyGain(win, streak, firstTime, day) {
    var n = 30 + (win ? 30 : 0), st = Math.max(0, Math.min(7, streak || 0)); if (st > 1) n += 5 * st; n *= eventMult(day); if (firstTime) n += FIRSTS.daily; return n;
  }
  function onlineGain(win, day) { return (20 + (win ? 20 : 0)) * eventMult(day); }

  return { ONLINE_DAILY_CAP: ONLINE_DAILY_CAP, dailyGain: dailyGain, onlineGain: onlineGain, MAX_LEVEL: MAX_LEVEL, MIN_MOVES: MIN_MOVES, CASUAL_CAP: CASUAL_CAP, GEM_LEVEL: GEM_LEVEL, need: need, cumulative: cumulative, levelOf: levelOf, titleIndex: titleIndex,
    clean: clean, merge: merge, unlocksAt: unlocksAt, nextUnlock: nextUnlock, PART_LEVEL: PART_LEVEL, partLevel: partLevel, partOk: partOk, partsAt: partsAt, gemOk: gemOk, award: award, eventMult: eventMult };
});
