// Stickers thrown between players: a flight across the screen, then an effect on the target.
import { STICKERS, type StickerId } from "../../shared/protocol.js";
import { settle } from "./dice.js";
import { buzz, play } from "./sound.js";

type Point = [number, number];

function centre(el: Element): Point {
  const r = el.getBoundingClientRect();
  return [r.left + r.width / 2, r.top + r.height / 2];
}

/** A floating effect element, positioned by its centre. */
function spawn(text: string, [x, y]: Point, cls = ""): HTMLElement {
  const e = document.createElement("div");
  e.className = `fx ${cls}`;
  e.textContent = text;
  e.style.left = `${x}px`;
  e.style.top = `${y}px`;
  document.body.appendChild(e);
  return e;
}

/** Particles flying out from a point. */
function burst(emoji: string, at: Point, n: number, { spread = 70, fall = 50, ms = 900, size = 20 } = {}): void {
  for (let i = 0; i < n; i++) {
    const p = spawn(emoji, at, "fx-particle");
    p.style.fontSize = `${size * (0.7 + Math.random() * 0.6)}px`;
    const angle = Math.random() * Math.PI * 2;
    const dist = spread * (0.5 + Math.random() * 0.5);
    const dx = Math.cos(angle) * dist;
    const dy = Math.sin(angle) * dist + fall;
    const anim = p.animate(
      [
        { transform: "translate(-50%, -50%) scale(0.4)", opacity: 1 },
        { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(1) rotate(${(Math.random() - 0.5) * 240}deg)`, opacity: 0 },
      ],
      { duration: ms * (0.8 + Math.random() * 0.4), easing: "cubic-bezier(.2,.7,.4,1)" }
    );
    void settle(anim, ms * 1.2).then(() => p.remove());
  }
}

/** Something that lands on the target and stays a moment (a kiss mark, a crown…). */
function stamp(text: string, at: Point, holdMs: number, cls = ""): void {
  const s = spawn(text, at, `fx-stamp ${cls}`);
  s.style.setProperty("--hold", `${holdMs}ms`);
  setTimeout(() => s.remove(), holdMs + 600);
}

function shake(el: HTMLElement, cls = "hit"): void {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), 700);
}

/** What happens when each sticker arrives. */
const IMPACT: Record<StickerId, (target: HTMLElement, at: Point) => void> = {
  bomb(target, at) {
    play("boom");
    buzz([60, 40, 90]);
    const blast = spawn("💥", at, "fx-blast");
    setTimeout(() => blast.remove(), 700);
    burst("💨", at, 5, { spread: 60, fall: -20, size: 22 });
    stamp("😵", at, 1600, "dizzy");
    shake(target);
  },
  rose(_, at) {
    play("sparkle");
    stamp("🌹", at, 2400, "tilt");
    burst("🌸", at, 10, { spread: 80, fall: 60, ms: 1300, size: 16 });
  },
  tomato(target, at) {
    play("splat");
    stamp("", at, 2600, "splat");
    burst("🔴", at, 7, { spread: 55, fall: 40, ms: 700, size: 9 });
    shake(target, "squish");
  },
  kiss(_, at) {
    play("kiss");
    stamp("💋", at, 2600, "tilt");
    burst("💕", at, 4, { spread: 50, fall: -60, ms: 1300, size: 18 });
  },
  heart(_, at) {
    play("sparkle");
    burst("❤️", at, 9, { spread: 50, fall: -90, ms: 1500, size: 20 });
    stamp("🥰", at, 1800);
  },
  egg(target, at) {
    play("crack");
    stamp("🍳", at, 2600);
    burst("🥚", at, 3, { spread: 40, fall: 50, ms: 600, size: 12 });
    shake(target, "squish");
  },
  crown(_, [x, y]) {
    play("crown");
    stamp("👑", [x, y - 30], 3500, "bob");
    burst("✨", [x, y - 20], 8, { spread: 60, fall: -20, ms: 1200, size: 16 });
  },
  chicken(target, at) {
    play("cluck");
    stamp("🐔", at, 2400, "hop");
    const say = spawn("BAWK!", [at[0], at[1] - 46], "fx-say");
    setTimeout(() => say.remove(), 1600);
    shake(target, "squish");
  },
};

/** Fly a sticker from one player's panel to another's, then play its effect. */
export async function throwSticker(id: StickerId, from: HTMLElement, to: HTMLElement): Promise<void> {
  const fromAt = centre(from.querySelector(".avatar") ?? from);
  const toAt = centre(to.querySelector(".avatar") ?? to);
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    IMPACT[id](to, toAt);
    return;
  }
  const s = spawn(STICKERS[id].emoji, fromAt, "fx-sticker");
  play("whoosh");
  const dx = toAt[0] - fromAt[0];
  const dy = toAt[1] - fromAt[1];
  const lift = -Math.min(180, Math.hypot(dx, dy) * 0.4);
  const spin = id === "bomb" || id === "tomato" || id === "egg" ? 540 : id === "chicken" ? 360 : 0;
  const anim = s.animate(
    [
      { transform: "translate(-50%, -50%) scale(0.6) rotate(0deg)" },
      { transform: `translate(calc(-50% + ${dx / 2}px), calc(-50% + ${dy / 2 + lift}px)) scale(1.6) rotate(${spin / 2}deg)`, offset: 0.5 },
      { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(1) rotate(${spin}deg)` },
    ],
    { duration: 850, easing: "cubic-bezier(.35,.55,.45,1)" }
  );
  await settle(anim, 850);
  s.remove();
  IMPACT[id](to, toAt);
}
