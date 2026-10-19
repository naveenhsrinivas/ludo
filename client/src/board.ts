import {
  BASE,
  BASE_ORIGIN,
  COLORS,
  FINISH,
  HOME_COLUMN,
  LAST_TRACK,
  SAFE_SQUARES,
  START,
  TRACK,
  baseSpots,
  pointFor,
  trackSquare,
  type Color,
  type Point,
} from "../../shared/board.js";
import { destination, type GameState, type MoveRecord } from "../../shared/rules.js";
import { settle } from "./dice.js";
import { play } from "./sound.js";

const NS = "http://www.w3.org/2000/svg";

export const PALETTE: Record<Color, { main: string; dark: string; light: string }> = {
  red: { main: "#ff3d57", dark: "#c0143a", light: "#ffe0e5" },
  green: { main: "#16c172", dark: "#0b8a4f", light: "#d5f6e5" },
  yellow: { main: "#ffc414", dark: "#cf8d00", light: "#fff2c7" },
  blue: { main: "#2f80ff", dark: "#1752c4", light: "#d9e7ff" },
};

/** Outline colour for the grid, rim and pieces. */
const INK = "#1d1645";

const STEP_MS = 140;
const STAR = "M0,-0.34 L0.1,-0.11 0.33,-0.1 0.15,0.05 0.21,0.28 0,0.15 -0.21,0.28 -0.15,0.05 -0.33,-0.1 -0.1,-0.11Z";

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, parent?: Element): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.appendChild(e);
  return e;
}

interface Placed {
  x: number;
  y: number;
  s: number;
}

/** Quarter turns (clockwise) so that `color` sits in the bottom-left corner. */
export function turnsFor(color: Color | null): number {
  if (!color) return 0;
  return (3 - COLORS.indexOf(color) + 4) % 4;
}

/** Screen corner for each colour, given the board's rotation. */
export function cornerOf(color: Color, turns: number): "tl" | "tr" | "br" | "bl" {
  return (["tl", "tr", "br", "bl"] as const)[(COLORS.indexOf(color) + turns) % 4];
}

export class Board {
  private svg: SVGSVGElement;
  private world: SVGGElement;
  private tokenLayer: SVGGElement;
  private hint: SVGGElement;
  private tokens = new Map<string, SVGGElement>();
  private placed = new Map<string, Placed>();
  private game: GameState | null = null;
  private me: Color | null = null;
  private turns = 0;
  /** Set after picking a token, until the server's answer arrives (stops double taps). */
  private locked = false;

  constructor(host: HTMLElement, private onPick: (token: number) => void) {
    this.svg = el("svg", { viewBox: "-0.3 -0.3 15.6 15.6", class: "board-svg", role: "img", "aria-label": "Ludo board" });
    this.world = el("g", { class: "world" }, this.svg);
    this.drawDefs();
    this.drawBoard();
    this.hint = el("g", { class: "move-hint" }, this.world);
    this.tokenLayer = el("g", { class: "tokens" }, this.world);
    host.appendChild(this.svg);
  }

  /** Rotate the board so `color` is at the bottom left. */
  setPerspective(color: Color | null): void {
    this.me = color;
    this.turns = turnsFor(color);
    this.world.setAttribute("transform", `rotate(${this.turns * 90} 7.5 7.5)`);
  }

  get rotation(): number {
    return this.turns;
  }

  // ---------- Static board ----------
  private drawDefs(): void {
    const defs = el("defs", {}, this.svg);
    // Soft shadow under each token.
    const shadow = el("filter", { id: "lift", x: "-50%", y: "-50%", width: "200%", height: "200%" }, defs);
    el("feDropShadow", { dx: 0, dy: 0.06, stdDeviation: 0.05, "flood-color": INK, "flood-opacity": 0.45 }, shadow);
  }

  private drawBoard(): void {
    const w = this.world;
    const line = { stroke: INK, "stroke-width": 0.06, "stroke-linejoin": "round" };

    // Solid rim and white playing surface.
    el("rect", { x: -0.3, y: -0.3, width: 15.6, height: 15.6, rx: 0.9, fill: INK }, w);
    el("rect", { x: 0, y: 0, width: 15, height: 15, rx: 0.5, fill: "#fff" }, w);

    // Shared track: white squares, stars on the safe ones.
    TRACK.forEach(([col, row], i) => {
      const start = COLORS.find((c) => START[c] === i);
      el("rect", { x: col, y: row, width: 1, height: 1, fill: start ? PALETTE[start].main : "#fff", ...line }, w);
      if (SAFE_SQUARES.has(i)) {
        el("path", {
          d: STAR,
          transform: `translate(${col + 0.5} ${row + 0.5}) scale(1.15)`,
          fill: start ? "#fff" : INK,
          "fill-opacity": start ? 1 : 0.22,
        }, w);
      }
    });

    // Home columns, and a bold arrow where each colour turns in.
    for (const c of COLORS) {
      for (const [col, row] of HOME_COLUMN[c]) {
        el("rect", { x: col, y: row, width: 1, height: 1, fill: PALETTE[c].main, ...line }, w);
      }
      const [ec, er] = TRACK[trackSquare(c, LAST_TRACK)!];
      const [hc, hr] = HOME_COLUMN[c][0];
      const angle = (Math.atan2(hr - er, hc - ec) * 180) / Math.PI;
      el("path", {
        d: "M-0.24,-0.26 L0.2,0 L-0.24,0.26 L-0.1,0 Z",
        transform: `translate(${ec + 0.5} ${er + 0.5}) rotate(${angle})`,
        fill: PALETTE[c].main,
        stroke: INK,
        "stroke-width": 0.04,
        "stroke-linejoin": "round",
      }, w);
    }

    // Bases: a bold coloured square with a white yard and four token pads.
    for (const c of COLORS) {
      const [bx, by] = BASE_ORIGIN[c];
      el("rect", { x: bx, y: by, width: 6, height: 6, rx: 0.5, fill: PALETTE[c].main, ...line }, w);
      el("rect", { x: bx + 0.85, y: by + 0.85, width: 4.3, height: 4.3, rx: 0.8, fill: "#fff", ...line }, w);
      for (const [x, y] of baseSpots(c)) {
        el("circle", { cx: x, cy: y, r: 0.66, fill: PALETTE[c].light, stroke: PALETTE[c].main, "stroke-width": 0.14 }, w);
      }
    }

    // Centre: four triangles meeting at a home badge.
    const tri: Record<Color, string> = {
      red: "6,6 6,9 7.5,7.5",
      green: "6,6 9,6 7.5,7.5",
      yellow: "9,6 9,9 7.5,7.5",
      blue: "6,9 9,9 7.5,7.5",
    };
    for (const c of COLORS) el("polygon", { points: tri[c], fill: PALETTE[c].main, ...line }, w);
    el("circle", { cx: 7.5, cy: 7.5, r: 0.55, fill: "#fff", ...line }, w);
    el("path", { d: STAR, transform: "translate(7.5 7.5) scale(1.05)", fill: INK }, w);
  }

  // ---------- Tokens ----------
  private tokenEl(color: Color, i: number): SVGGElement {
    const key = `${color}${i}`;
    let g = this.tokens.get(key);
    if (g) return g;
    const p = PALETTE[color];
    g = el("g", { class: `token ${color}`, "data-color": color, "data-token": i });
    const body = el("g", { class: "token-body" }, g);
    el("circle", { r: 0.62, class: "token-hit" }, body);
    el("circle", { r: 0.56, class: "token-ring", stroke: p.main }, body);
    // A classic flat pawn: coloured disc, white ring, dark core and a little shine.
    const piece = el("g", { filter: "url(#lift)" }, body);
    el("circle", { r: 0.42, fill: p.main, stroke: INK, "stroke-width": 0.07 }, piece);
    el("circle", { r: 0.27, fill: "none", stroke: "#fff", "stroke-width": 0.1 }, piece);
    el("circle", { r: 0.13, fill: p.dark }, piece);
    el("ellipse", { cx: -0.13, cy: -0.18, rx: 0.13, ry: 0.07, fill: "#fff", "fill-opacity": 0.55, transform: "rotate(-30 -0.13 -0.18)" }, piece);
    g.addEventListener("click", () => this.pick(color, i));
    g.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        this.pick(color, i);
      }
    });
    g.addEventListener("pointerenter", () => this.showHint(color, i));
    g.addEventListener("pointerleave", () => this.clearHint());
    g.addEventListener("focus", () => this.showHint(color, i));
    g.addEventListener("blur", () => this.clearHint());
    this.tokenLayer.appendChild(g);
    this.tokens.set(key, g);
    return g;
  }

  private pick(color: Color, i: number): void {
    const g = this.game;
    if (this.locked || !g || g.phase !== "move" || color !== this.me || g.colors[g.turn] !== color || !g.movable.includes(i)) return;
    this.locked = true;
    this.clearHint();
    for (const n of this.tokenLayer.querySelectorAll(".token.movable")) n.classList.remove("movable");
    this.onPick(i);
  }

  /** Show where a movable token would land. */
  private showHint(color: Color, i: number): void {
    const g = this.game;
    this.clearHint();
    if (!g || g.phase !== "move" || color !== this.me || g.colors[g.turn] !== color || !g.movable.includes(i)) return;
    const to = destination(g.tokens[color][i], g.dice!);
    if (to === null) return;
    const [x, y] = pointFor(color, to, i);
    el("circle", { cx: x, cy: y, r: 0.42, class: "hint-target", stroke: PALETTE[color].main }, this.hint);
  }

  private clearHint(): void {
    this.hint.replaceChildren();
  }

  /** Where every token should sit, spreading out tokens that share a square. */
  private layout(g: GameState): Map<string, Placed> {
    const groups = new Map<string, { key: string; at: Point }[]>();
    for (const c of g.colors) {
      g.tokens[c].forEach((p, i) => {
        const at = pointFor(c, p, i);
        const spot = p === BASE ? `base-${c}-${i}` : p === FINISH ? `finish-${c}` : `${at[0]},${at[1]}`;
        if (!groups.has(spot)) groups.set(spot, []);
        groups.get(spot)!.push({ key: `${c}${i}`, at });
      });
    }
    const out = new Map<string, Placed>();
    const spread: Record<number, Point[]> = {
      1: [[0, 0]],
      2: [[-0.2, -0.05], [0.2, 0.05]],
      3: [[-0.2, 0.12], [0.2, 0.12], [0, -0.18]],
      4: [[-0.2, -0.2], [0.2, -0.2], [-0.2, 0.2], [0.2, 0.2]],
    };
    const scale: Record<number, number> = { 1: 1, 2: 0.78, 3: 0.68, 4: 0.6 };
    for (const [spot, items] of groups) {
      const n = Math.min(items.length, 4);
      const finished = spot.startsWith("finish");
      items.forEach((it, idx) => {
        const [dx, dy] = spread[n][idx % 4];
        // Offsets are in screen space, so undo the board rotation for them.
        const [rx, ry] = this.unrotate(dx, dy);
        out.set(it.key, { x: it.at[0] + rx, y: it.at[1] + ry, s: finished ? scale[n] * 0.8 : scale[n] });
      });
    }
    return out;
  }

  private unrotate(dx: number, dy: number): Point {
    let [x, y] = [dx, dy];
    for (let i = 0; i < this.turns; i++) [x, y] = [y, -x];
    return [x, y];
  }

  private place(key: string, p: Placed): void {
    const g = this.tokens.get(key)!;
    g.style.transform = `translate(${p.x}px, ${p.y}px)`;
    (g.firstChild as SVGGElement).style.transform = `scale(${p.s})`;
    this.placed.set(key, p);
  }

  /** Draw the game as it is now, without animation. */
  render(g: GameState): void {
    this.game = g;
    this.locked = false;
    const layout = this.layout(g);
    const current = g.colors[g.turn];
    const myTurn = g.phase === "move" && current === this.me;

    // Remove tokens of colours no longer in play (e.g. a new game with fewer players).
    for (const [key, node] of this.tokens) {
      if (!layout.has(key)) {
        node.remove();
        this.tokens.delete(key);
        this.placed.delete(key);
      }
    }
    for (const c of g.colors) {
      g.tokens[c].forEach((_, i) => {
        const key = `${c}${i}`;
        const node = this.tokenEl(c, i);
        this.place(key, layout.get(key)!);
        const movable = myTurn && c === current && g.movable.includes(i);
        node.classList.toggle("movable", movable);
        node.classList.toggle("active", c === current && g.phase !== "over");
        node.classList.toggle("done", g.tokens[c][i] === FINISH);
        if (movable) {
          node.setAttribute("tabindex", "0");
          node.setAttribute("role", "button");
          node.setAttribute("aria-label", `Move ${c} token ${i + 1}`);
        } else {
          node.removeAttribute("tabindex");
          node.removeAttribute("role");
          node.removeAttribute("aria-label");
        }
      });
    }
    // Movable and active tokens on top.
    for (const node of this.tokenLayer.querySelectorAll(".token.active")) this.tokenLayer.appendChild(node);
    for (const node of this.tokenLayer.querySelectorAll(".token.movable")) this.tokenLayer.appendChild(node);
    this.clearHint();
  }

  /** Animate a move hop by hop, then any captured tokens flying home. */
  async animate(move: MoveRecord): Promise<void> {
    const key = `${move.color}${move.token}`;
    const node = this.tokens.get(key);
    const from = this.placed.get(key);
    if (!node || !from || matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    this.tokenLayer.appendChild(node);
    node.classList.remove("movable");
    (node.firstChild as SVGGElement).style.transform = "scale(1)";

    const steps: number[] = [];
    if (move.from === BASE) steps.push(0);
    else for (let p = move.from + 1; p <= move.to; p++) steps.push(p);

    let at: Point = [from.x, from.y];
    for (const p of steps) {
      const to = pointFor(move.color, p, move.token);
      await this.hop(node, at, to, STEP_MS);
      play(move.from === BASE ? "out" : "step");
      at = to;
    }
    this.placed.set(key, { x: at[0], y: at[1], s: 1 });

    if (move.to === FINISH) play("home");
    if (move.captures.length) {
      play("capture");
      await Promise.all(
        move.captures.map((c) => {
          const k = `${c.color}${c.token}`;
          const n = this.tokens.get(k);
          const start = this.placed.get(k);
          if (!n || !start) return Promise.resolve();
          const home = baseSpots(c.color)[c.token];
          return this.hop(n, [start.x, start.y], home, 520, 2.2);
        })
      );
    }
  }

  private hop(node: SVGGElement, a: Point, b: Point, ms: number, lift = 0.45): Promise<void> {
    const [ux, uy] = this.unrotate(0, -lift);
    const mid = `translate(${(a[0] + b[0]) / 2 + ux}px, ${(a[1] + b[1]) / 2 + uy}px)`;
    const end = `translate(${b[0]}px, ${b[1]}px)`;
    const anim = node.animate(
      [{ transform: `translate(${a[0]}px, ${a[1]}px)` }, { transform: mid }, { transform: end }],
      { duration: ms, easing: "ease-in-out" }
    );
    node.style.transform = end;
    return settle(anim, ms);
  }
}
