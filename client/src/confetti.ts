// A short confetti burst on a full-screen canvas.

const COLORS = ["#ef4452", "#22b573", "#ffc51f", "#3d7bfa", "#ffffff"];

interface Piece {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  spin: number;
  angle: number;
  color: string;
  w: number;
  h: number;
}

export function confetti(canvas: HTMLCanvasElement, duration = 3500): void {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const resize = () => {
    canvas.width = innerWidth * dpr;
    canvas.height = innerHeight * dpr;
  };
  resize();
  canvas.classList.add("on");

  const pieces: Piece[] = Array.from({ length: 160 }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * innerWidth * 0.3,
    y: innerHeight * 0.35,
    vx: (Math.random() - 0.5) * 14,
    vy: -Math.random() * 15 - 5,
    r: 0,
    spin: (Math.random() - 0.5) * 0.3,
    angle: Math.random() * Math.PI,
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
    w: 6 + Math.random() * 6,
    h: 8 + Math.random() * 8,
  }));

  const start = performance.now();
  const frame = (now: number) => {
    const t = now - start;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const p of pieces) {
      p.vy += 0.35;
      p.vx *= 0.99;
      p.x += p.vx;
      p.y += p.vy;
      p.angle += p.spin;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.angle);
      ctx.globalAlpha = Math.max(0, 1 - t / duration);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.angle * 2)));
      ctx.restore();
    }
    if (t < duration) requestAnimationFrame(frame);
    else {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      canvas.classList.remove("on");
    }
  };
  requestAnimationFrame(frame);
}
