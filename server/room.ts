import { randomBytes, randomInt } from "node:crypto";
import type { WebSocket } from "ws";
import { COLORS, type Color } from "../shared/board.js";
import { chooseMove } from "../shared/bot.js";
import { EMOJIS, MAX_CHAT, MAX_NAME, MAX_PLAYERS, type ChatMessage, type RoomView, type ServerMessage } from "../shared/protocol.js";
import { applyMove, applyRoll, currentColor, newGame, onlyOneChoice, type GameState } from "../shared/rules.js";

// ---------- Timing (ms) ----------
// The server waits for the clients' animations before the next automatic action.
// LUDO_TIME_SCALE speeds everything up for tests.
const SCALE = Number(process.env.LUDO_TIME_SCALE) || 1;
export const TURN_TIME = 30_000 * SCALE; // a player has this long to roll or move
const OFFLINE_DELAY = 4_000 * SCALE; // disconnected players are played for after this
const BOT_ROLL_DELAY = 800 * SCALE;
const BOT_MOVE_DELAY = 600 * SCALE;
const AUTO_MOVE_DELAY = 450 * SCALE; // when there's only one possible move
const ROLL_ANIMATION = 750 * SCALE;
const STEP_ANIMATION = 140 * SCALE;
const CAPTURE_ANIMATION = 550 * SCALE;

const BOT_NAMES = ["Robo Ravi", "Byte Bella", "Chip Chen", "Pixel Priya", "Gizmo Gus", "Nova Nia"];

export interface Seat {
  id: string;
  /** Proves a reconnecting browser owns this seat. Null for bots. */
  secret: string | null;
  name: string;
  color: Color;
  bot: boolean;
  left: boolean;
  socket: WebSocket | null;
  chatTimes: number[];
}

/** Colours used for each player count, spread around the board. */
export function colorsFor(n: number): Color[] {
  if (n === 2) return ["red", "yellow"];
  if (n === 3) return ["red", "green", "yellow"];
  return [...COLORS];
}

export function cleanName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.replace(/[\p{Cc}\p{Cf}]/gu, "").trim().replace(/\s+/g, " ") : "";
  return [...name].slice(0, MAX_NAME).join("") || "Player";
}

function cleanChat(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return [...raw.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim().replace(/\s+/g, " ")].slice(0, MAX_CHAT).join("");
}

export class Room {
  seats: Seat[] = [];
  host = "";
  status: RoomView["status"] = "lobby";
  game: GameState | null = null;
  chat: ChatMessage[] = [];
  /** When the last human disconnected; used to clean up abandoned rooms. */
  emptySince: number | null = null;

  private seq = 0;
  private chatId = 0;
  private timer: NodeJS.Timeout | null = null;
  private deadline: number | null = null;
  /** How long the clients need to animate what just happened. */
  private animating = 0;
  private event: RoomView["event"] = null;

  constructor(readonly code: string) {}

  // ---------- Seats ----------
  /** Seat a browser (new or returning). Returns an error message on failure. */
  join(socket: WebSocket, name: string, secret: string): Seat | string {
    const existing = this.seats.find((s) => s.secret === secret);
    if (existing) {
      if (existing.socket && existing.socket !== socket) this.send(existing.socket, { t: "left" });
      existing.socket = socket;
      existing.left = false;
      if (this.status === "lobby") existing.name = name;
      this.emptySince = null;
      // Also resumes a game that was paused because everyone had gone.
      this.changed(this.isCurrent(existing) || !this.timer);
      return existing;
    }
    if (this.status !== "lobby") return "This game has already started.";
    if (this.seats.length >= MAX_PLAYERS) return "This game is full.";

    const seat: Seat = {
      id: randomBytes(6).toString("hex"),
      secret,
      name,
      color: "red",
      bot: false,
      left: false,
      socket,
      chatTimes: [],
    };
    this.seats.push(seat);
    if (!this.host || !this.seats.some((s) => s.id === this.host)) this.host = seat.id;
    this.emptySince = null;
    this.recolor();
    this.changed();
    return seat;
  }

  addBot(by: Seat): string | void {
    if (by.id !== this.host) return "Only the host can add computer players.";
    if (this.status !== "lobby") return "The game has already started.";
    if (this.seats.length >= MAX_PLAYERS) return "The game is full.";
    const used = new Set(this.seats.map((s) => s.name));
    const name = BOT_NAMES.find((n) => !used.has(n)) ?? `Bot ${this.seats.length + 1}`;
    this.seats.push({
      id: randomBytes(6).toString("hex"),
      secret: null,
      name,
      color: "red",
      bot: true,
      left: false,
      socket: null,
      chatTimes: [],
    });
    this.recolor();
    this.changed();
  }

  removeSeat(by: Seat, id: string): string | void {
    if (by.id !== this.host) return "Only the host can remove players.";
    if (this.status !== "lobby") return "The game has already started.";
    const seat = this.seats.find((s) => s.id === id);
    if (!seat || seat.id === this.host) return;
    this.seats = this.seats.filter((s) => s !== seat);
    if (seat.socket) this.send(seat.socket, { t: "left" });
    this.recolor();
    this.changed();
  }

  /** A player chose to leave. In a game, a computer takes over their tokens. */
  leave(seat: Seat): void {
    if (this.status === "lobby") {
      this.seats = this.seats.filter((s) => s !== seat);
      this.recolor();
    } else {
      seat.left = true;
    }
    seat.socket = null;
    if (seat.id === this.host) {
      const next = this.seats.find((s) => !s.bot && !s.left);
      if (next) this.host = next.id;
    }
    this.checkEmpty();
    this.changed(this.isCurrent(seat) || !this.hasHumansOnline());
  }

  disconnect(socket: WebSocket): void {
    const seat = this.seats.find((s) => s.socket === socket);
    if (!seat) return;
    seat.socket = null;
    this.checkEmpty();
    this.changed(this.isCurrent(seat) || !this.hasHumansOnline());
  }

  hasHumansOnline(): boolean {
    return this.seats.some((s) => s.socket);
  }

  private checkEmpty(): void {
    if (!this.hasHumansOnline()) this.emptySince ??= Date.now();
  }

  private recolor(): void {
    const colors = colorsFor(this.seats.length);
    this.seats.forEach((s, i) => (s.color = colors[i] ?? "red"));
  }

  // ---------- Game ----------
  start(by: Seat): string | void {
    if (by.id !== this.host) return "Only the host can start the game.";
    if (this.status !== "lobby") return;
    if (this.seats.length < 2) return "You need at least 2 players. Add a computer player to play now.";
    this.recolor();
    this.game = newGame(this.seats.map((s) => s.color));
    this.status = "playing";
    this.animating = 600 * SCALE;
    this.event = "start";
    this.changed();
  }

  /** Back to the lobby with the same players. */
  again(by: Seat): string | void {
    if (by.id !== this.host) return "Only the host can start a new game.";
    if (this.status !== "over") return;
    this.seats = this.seats.filter((s) => !s.left);
    this.status = "lobby";
    this.game = null;
    this.recolor();
    this.changed();
  }

  roll(by: Seat | null): string | void {
    const g = this.game;
    if (!g || this.status !== "playing") return;
    if (by && by.color !== currentColor(g)) return "It's not your turn.";
    if (g.phase !== "roll") return;
    applyRoll(g, randomInt(1, 7));
    this.animating = ROLL_ANIMATION;
    this.event = "roll";
    this.changed();
  }

  move(by: Seat | null, token: number): string | void {
    const g = this.game;
    if (!g || this.status !== "playing") return;
    if (by && by.color !== currentColor(g)) return "It's not your turn.";
    if (g.phase !== "move" || !g.movable.includes(token)) return;
    const m = applyMove(g, token);
    this.animating = Math.max(1, m.to - Math.max(m.from, 0)) * STEP_ANIMATION + (m.captures.length ? CAPTURE_ANIMATION : 0);
    if (g.ranking.length === g.colors.length) this.status = "over";
    this.event = "move";
    this.changed();
  }

  chatMessage(seat: Seat, text: unknown, emoji: unknown): string | void {
    const now = Date.now();
    seat.chatTimes = seat.chatTimes.filter((t) => now - t < 5000);
    if (seat.chatTimes.length >= 5) return "Slow down a little!";

    const msg: ChatMessage = { id: ++this.chatId, seat: seat.id, name: seat.name, color: seat.color, at: now };
    if (typeof emoji === "string" && (EMOJIS as readonly string[]).includes(emoji)) msg.emoji = emoji;
    else {
      const clean = cleanChat(text);
      if (!clean) return;
      msg.text = clean;
    }
    seat.chatTimes.push(now);
    this.chat.push(msg);
    this.chat = this.chat.slice(-50);
    for (const s of this.seats) if (s.socket) this.send(s.socket, { t: "chat", msg });
  }

  // ---------- Turn timing ----------
  private isCurrent(seat: Seat): boolean {
    return !!this.game && this.status === "playing" && seat.color === currentColor(this.game);
  }

  private seatFor(color: Color): Seat | undefined {
    return this.seats.find((s) => s.color === color);
  }

  /** Decide what happens next if nobody acts, and when. */
  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.deadline = null;
    const g = this.game;
    if (!g || this.status !== "playing") return;
    if (!this.hasHumansOnline()) return; // paused until someone comes back

    const seat = this.seatFor(currentColor(g));
    const wait = this.animating;
    const auto = !seat || seat.bot || seat.left;
    const offline = !auto && !seat.socket;

    let delay: number;
    let action: () => void;
    if (g.phase === "roll") {
      action = () => this.roll(null);
      delay = auto ? BOT_ROLL_DELAY : offline ? OFFLINE_DELAY : TURN_TIME;
    } else {
      action = () => this.move(null, chooseMove(g));
      if (onlyOneChoice(g)) delay = AUTO_MOVE_DELAY;
      else delay = auto ? BOT_MOVE_DELAY : offline ? OFFLINE_DELAY : TURN_TIME;
    }

    const at = Date.now() + wait + delay;
    if (!auto && !offline && delay === TURN_TIME) this.deadline = at;
    this.timer = setTimeout(action, wait + delay);
  }

  // ---------- Sending ----------
  /** Tell everyone about a change. `reschedule` is false when the turn timer shouldn't restart. */
  private changed(reschedule = true): void {
    this.seq++;
    if (reschedule) this.schedule();
    this.animating = 0;
    for (const s of this.seats) if (s.socket) this.send(s.socket, { t: "room", room: this.view(s) });
    this.event = null;
  }

  view(seat: Seat | null): RoomView {
    return {
      code: this.code,
      status: this.status,
      you: seat?.id ?? null,
      host: this.host,
      seats: this.seats.map((s) => ({
        id: s.id,
        name: s.name,
        color: s.color,
        bot: s.bot,
        connected: s.bot || s.socket !== null,
        left: s.left,
      })),
      game: this.game,
      timeLeft: this.deadline ? Math.max(0, this.deadline - Date.now()) : null,
      turnTime: TURN_TIME,
      seq: this.seq,
      event: this.event,
    };
  }

  send(socket: WebSocket, msg: ServerMessage): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
