import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, FINISH, HOME_COLUMN, SAFE_SQUARES, START, TRACK, trackSquare, type Color } from "./board.js";
import { chooseMove, wantsReroll } from "./bot.js";
import {
  applyMove,
  applyPass,
  applyReroll,
  applyRoll,
  canReroll,
  currentColor,
  DEFAULT_OPTIONS,
  EASY_SIX_GUARANTEE,
  newGame,
  rollValue,
  type GameState,
} from "./rules.js";

/** A game with gems off, so a roll with no moves passes the turn straight away. */
function game(colors: Color[] = ["red", "yellow"]): GameState {
  return newGame(colors, { ...DEFAULT_OPTIONS, gems: 0 });
}

test("board has 52 distinct track squares and well-placed starts", () => {
  assert.equal(TRACK.length, 52);
  assert.equal(new Set(TRACK.map(([c, r]) => `${c},${r}`)).size, 52);
  // Each step on the track is to a neighbouring square (including the four diagonal corners).
  TRACK.forEach(([c, r], i) => {
    const [c2, r2] = TRACK[(i + 1) % 52];
    assert.ok(Math.abs(c - c2) <= 1 && Math.abs(r - r2) <= 1, `gap after square ${i}`);
  });
  assert.deepEqual(TRACK[START.red], [1, 6]);
  assert.deepEqual(TRACK[START.green], [8, 1]);
  assert.deepEqual(TRACK[START.yellow], [13, 8]);
  assert.deepEqual(TRACK[START.blue], [6, 13]);
  // The last track square of each colour sits next to its home column.
  for (const color of ["red", "green", "yellow", "blue"] as const) {
    const [c, r] = TRACK[trackSquare(color, 50)!];
    const [hc, hr] = HOME_COLUMN[color][0];
    assert.equal(Math.abs(c - hc) + Math.abs(r - hr), 1, color);
  }
});

test("a token needs a six to leave base", () => {
  const g = game();
  assert.equal(applyRoll(g, 5).outcome, "no-move");
  assert.equal(currentColor(g), "yellow");
  assert.equal(applyRoll(g, 6).outcome, "move");
  applyMove(g, 0);
  assert.equal(g.tokens.yellow[0], 0);
  assert.equal(currentColor(g), "yellow", "a six earns another roll");
  assert.equal(g.phase, "roll");
});

test("an exact roll is needed to finish", () => {
  const g = game();
  g.tokens.red = [53, BASE, BASE, BASE];
  assert.equal(applyRoll(g, 4).outcome, "no-move");
  g.turn = 0;
  applyRoll(g, 3);
  applyMove(g, 0);
  assert.equal(g.tokens.red[0], FINISH);
  assert.equal(currentColor(g), "red", "finishing a token earns another roll");
});

test("landing on an opponent sends it home and earns another roll", () => {
  const g = game();
  g.tokens.red = [10, BASE, BASE, BASE];
  // Yellow token on the square red will land on (red progress 12 → square 12).
  const yellowProgress = (12 - START.yellow + 52) % 52;
  g.tokens.yellow = [yellowProgress, BASE, BASE, BASE];
  applyRoll(g, 2);
  const m = applyMove(g, 0);
  assert.equal(m.captures.length, 1);
  assert.equal(g.tokens.yellow[0], BASE);
  assert.equal(currentColor(g), "red");
});

test("tokens on safe squares can't be captured", () => {
  const g = game();
  const star = 8;
  assert.ok(SAFE_SQUARES.has(star));
  g.tokens.red = [star - 3, BASE, BASE, BASE];
  g.tokens.yellow = [(star - START.yellow + 52) % 52, BASE, BASE, BASE];
  applyRoll(g, 3);
  const m = applyMove(g, 0);
  assert.equal(m.captures.length, 0);
  assert.notEqual(g.tokens.yellow[0], BASE);
  assert.equal(currentColor(g), "yellow");
});

test("three sixes in a row lose the turn", () => {
  const g = game();
  g.tokens.red = [5, BASE, BASE, BASE];
  applyRoll(g, 6);
  applyMove(g, 0);
  applyRoll(g, 6);
  applyMove(g, 0);
  assert.equal(applyRoll(g, 6).outcome, "three-sixes");
  assert.equal(currentColor(g), "yellow");
  assert.equal(g.tokens.red[0], 17, "the third six isn't moved");
});

test("players who finish leave the turn order; the game ends with a full ranking", () => {
  const g = game(["red", "green", "yellow"]);
  g.tokens.red = [FINISH, FINISH, FINISH, 55];
  applyRoll(g, 1);
  applyMove(g, 3);
  assert.deepEqual(g.ranking, ["red"]);
  assert.equal(currentColor(g), "green");
  g.tokens.green = [FINISH, FINISH, FINISH, 50];
  applyRoll(g, 6);
  applyMove(g, 3);
  assert.equal(g.phase, "over");
  assert.deepEqual(g.ranking, ["red", "green", "yellow"]);
});

test("600 computer-only games always finish and never break the rules", () => {
  for (let n = 0; n < 600; n++) {
    const colors = (["red", "green", "yellow", "blue"] as const).slice(0, 2 + (n % 3));
    const g = newGame([...colors]);
    let actions = 0;
    while (g.phase !== "over") {
      assert.ok(++actions < 20_000, "game should finish");
      if (g.phase === "roll") applyRoll(g, rollValue(g));
      else if (wantsReroll(g)) applyReroll(g, rollValue(g));
      else if (!g.movable.length) applyPass(g);
      else applyMove(g, chooseMove(g));

      // Invariants: progress in range, and no two colours share an unsafe track square.
      const seen = new Map<number, Color>();
      for (const c of g.colors) {
        for (const p of g.tokens[c]) {
          assert.ok(p >= BASE && p <= FINISH);
          const sq = trackSquare(c, p);
          if (sq === null || SAFE_SQUARES.has(sq)) continue;
          const other = seen.get(sq);
          assert.ok(!other || other === c, `${c} and ${other} share square ${sq}`);
          seen.set(sq, c);
        }
      }
    }
    assert.equal(g.ranking.length, colors.length);
    assert.equal(new Set(g.ranking).size, colors.length);
  }
});

test("easy sixes: a 6 is likelier while stuck in base, and guaranteed by the third roll", () => {
  const g = newGame(["red", "yellow"]);
  let sixes = 0;
  const N = 20_000;
  for (let i = 0; i < N; i++) if (rollValue(g) === 6) sixes++;
  assert.ok(sixes / N > 0.35 && sixes / N < 0.45, `six rate ${sixes / N}`);

  // Two misses in a row, then the next roll must be a 6.
  const h = game();
  applyRoll(h, 3); // red misses, turn passes
  applyRoll(h, 2); // yellow
  applyRoll(h, 4); // red misses again
  applyRoll(h, 1); // yellow
  assert.equal(h.stuck.red, EASY_SIX_GUARANTEE);
  assert.equal(rollValue(h, () => 0.99), 6);
  applyRoll(h, 6);
  assert.equal(h.stuck.red, 0);
});

test("easy sixes only applies while every token is in base; normal dice otherwise", () => {
  const g = newGame(["red", "yellow"]);
  g.tokens.red = [10, BASE, BASE, BASE];
  let sixes = 0;
  for (let i = 0; i < 12_000; i++) if (rollValue(g) === 6) sixes++;
  assert.ok(Math.abs(sixes / 12_000 - 1 / 6) < 0.025, `six rate ${sixes / 12_000}`);

  const off = newGame(["red", "yellow"], { ...DEFAULT_OPTIONS, easySixes: false });
  sixes = 0;
  for (let i = 0; i < 12_000; i++) if (rollValue(off) === 6) sixes++;
  assert.ok(Math.abs(sixes / 12_000 - 1 / 6) < 0.025);
});

test("quick start puts one token of each colour on its start square", () => {
  const g = newGame(["red", "green", "yellow"], { ...DEFAULT_OPTIONS, quickStart: true });
  for (const c of g.colors) assert.deepEqual(g.tokens[c], [0, BASE, BASE, BASE]);
});

test("gems: re-roll a roll you don't like, or after a roll with no moves", () => {
  const g = newGame(["red", "yellow"]);
  assert.equal(g.gems.red, 5);

  // No moves, but gems left: the player gets to choose instead of losing the turn.
  assert.equal(applyRoll(g, 3).outcome, "no-move");
  assert.equal(currentColor(g), "red");
  assert.ok(canReroll(g));
  applyReroll(g, 6);
  assert.equal(g.gems.red, 4);
  assert.deepEqual(g.movable, [0, 1, 2, 3]);

  // Re-roll a legal but unwanted roll.
  applyMove(g, 0);
  applyRoll(g, 1);
  applyReroll(g, 5);
  assert.equal(g.gems.red, 3);
  assert.equal(g.dice, 5);
  applyMove(g, 0);
  assert.equal(currentColor(g), "yellow");

  // Passing after a no-move roll hands the turn on.
  applyRoll(g, 2);
  applyPass(g);
  assert.equal(currentColor(g), "red");
});

test("gems run out, and a re-rolled six doesn't count towards three sixes", () => {
  const g = newGame(["red", "yellow"], { ...DEFAULT_OPTIONS, gems: 1 });
  g.tokens.red = [5, BASE, BASE, BASE];
  applyRoll(g, 6);
  applyMove(g, 0);
  applyRoll(g, 6);
  applyReroll(g, 6); // still only two sixes in a row
  assert.equal(g.sixes, 2);
  assert.equal(g.gems.red, 0);
  assert.ok(!canReroll(g));
  assert.throws(() => applyReroll(g, 3));
  applyMove(g, 0);
  assert.equal(applyRoll(g, 4).outcome, "move");
});
