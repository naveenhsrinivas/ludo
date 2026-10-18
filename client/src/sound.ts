// Small synthesized sound effects (no audio files to download).

let ctx: AudioContext | null = null;
let enabled = readSetting();

function readSetting(): boolean {
  try {
    return localStorage.getItem("ludo:sound") !== "off";
  } catch {
    return true;
  }
}

export function soundOn(): boolean {
  return enabled;
}

export function setSound(on: boolean): void {
  enabled = on;
  try {
    localStorage.setItem("ludo:sound", on ? "on" : "off");
  } catch {
    // ignore
  }
}

/** Browsers only allow audio after a user gesture; call this from one. */
export function unlockAudio(): void {
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
  }
  if (ctx.state === "suspended") void ctx.resume();
}

function tone(freq: number, start: number, dur: number, type: OscillatorType = "sine", gain = 0.18, slideTo?: number): void {
  if (!ctx) return;
  const t = ctx.currentTime + start;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

function noise(start: number, dur: number, gain = 0.25, freq = 1800): void {
  if (!ctx) return;
  const t = ctx.currentTime + start;
  const len = Math.floor(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = freq;
  const g = ctx.createGain();
  g.gain.value = gain;
  src.connect(filter).connect(g).connect(ctx.destination);
  src.start(t);
}

export type Sound = "roll" | "step" | "capture" | "home" | "six" | "turn" | "win" | "pop" | "out";

export function play(sound: Sound): void {
  if (!enabled || !ctx || ctx.state !== "running") return;
  switch (sound) {
    case "roll":
      for (let i = 0; i < 6; i++) noise(i * 0.07, 0.05, 0.22, 1400 + Math.random() * 1600);
      break;
    case "step":
      tone(520 + Math.random() * 60, 0, 0.07, "triangle", 0.12);
      break;
    case "out":
      tone(392, 0, 0.1, "triangle", 0.14);
      tone(587, 0.08, 0.14, "triangle", 0.14);
      break;
    case "capture":
      tone(700, 0, 0.35, "sawtooth", 0.08, 120);
      noise(0, 0.2, 0.18, 600);
      break;
    case "home":
      [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.07, 0.22, "triangle", 0.12));
      break;
    case "six":
      tone(880, 0, 0.12, "square", 0.05);
      tone(1175, 0.09, 0.16, "square", 0.05);
      break;
    case "turn":
      tone(660, 0, 0.12, "sine", 0.16);
      tone(990, 0.1, 0.2, "sine", 0.14);
      break;
    case "pop":
      tone(900, 0, 0.08, "sine", 0.1, 1400);
      break;
    case "win":
      [523, 659, 784, 1047, 784, 1047, 1319].forEach((f, i) => tone(f, i * 0.12, 0.3, "triangle", 0.13));
      break;
  }
}

/** A short buzz on phones that support it. */
export function buzz(ms: number | number[]): void {
  if (enabled && "vibrate" in navigator) navigator.vibrate(ms);
}
