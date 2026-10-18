import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, FINISH, HOME_COLUMN, SAFE_SQUARES, START, TRACK, trackSquare, type Color } from "./board.js";
import { chooseMove } from "./bot.js";
import { applyMove, applyRoll, currentColor, newGame, type GameState } from "./rules.js";

function game(colors: Color[] = ["red", "yellow"]): GameState {
  return newGame(colors);
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
      if (g.phase === "roll") applyRoll(g, 1 + Math.floor(Math.random() * 6));
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
