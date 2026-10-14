/*
 * PENTE CORE — lógica pura, sin DOM, sin red.
 * Funciona en navegador (window.PenteCore) y en Node (require).
 * Todas las funciones son puras: playMove devuelve un estado nuevo.
 *
 * Reglas implementadas:
 *  - Tablero 19x19 (o 13x13 con opts.size), se juega en las intersecciones.
 *  - Jugador 1 (1) mueve primero, luego alternan.
 *  - Captura: solo PARES. Patrón P O O P en línea (8 direcciones) => se retiran las 2 O.
 *  - Jugar dentro de un par propio flanqueado NO es captura (jugada segura).
 *  - Se capturan solo pares exactos (P O O O P no captura).
 *  - Victoria: 5 o más en línea (H, V, diagonales) o 5 pares capturados.
 *  - Orden de resolución: se colocan la ficha, se resuelven capturas, se evalúa victoria.
 *  - Empate: tablero lleno sin ganador.
 *  - Modo 4 jugadores (opts.players = 4): 2 contra 2. Asientos 1,2,3,4 juegan en ese orden; 1 y 3 son el equipo 1, 2 y 4 el equipo 2.
 *    Las fichas, capturas y victorias son POR EQUIPO (las fichas del equipo nunca se capturan entre sí). `current` sigue siendo el
 *    equipo (1|2), así todo lo que ya existe para 2 jugadores sigue valiendo; `seatToMove(s)` dice qué asiento (1-4) le toca.
 *  - Variantes (opts.variant): 'classic' (por defecto; solo pares), 'pairs3' (se capturan pares Y tríos; par = 1 punto, trío = 2; gana con 5 puntos),
 *    'triples' (solo tríos: P O O O P; cada trío = 1 punto; gana con 3), 'gomoku' (sin capturas, sin regla de torneo; gana con 5 o más en línea).
 *    `captures[p]` cuenta PUNTOS de captura; `options.capturesToWin` es el objetivo. Blitz no es una regla del tablero: es solo cómo corre el reloj (lo maneja quien juega).
 *  - Todos contra todos (opts.players = 4 y opts.ffa = true): 4 colores (1..4), cada asiento es su propio "equipo": `current` es el asiento al que le toca (1,2,3,4 y vuelta),
 *    las capturas se llevan por asiento, un par/trío se captura si son del MISMO color rival y sus dos extremos son tuyos. Sin regla de torneo. Quien abandona o se queda sin tiempo
 *    queda ELIMINADO (`eliminate`): sus fichas quedan en el tablero y se saltea su turno; si queda uno solo, gana (winReasons ['last']).
 *  - Regla de torneo (opcional, activada por defecto): la 1ª ficha del J1 va al centro y la
 *    2ª ficha del J1 debe estar a distancia >= 3 del centro (Chebyshev: fuera del cuadrado 5x5).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PenteCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var EMPTY = 0, P1 = 1, P2 = 2;
  var DIRS8 = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,-1],[1,-1],[-1,1]];
  var AXES = [[1,0],[0,1],[1,1],[1,-1]];

  var ERR = {
    GAME_OVER: 'GAME_OVER',
    OUT_OF_BOUNDS: 'OUT_OF_BOUNDS',
    OCCUPIED: 'OCCUPIED',
    NOT_YOUR_TURN: 'NOT_YOUR_TURN',
    MUST_PLAY_CENTER: 'MUST_PLAY_CENTER',
    TOO_CLOSE_TO_CENTER: 'TOO_CLOSE_TO_CENTER',
    INVALID_COORDS: 'INVALID_COORDS'
  };

  function opponent(p) { return p === P1 ? P2 : P1; }

  var VARIANTS = ['classic', 'pairs3', 'triples', 'gomoku'];
  // qué largos de grupo se capturan, cuántos puntos vale cada uno y cuántos puntos hacen falta para ganar
  var VARIANT_RULES = {
    classic: { sizes: [2], pts: { 2: 1 }, toWin: 5 },
    pairs3:  { sizes: [2, 3], pts: { 2: 1, 3: 2 }, toWin: 5 },
    triples: { sizes: [3], pts: { 3: 1 }, toWin: 3 },
    gomoku:  { sizes: [], pts: {}, toWin: 999 }
  };
  function rulesOf(s) { var v = s && s.options && s.options.variant; return VARIANT_RULES[v] || VARIANT_RULES.classic; }

  function createGame(opts) {
    opts = opts || {};
    var size = opts.size || 19;
    var ffa = opts.players === 4 && opts.ffa === true;
    var variant = VARIANTS.indexOf(opts.variant) >= 0 ? opts.variant : 'classic', vr = VARIANT_RULES[variant];
    return {
      players: opts.players === 4 ? 4 : 2,
      ffa: ffa,                           // todos contra todos (4 colores)
      out: {},                            // asientos eliminados (solo ffa)
      size: size,
      board: new Array(size * size).fill(EMPTY),
      current: P1,
      captures: ffa ? { 1: 0, 2: 0, 3: 0, 4: 0 } : { 1: 0, 2: 0 },          // puntos de captura de cada jugador
      moves: [],                          // {x,y,player,captured:[{x,y}]}
      lastMove: null,
      status: 'playing',                  // 'playing' | 'won' | 'draw'
      winner: 0,
      winReasons: [],                     // 'line' | 'captures'
      winLine: null,                      // [{x,y}...] si ganó por línea
      options: {
        variant: variant,
        tournamentRule: (variant === 'gomoku' || ffa) ? false : opts.tournamentRule !== false,
        capturesToWin: opts.capturesToWin || vr.toWin,
        lineToWin: opts.lineToWin || 5,
        exactFive: variant === 'gomoku' ? false : !!opts.exactFive            // true: solo cuenta una línea de EXACTAMENTE lineToWin
      }
    };
  }

  function inBounds(s, x, y) { return x >= 0 && y >= 0 && x < s.size && y < s.size; }
  function get(s, x, y) { return s.board[y * s.size + x]; }
  function center(s) { return (s.size - 1) / 2; }

  function clone(s) {
    return {
      players: s.players, ffa: !!s.ffa, out: Object.assign({}, s.out), size: s.size, board: s.board.slice(), current: s.current,
      captures: Object.assign({}, s.captures),
      moves: s.moves.slice(), lastMove: s.lastMove, status: s.status,
      winner: s.winner, winReasons: s.winReasons.slice(), winLine: s.winLine,
      options: { variant: s.options.variant, tournamentRule: s.options.tournamentRule, capturesToWin: s.options.capturesToWin, lineToWin: s.options.lineToWin, exactFive: s.options.exactFive }
    };
  }

  /** Valida una jugada sin ejecutarla. Devuelve null si es legal, o un código de error. */
  function validateMove(s, x, y, player) {
    if (!Number.isInteger(x) || !Number.isInteger(y)) return ERR.INVALID_COORDS;
    if (s.status !== 'playing') return ERR.GAME_OVER;
    if (player !== undefined && player !== s.current) return ERR.NOT_YOUR_TURN;
    if (!inBounds(s, x, y)) return ERR.OUT_OF_BOUNDS;
    if (get(s, x, y) !== EMPTY) return ERR.OCCUPIED;
    if (s.options.tournamentRule && s.size % 2 === 1) {
      var c = center(s), n = s.moves.length;
      if (n === 0 && (x !== c || y !== c)) return ERR.MUST_PLAY_CENTER;
      if (n === 2 && Math.max(Math.abs(x - c), Math.abs(y - c)) < 3) return ERR.TOO_CLOSE_TO_CENTER;
    }
    return null;
  }

  /** Grupos que captura "player" al colocar en (x,y). Se evalúa ANTES de poner la ficha en el tablero lógico
   *  (la ficha nueva es la P de un extremo). Devuelve {cells:[{x,y}...], points} según la variante. */
  function captureInfo(s, x, y, player) {
    var vr = rulesOf(s), cells = [], points = 0;
    for (var i = 0; i < DIRS8.length; i++) {
      var dx = DIRS8[i][0], dy = DIRS8[i][1], o = null;
      for (var k = 0; k < vr.sizes.length; k++) {
        var n = vr.sizes[k], ex = x + (n + 1) * dx, ey = y + (n + 1) * dy;
        if (!inBounds(s, ex, ey) || get(s, ex, ey) !== player) continue;
        o = get(s, x + dx, y + dy);
        if (!o || o === player) continue;                           // el grupo es de UN solo color rival (en ffa hay tres posibles)
        var ok = true;
        for (var j = 2; j <= n; j++) if (get(s, x + j * dx, y + j * dy) !== o) { ok = false; break; }
        if (!ok) continue;
        for (j = 1; j <= n; j++) cells.push({ x: x + j * dx, y: y + j * dy, p: o });
        points += vr.pts[n];
      }
    }
    return { cells: cells, points: points };
  }
  function findCaptures(s, x, y, player) { return captureInfo(s, x, y, player).cells; }

  /** Línea de >= lineToWin fichas de "player" que pasa por (x,y). Devuelve array de celdas o null. */
  function findLine(s, x, y, player) {
    var best = null;
    for (var a = 0; a < AXES.length; a++) {
      var dx = AXES[a][0], dy = AXES[a][1];
      var cells = [{ x: x, y: y }];
      var cx = x + dx, cy = y + dy;
      while (inBounds(s, cx, cy) && get(s, cx, cy) === player) { cells.push({ x: cx, y: cy }); cx += dx; cy += dy; }
      cx = x - dx; cy = y - dy;
      while (inBounds(s, cx, cy) && get(s, cx, cy) === player) { cells.unshift({ x: cx, y: cy }); cx -= dx; cy -= dy; }
      if (cells.length >= s.options.lineToWin && (!best || cells.length > best.length)) best = cells;
    }
    return best;
  }

  /** Modo exactFive: busca en todo el tablero una racha de EXACTAMENTE lineToWin fichas de "player". */
  function findExactLine(s, player) {
    for (var a = 0; a < AXES.length; a++) {
      var dx = AXES[a][0], dy = AXES[a][1];
      for (var y = 0; y < s.size; y++) for (var x = 0; x < s.size; x++) {
        if (get(s, x, y) !== player) continue;
        var px = x - dx, py = y - dy;
        if (inBounds(s, px, py) && get(s, px, py) === player) continue;   // no es inicio de racha
        var cells = [], cx = x, cy = y;
        while (inBounds(s, cx, cy) && get(s, cx, cy) === player) { cells.push({ x: cx, y: cy }); cx += dx; cy += dy; }
        if (cells.length === s.options.lineToWin) return cells;
      }
    }
    return null;
  }

  /** Ejecuta una jugada. Devuelve {ok:true,state,captured,...} o {ok:false,error}. No muta el estado recibido. */
  function playMove(s, x, y, player) {
    var err = validateMove(s, x, y, player);
    if (err) return { ok: false, error: err };

    var n = clone(s), me = s.current;
    var info = captureInfo(s, x, y, me), captured = info.cells;   // sobre el tablero previo: la ficha nueva es el extremo
    n.board[y * n.size + x] = me;
    for (var i = 0; i < captured.length; i++) n.board[captured[i].y * n.size + captured[i].x] = EMPTY;
    n.captures[me] += info.points;
    n.moves.push({ x: x, y: y, player: me, seat: seatToMove(s), captured: captured });
    n.lastMove = { x: x, y: y, player: me };

    var reasons = [], line = null, winner = 0;
    if (n.captures[me] >= n.options.capturesToWin) reasons.push('captures');
    if (n.options.exactFive) {
      // Solo cuenta una línea de exactamente 5. Se revisa todo el tablero porque una captura
      // puede dejar en 5 una línea de 6 (también del rival).
      line = findExactLine(n, me);
      if (line) reasons.push('line');
      if (!reasons.length) {
        for (var q = 1; q <= (n.ffa ? 4 : 2) && !winner; q++) {
          if (q === me || (n.ffa && n.out[q])) continue;
          var oppLine = findExactLine(n, q);
          if (oppLine) { winner = q; reasons.push('line'); line = oppLine; }
        }
      }
    } else {
      line = findLine(n, x, y, me);
      if (line) reasons.push('line');
    }

    if (reasons.length) {
      n.status = 'won'; n.winner = winner || me; n.winReasons = reasons; n.winLine = line;
    } else if (isBoardFull(n)) {
      n.status = 'draw';   // tablero lleno sin ganador
    } else {
      n.current = n.ffa ? nextActive(n, me) : opponent(me);
    }
    return { ok: true, state: n, captured: captured, won: n.status === 'won', draw: n.status === 'draw' };
  }

  function nextActive(s, from) { for (var i = 1; i <= 4; i++) { var q = ((from - 1 + i) % 4) + 1; if (!s.out[q]) return q; } return from; }
  /** Asiento (1..players) al que le toca jugar. En 2 jugadores coincide con el equipo; en todos contra todos es `current`. */
  function seatToMove(s) { return s.ffa ? s.current : (s.moves.length % (s.players || 2)) + 1; }
  /** Todos contra todos: saca a un asiento (abandono / tiempo). Si queda uno solo, gana. */
  function eliminate(s, seat) {
    if (!s.ffa || s.status !== 'playing' || seat < 1 || seat > 4 || s.out[seat]) return { ok: false, error: ERR.GAME_OVER };
    var n = clone(s); n.out[seat] = true;
    var left = [1, 2, 3, 4].filter(function (q) { return !n.out[q]; });
    if (left.length === 1) { n.status = 'won'; n.winner = left[0]; n.winReasons = ['last']; n.winLine = null; }
    else if (n.current === seat) n.current = nextActive(n, seat);
    return { ok: true, state: n };
  }
  /** Equipo (1|2) de un asiento: 1 y 3 -> equipo 1; 2 y 4 -> equipo 2. */
  function teamOfSeat(seat, s) { return s && s.ffa ? seat : seat % 2 === 1 ? P1 : P2; }
  /** Asientos de un equipo (en 2 jugadores, el propio asiento). */
  function seatsOfTeam(s, team) { return s.ffa ? [team] : (s.players || 2) === 4 ? (team === P1 ? [1, 3] : [2, 4]) : [team]; }
  /** Como playMove pero identificando al jugador por ASIENTO (1..players): valida que le toque a ese asiento y no solo a su equipo. */
  function playMoveSeat(s, x, y, seat) {
    if (s.status === 'playing' && seat !== seatToMove(s)) return { ok: false, error: ERR.NOT_YOUR_TURN };
    return playMove(s, x, y, teamOfSeat(seat, s));
  }

  function isBoardFull(s) { for (var i = 0; i < s.board.length; i++) if (s.board[i] === EMPTY) return false; return true; }

  /** Lista de jugadas legales para el jugador en turno (útil para IA y tests). */
  function legalMoves(s) {
    var out = [];
    if (s.status !== 'playing') return out;
    for (var y = 0; y < s.size; y++) for (var x = 0; x < s.size; x++) if (!validateMove(s, x, y)) out.push({ x: x, y: y });
    return out;
  }

  /* Notación de coordenadas: columnas A–T SIN la I (evita confundirla con el 1), filas 1–19 de arriba hacia abajo.
   * Las letras se cuentan desde la izquierda: en 19x19 el centro es K10; en 13x13 las columnas llegan hasta la N y el centro es G7. */
  var COLS = 'ABCDEFGHJKLMNOPQRST';
  function coordName(x, y) { return COLS.charAt(x) + (y + 1); }
  function parseCoord(str, size) {
    size = size || 19;
    var m = /^([A-HJ-T])(\d{1,2})$/i.exec(String(str).trim());
    if (!m) return null;
    var x = COLS.indexOf(m[1].toUpperCase()), y = parseInt(m[2], 10) - 1;
    return (x < size && y >= 0 && y < size) ? { x: x, y: y } : null;
  }

  /** Para el duelo: cuántas victorias hacen falta para ganar un "al mejor de N". */
  function winsNeededForBestOf(n) { return Math.floor(n / 2) + 1; }

  return {
    EMPTY: EMPTY, P1: P1, P2: P2, ERR: ERR,
    createGame: createGame, validateMove: validateMove, playMove: playMove, playMoveSeat: playMoveSeat,
    seatToMove: seatToMove, eliminate: eliminate, nextActive: nextActive, teamOfSeat: teamOfSeat, seatsOfTeam: seatsOfTeam,
    findCaptures: findCaptures, captureInfo: captureInfo, VARIANTS: VARIANTS, VARIANT_RULES: VARIANT_RULES, findLine: findLine, legalMoves: legalMoves,
    opponent: opponent, get: get, inBounds: inBounds, center: center,
    winsNeededForBestOf: winsNeededForBestOf,
    COLS: COLS, coordName: coordName, parseCoord: parseCoord
  };
});
