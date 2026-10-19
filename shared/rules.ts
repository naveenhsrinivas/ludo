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

/** House rules, chosen by the host before the game. */
export interface GameOptions {
  /** While all your tokens are in base, 6s come up more often (and by the third roll at the latest). */
  easySixes: boolean;
  /** Everyone starts with one token already out of base. */
  quickStart: boolean;
  /** Gems each player gets per game; one gem buys a re-roll. 0 turns gems off. */
  gems: number;
}

export const GEMS_PER_GAME = 5;
export const DEFAULT_OPTIONS: GameOptions = { easySixes: true, quickStart: false, gems: GEMS_PER_GAME };

/** Chance of a 6 while waiting to leave base, with easySixes on (normally 1 in 6). */
export const EASY_SIX_CHANCE = 0.4;
/** With easySixes on, after this many misses in a row the next roll is a 6. */
export const EASY_SIX_GUARANTEE = 2;

export interface GameState {
  options: GameOptions;
  /** Rolls in a row without a 6 while stuck in base (for easySixes). */
  stuck: Record<Color, number>;
  /** Gems left per player. */
  gems: Record<Color, number>;
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
  /** Tokens that can move with the current dice. Empty in the "move" phase means
   *  no move is possible, but the player may spend a gem to re-roll (or pass). */
  movable: number[];
  /** Colours in the order they finished. */
  ranking: Color[];
  lastRoll: RollRecord | null;
  lastMove: MoveRecord | null;
}

export function newGame(colors: Color[], options: GameOptions = DEFAULT_OPTIONS): GameState {
  const tokens = {} as Record<Color, number[]>;
  const stuck = {} as Record<Color, number>;
  const gems = {} as Record<Color, number>;
  for (const c of colors) {
    tokens[c] = [options.quickStart ? 0 : BASE, BASE, BASE, BASE];
    stuck[c] = 0;
    gems[c] = options.gems;
  }
  return {
    options: { ...options },
    stuck,
    gems,
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

/** True when a player can only move by rolling a 6 (no tokens out on the board). */
export function waitingForSix(g: GameState, color: Color): boolean {
  const t = g.tokens[color];
  return t.includes(BASE) && t.every((p) => p === BASE || p === FINISH);
}

/** Roll the dice for the current player, applying the easy-sixes rule. `random` returns [0, 1). */
export function rollValue(g: GameState, random: () => number = Math.random): number {
  const color = currentColor(g);
  if (g.options.easySixes && waitingForSix(g, color)) {
    if (g.stuck[color] >= EASY_SIX_GUARANTEE || random() < EASY_SIX_CHANCE) return 6;
    return 1 + Math.floor(random() * 5);
  }
  return 1 + Math.floor(random() * 6);
}

/** Apply a dice roll for the current player. Mutates `g`. */
export function applyRoll(g: GameState, value: number): RollRecord {
  if (g.phase !== "roll") throw new Error("Not time to roll");
  const color = currentColor(g);
  g.stuck[color] = waitingForSix(g, color) && value !== 6 ? g.stuck[color] + 1 : 0;
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
      // With gems left, the player gets to choose: re-roll or pass.
      if (g.gems[color] > 0) g.phase = "move";
      else nextTurn(g);
    }
  }
  g.lastRoll = { color, value, outcome };
  return g.lastRoll;
}

/** Whether the current player can spend a gem to roll again right now. */
export function canReroll(g: GameState): boolean {
  return g.phase === "move" && g.gems[currentColor(g)] > 0;
}

/** Spend a gem and roll again, replacing the current roll. Mutates `g`. */
export function applyReroll(g: GameState, value: number): RollRecord {
  if (!canReroll(g)) throw new Error("Can't re-roll now");
  const color = currentColor(g);
  g.gems[color]--;
  if (g.dice === 6) g.sixes--; // the replaced six doesn't count towards three in a row
  g.phase = "roll";
  g.movable = [];
  return applyRoll(g, value);
}

/** Give up the turn after a roll with no possible move. Mutates `g`. */
export function applyPass(g: GameState): void {
  if (g.phase !== "move" || g.movable.length) throw new Error("Can't pass now");
  nextTurn(g);
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
