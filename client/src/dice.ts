// A 3D CSS dice that tumbles and lands on a value, in several skins.
import type { DiceSkin } from "../../shared/protocol.js";

// Which of the 9 pip slots (3×3, row by row) are filled for each value.
const PIPS: Record<number, number[]> = {
  1: [4],
  2: [2, 6],
  3: [2, 4, 6],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
};

// Rotation that brings each face to the front (opposite faces add up to 7).
const SHOW: Record<number, string> = {
  1: "rotateX(0deg) rotateY(0deg)",
  2: "rotateX(0deg) rotateY(-90deg)",
  3: "rotateX(-90deg) rotateY(0deg)",
  4: "rotateX(90deg) rotateY(0deg)",
  5: "rotateX(0deg) rotateY(90deg)",
  6: "rotateX(0deg) rotateY(180deg)",
};

const FACE: Record<number, string> = {
  1: "rotateY(0deg)",
  2: "rotateY(90deg)",
  3: "rotateX(90deg)",
  4: "rotateX(-90deg)",
  5: "rotateY(-90deg)",
  6: "rotateY(180deg)",
};

function makeFace(value: number): HTMLDivElement {
  const face = document.createElement("div");
  face.className = `face f${value}`;
  for (let i = 0; i < 9; i++) {
    const pip = document.createElement("span");
    if (PIPS[value].includes(i)) pip.className = "pip";
    face.appendChild(pip);
  }
  return face;
}

/** A flat, single-face dice for previews (e.g. the skin picker). */
export function miniDice(skin: DiceSkin, value = 5): HTMLElement {
  const d = document.createElement("span");
  d.className = "mini-dice";
  d.dataset.skin = skin;
  d.appendChild(makeFace(value));
  return d;
}

export class Dice {
  readonly el: HTMLButtonElement;
  private cube: HTMLDivElement;
  private value = 6;

  constructor() {
    this.el = document.createElement("button");
    this.el.className = "dice";
    this.el.type = "button";
    this.el.setAttribute("aria-label", "Roll the dice");
    this.cube = document.createElement("div");
    this.cube.className = "cube";
    for (let v = 1; v <= 6; v++) {
      const face = makeFace(v);
      face.style.transform = `${FACE[v]} translateZ(calc(var(--dice) / 2))`;
      this.cube.appendChild(face);
    }
    this.el.appendChild(this.cube);
    this.show(6);
  }

  setSkin(skin: DiceSkin): void {
    this.el.dataset.skin = skin;
  }

  show(value: number): void {
    this.value = value;
    this.cube.style.transform = SHOW[value];
    this.el.dataset.value = String(value);
  }

  /** Tumble, then land on `value`. Resolves when it has landed. */
  roll(value: number, ms = 650): Promise<void> {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      this.show(value);
      return Promise.resolve();
    }
    const spins = `rotateX(${720 + Math.random() * 360}deg) rotateY(${720 + Math.random() * 360}deg) rotateZ(${Math.random() * 180}deg)`;
    const anim = this.cube.animate(
      [{ transform: SHOW[this.value] }, { transform: spins, offset: 0.7 }, { transform: SHOW[value] }],
      { duration: ms, easing: "cubic-bezier(.2,.7,.3,1)" }
    );
    this.el.animate(
      [{ transform: "translateY(0) scale(1)" }, { transform: "translateY(-14%) scale(1.08)", offset: 0.35 }, { transform: "translateY(0) scale(1)" }],
      { duration: ms, easing: "ease-out" }
    );
    this.show(value);
    return settle(anim, ms);
  }
}

/** Resolves when the animation ends, or after `ms` if the browser has paused it (background tab). */
export function settle(anim: Animation, ms: number): Promise<void> {
  return Promise.race([
    anim.finished.then(() => undefined, () => undefined),
    new Promise<void>((r) => setTimeout(r, ms + 150)),
  ]);
}
