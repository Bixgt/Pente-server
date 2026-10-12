/*
 * PENTE CORE — lógica pura, sin DOM, sin red.
 * Funciona en navegador (window.PenteCore) y en Node (require).
 * Todas las funciones son puras: playMove devuelve un estado nuevo.
 *
 * Reglas implementadas:
 *  - Tablero 19x19, se juega en las intersecciones.
 *  - Jugador 1 (1) mueve primero, luego alternan.
 *  - Captura: solo PARES. Patrón P O O P en línea (8 direcciones) => se retiran las 2 O.
 *  - Jugar dentro de un par propio flanqueado NO es captura (jugada segura).
 *  - Se capturan solo pares exactos (P O O O P no captura).
 *  - Victoria: 5 o más en línea (H, V, diagonales) o 5 pares capturados.
 *  - Orden de resolución: se colocan la ficha, se resuelven capturas, se evalúa victoria.
 *  - Empate: tablero lleno sin ganador.
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

  function createGame(opts) {
    opts = opts || {};
    var size = opts.size || 19;
    return {
      size: size,
      board: new Array(size * size).fill(EMPTY),
      current: P1,
      captures: { 1: 0, 2: 0 },          // pares capturados por cada jugador
      moves: [],                          // {x,y,player,captured:[{x,y}]}
      lastMove: null,
      status: 'playing',                  // 'playing' | 'won' | 'draw'
      winner: 0,
      winReasons: [],                     // 'line' | 'captures'
      winLine: null,                      // [{x,y}...] si ganó por línea
      options: {
        tournamentRule: opts.tournamentRule !== false,
        capturesToWin: opts.capturesToWin || 5,
        lineToWin: opts.lineToWin || 5,
        exactFive: !!opts.exactFive            // true: solo cuenta una línea de EXACTAMENTE lineToWin
      }
    };
  }

  function inBounds(s, x, y) { return x >= 0 && y >= 0 && x < s.size && y < s.size; }
  function get(s, x, y) { return s.board[y * s.size + x]; }
  function center(s) { return (s.size - 1) / 2; }

  function clone(s) {
    return {
      size: s.size, board: s.board.slice(), current: s.current,
      captures: { 1: s.captures[1], 2: s.captures[2] },
      moves: s.moves.slice(), lastMove: s.lastMove, status: s.status,
      winner: s.winner, winReasons: s.winReasons.slice(), winLine: s.winLine,
      options: { tournamentRule: s.options.tournamentRule, capturesToWin: s.options.capturesToWin, lineToWin: s.options.lineToWin, exactFive: s.options.exactFive }
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

  /** Pares que captura "player" al colocar en (x,y). Se evalúa ANTES de poner la ficha en el tablero lógico
   *  (la ficha nueva es la P de un extremo). Devuelve lista de {x,y}. */
  function findCaptures(s, x, y, player) {
    var opp = opponent(player), out = [];
    for (var i = 0; i < DIRS8.length; i++) {
      var dx = DIRS8[i][0], dy = DIRS8[i][1];
      var x1 = x + dx, y1 = y + dy, x2 = x + 2*dx, y2 = y + 2*dy, x3 = x + 3*dx, y3 = y + 3*dy;
      if (!inBounds(s, x3, y3)) continue;
      if (get(s, x1, y1) === opp && get(s, x2, y2) === opp && get(s, x3, y3) === player) {
        out.push({ x: x1, y: y1 }, { x: x2, y: y2 });
      }
    }
    return out;
  }

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
    var captured = findCaptures(s, x, y, me);   // sobre el tablero previo: la ficha nueva es el extremo
    n.board[y * n.size + x] = me;
    for (var i = 0; i < captured.length; i++) n.board[captured[i].y * n.size + captured[i].x] = EMPTY;
    n.captures[me] += captured.length / 2;
    n.moves.push({ x: x, y: y, player: me, captured: captured });
    n.lastMove = { x: x, y: y, player: me };

    var reasons = [], line = null, winner = 0;
    if (n.captures[me] >= n.options.capturesToWin) reasons.push('captures');
    if (n.options.exactFive) {
      // Solo cuenta una línea de exactamente 5. Se revisa todo el tablero porque una captura
      // puede dejar en 5 una línea de 6 (también del rival).
      line = findExactLine(n, me);
      if (line) reasons.push('line');
      if (!reasons.length) {
        var oppLine = findExactLine(n, opponent(me));
        if (oppLine) { winner = opponent(me); reasons.push('line'); line = oppLine; }
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
      n.current = opponent(me);
    }
    return { ok: true, state: n, captured: captured, won: n.status === 'won', draw: n.status === 'draw' };
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
   * El centro del tablero es K10. Solo definida para el tablero estándar de 19x19. */
  var COLS = 'ABCDEFGHJKLMNOPQRST';
  function coordName(x, y) { return COLS.charAt(x) + (y + 1); }
  function parseCoord(str) {
    var m = /^([A-HJ-T])(\d{1,2})$/i.exec(String(str).trim());
    if (!m) return null;
    var x = COLS.indexOf(m[1].toUpperCase()), y = parseInt(m[2], 10) - 1;
    return (y >= 0 && y < 19) ? { x: x, y: y } : null;
  }

  /** Para el duelo: cuántas victorias hacen falta para ganar un "al mejor de N". */
  function winsNeededForBestOf(n) { return Math.floor(n / 2) + 1; }

  return {
    EMPTY: EMPTY, P1: P1, P2: P2, ERR: ERR,
    createGame: createGame, validateMove: validateMove, playMove: playMove,
    findCaptures: findCaptures, findLine: findLine, legalMoves: legalMoves,
    opponent: opponent, get: get, inBounds: inBounds, center: center,
    winsNeededForBestOf: winsNeededForBestOf,
    COLS: COLS, coordName: coordName, parseCoord: parseCoord
  };
});
