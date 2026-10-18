// Board geometry for a classic 15×15 Ludo board.
//
// Coordinates are grid units: cell (col, row) spans [col, col+1] × [row, row+1],
// so the centre of a cell is (col + 0.5, row + 0.5).
//
//   red base    | top arm   | green base
//   ------------+-----------+------------
//   left arm    |  centre   | right arm
//   ------------+-----------+------------
//   blue base   | bottom arm| yellow base

export const COLORS = ["red", "green", "yellow", "blue"] as const;
export type Color = (typeof COLORS)[number];

export type Cell = readonly [col: number, row: number];
export type Point = readonly [x: number, y: number];

/** Token progress: -1 = in base, 0–50 = main track, 51–55 = home column, 56 = finished. */
export const BASE = -1;
export const LAST_TRACK = 50;
export const FINISH = 56;
export const TRACK_LENGTH = 52;

/** The 52 shared squares, clockwise, starting at red's start square. */
export const TRACK: readonly Cell[] = (() => {
  const t: Cell[] = [];
  const run = (cells: Cell[]) => t.push(...cells);
  const range = (a: number, b: number) =>
    a <= b ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : Array.from({ length: a - b + 1 }, (_, i) => a - i);

  run(range(1, 5).map((c) => [c, 6] as const)); // left arm, top row →
  run(range(5, 0).map((r) => [6, r] as const)); // top arm, left column ↑
  run([[7, 0]]);
  run(range(0, 5).map((r) => [8, r] as const)); // top arm, right column ↓
  run(range(9, 14).map((c) => [c, 6] as const)); // right arm, top row →
  run([[14, 7]]);
  run(range(14, 9).map((c) => [c, 8] as const)); // right arm, bottom row ←
  run(range(9, 14).map((r) => [8, r] as const)); // bottom arm, right column ↓
  run([[7, 14]]);
  run(range(14, 9).map((r) => [6, r] as const)); // bottom arm, left column ↑
  run(range(5, 0).map((c) => [c, 8] as const)); // left arm, bottom row ←
  run([[0, 7], [0, 6]]);
  return t;
})();

/** Where each colour enters the track. */
export const START: Record<Color, number> = { red: 0, green: 13, yellow: 26, blue: 39 };

/** Start squares and star squares: tokens here can't be captured. */
export const SAFE_SQUARES: ReadonlySet<number> = new Set([0, 8, 13, 21, 26, 34, 39, 47]);

/** The five coloured squares leading to the centre, in walking order. */
export const HOME_COLUMN: Record<Color, readonly Cell[]> = {
  red: [1, 2, 3, 4, 5].map((c) => [c, 7] as const),
  green: [1, 2, 3, 4, 5].map((r) => [7, r] as const),
  yellow: [13, 12, 11, 10, 9].map((c) => [c, 7] as const),
  blue: [13, 12, 11, 10, 9].map((r) => [7, r] as const),
};

/** Top-left cell of each colour's 6×6 base. */
export const BASE_ORIGIN: Record<Color, Cell> = {
  red: [0, 0],
  green: [9, 0],
  yellow: [9, 9],
  blue: [0, 9],
};

/** Where the four tokens wait inside a base. */
export function baseSpots(color: Color): Point[] {
  const [c, r] = BASE_ORIGIN[color];
  return [
    [c + 2, r + 2],
    [c + 4, r + 2],
    [c + 2, r + 4],
    [c + 4, r + 4],
  ];
}

/** Centre of each colour's triangle in the middle of the board. */
export const FINISH_POINT: Record<Color, Point> = {
  red: [6.55, 7.5],
  green: [7.5, 6.55],
  yellow: [8.45, 7.5],
  blue: [7.5, 8.45],
};

/** Index of the shared square a token is on, or null if it's in base / home column / finished. */
export function trackSquare(color: Color, progress: number): number | null {
  if (progress < 0 || progress > LAST_TRACK) return null;
  return (START[color] + progress) % TRACK_LENGTH;
}

/** Centre point (grid units) of the square a token at this progress occupies. */
export function pointFor(color: Color, progress: number, tokenIndex: number): Point {
  if (progress === BASE) return baseSpots(color)[tokenIndex];
  if (progress === FINISH) return FINISH_POINT[color];
  const cell = progress <= LAST_TRACK ? TRACK[trackSquare(color, progress)!] : HOME_COLUMN[color][progress - LAST_TRACK - 1];
  return [cell[0] + 0.5, cell[1] + 0.5];
}
