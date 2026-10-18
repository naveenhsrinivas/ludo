import { BASE, FINISH, SAFE_SQUARES, trackSquare, type Color } from "./board.js";

export interface Capture {
  color: Color;
  token: number;
  from: number;
}

export interface MoveRecord {
  color: Color;
  token: number;
  from: number;
  to: number;
  captures: Capture[];
}

export interface RollRecord {
  color: Color;
  value: number;
  /** What the roll led to: a move to pick, no possible move, or a third six. */
  outcome: "move" | "no-move" | "three-sixes";
}

export interface GameState {
  /** Colours in play, in turn order. */
  colors: Color[];
  /** Progress of each colour's four tokens (see board.ts). */
  tokens: Record<Color, number[]>;
  /** Index into `colors` of the player whose turn it is. */
  turn: number;
  phase: "roll" | "move" | "over";
  dice: number | null;
  /** Sixes rolled in a row this turn. */
  sixes: number;
  /** Tokens that can move with the current dice. */
  movable: number[];
  /** Colours in the order they finished. */
  ranking: Color[];
  lastRoll: RollRecord | null;
  lastMove: MoveRecord | null;
}

export function newGame(colors: Color[]): GameState {
  const tokens = {} as Record<Color, number[]>;
  for (const c of colors) tokens[c] = [BASE, BASE, BASE, BASE];
  return {
    colors,
    tokens,
    turn: 0,
    phase: "roll",
    dice: null,
    sixes: 0,
    movable: [],
    ranking: [],
    lastRoll: null,
    lastMove: null,
  };
}

export function currentColor(g: GameState): Color {
  return g.colors[g.turn];
}

/** Where a token would land, or null if it can't move. */
export function destination(progress: number, dice: number): number | null {
  if (progress === BASE) return dice === 6 ? 0 : null;
  if (progress === FINISH) return null;
  const to = progress + dice;
  return to <= FINISH ? to : null; // exact roll needed to finish
}

export function legalTokens(g: GameState, color: Color, dice: number): number[] {
  return g.tokens[color].flatMap((p, i) => (destination(p, dice) === null ? [] : [i]));
}

/** Tokens that would be captured by `color` landing on `progress`. */
export function capturesAt(g: GameState, color: Color, progress: number): Capture[] {
  const square = trackSquare(color, progress);
  if (square === null || SAFE_SQUARES.has(square)) return [];
  const caps: Capture[] = [];
  for (const other of g.colors) {
    if (other === color) continue;
    g.tokens[other].forEach((p, token) => {
      if (trackSquare(other, p) === square) caps.push({ color: other, token, from: p });
    });
  }
  return caps;
}

function isDone(g: GameState, color: Color): boolean {
  return g.tokens[color].every((p) => p === FINISH);
}

function nextTurn(g: GameState): void {
  g.dice = null;
  g.movable = [];
  g.sixes = 0;
  g.phase = "roll";
  for (let i = 1; i <= g.colors.length; i++) {
    const t = (g.turn + i) % g.colors.length;
    if (!g.ranking.includes(g.colors[t])) {
      g.turn = t;
      return;
    }
  }
}

/** Apply a dice roll for the current player. Mutates `g`. */
export function applyRoll(g: GameState, value: number): RollRecord {
  if (g.phase !== "roll") throw new Error("Not time to roll");
  const color = currentColor(g);
  g.dice = value;
  g.sixes = value === 6 ? g.sixes + 1 : 0;
  g.lastMove = null;

  let outcome: RollRecord["outcome"];
  if (g.sixes === 3) {
    outcome = "three-sixes";
    nextTurn(g);
  } else {
    g.movable = legalTokens(g, color, value);
    if (g.movable.length) {
      outcome = "move";
      g.phase = "move";
    } else {
      outcome = "no-move";
      nextTurn(g);
    }
  }
  g.lastRoll = { color, value, outcome };
  return g.lastRoll;
}

/** Move one of the current player's tokens by the rolled amount. Mutates `g`. */
export function applyMove(g: GameState, token: number): MoveRecord {
  if (g.phase !== "move" || g.dice === null) throw new Error("Not time to move");
  if (!g.movable.includes(token)) throw new Error("That token can't move");

  const color = currentColor(g);
  const from = g.tokens[color][token];
  const to = destination(from, g.dice)!;
  const captures = capturesAt(g, color, to);

  g.tokens[color][token] = to;
  for (const c of captures) g.tokens[c.color][c.token] = BASE;

  const move: MoveRecord = { color, token, from, to, captures };
  g.lastMove = move;

  if (isDone(g, color)) {
    g.ranking.push(color);
    const left = g.colors.filter((c) => !g.ranking.includes(c));
    if (left.length <= 1) {
      g.ranking.push(...left);
      g.phase = "over";
      g.dice = null;
      g.movable = [];
      return move;
    }
    nextTurn(g);
    return move;
  }

  // A six, a capture or bringing a token home earns another roll.
  const again = g.dice === 6 || captures.length > 0 || to === FINISH;
  if (again) {
    g.phase = "roll";
    g.dice = null;
    g.movable = [];
  } else {
    nextTurn(g);
  }
  return move;
}

/** True when every legal move ends up in the same place (e.g. all tokens still in base). */
export function onlyOneChoice(g: GameState): boolean {
  if (g.phase !== "move") return false;
  const color = currentColor(g);
  const spots = new Set(g.movable.map((t) => g.tokens[color][t]));
  return spots.size === 1;
}
