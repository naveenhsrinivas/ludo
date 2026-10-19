import { BASE, FINISH, LAST_TRACK, SAFE_SQUARES, START, TRACK_LENGTH, trackSquare, type Color } from "./board.js";
import { canReroll, capturesAt, currentColor, destination, type GameState } from "./rules.js";

/** How many opponent tokens could reach this square with one roll (1–6). */
function threats(g: GameState, color: Color, square: number): number {
  if (SAFE_SQUARES.has(square)) return 0;
  let n = 0;
  for (const other of g.colors) {
    if (other === color || g.ranking.includes(other)) continue;
    for (const p of g.tokens[other]) {
      const from = trackSquare(other, p);
      if (from === null) continue;
      const gap = (square - from + TRACK_LENGTH) % TRACK_LENGTH;
      // The opponent must still be on the shared track after moving `gap`.
      if (gap >= 1 && gap <= 6 && p + gap <= LAST_TRACK) n++;
    }
    // Tokens leaving base land on their start square.
    if (square === START[other] && g.tokens[other].includes(BASE)) n++;
  }
  return n;
}

/** Score one possible move for the current player; higher is better. */
function score(g: GameState, token: number): number {
  const color = currentColor(g);
  const from = g.tokens[color][token];
  const to = destination(from, g.dice!)!;
  let s = 0;

  if (to === FINISH) s += 120;
  else if (to > LAST_TRACK) s += 60; // safe in the home column

  const caps = capturesAt(g, color, to);
  for (const c of caps) s += 90 + c.from; // knocking out an advanced token hurts more

  if (from === BASE) s += 70;

  const fromSq = trackSquare(color, from);
  const toSq = trackSquare(color, to);
  if (fromSq !== null) s += 25 * threats(g, color, fromSq); // escaping danger
  if (toSq !== null) {
    if (SAFE_SQUARES.has(toSq)) s += 30;
    s -= 45 * threats(g, color, toSq);
  }

  // Prefer moving tokens that are further along, slightly.
  s += Math.max(from, 0) * 0.4;
  return s;
}

/** Pick the token a computer player would move. */
export function chooseMove(g: GameState): number {
  let best = g.movable[0];
  let bestScore = -Infinity;
  for (const t of g.movable) {
    // A little noise so bots don't all play identically.
    const s = score(g, t) + Math.random() * 4;
    if (s > bestScore) [best, bestScore] = [t, s];
  }
  return best;
}

/** Whether a computer player spends a gem on a re-roll. They only do it when they have no move. */
export function wantsReroll(g: GameState): boolean {
  return canReroll(g) && g.movable.length === 0 && Math.random() < 0.6;
}
