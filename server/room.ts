import { randomBytes, randomInt } from "node:crypto";
import type { WebSocket } from "ws";
import { COLORS, type Color } from "../shared/board.js";
import { chooseMove, wantsReroll } from "../shared/bot.js";
import {
  DICE_SKINS,
  EMOJIS,
  MAX_CHAT,
  MAX_NAME,
  MAX_PLAYERS,
  STICKERS,
  type ChatMessage,
  type DiceSkin,
  type RoomView,
  type ServerMessage,
  type StickerId,
} from "../shared/protocol.js";
import {
  applyMove,
  applyPass,
  applyReroll,
  applyRoll,
  canReroll,
  GEMS_PER_GAME,
  currentColor,
  DEFAULT_OPTIONS,
  newGame,
  onlyOneChoice,
  rollValue,
  type GameOptions,
  type GameState,
} from "../shared/rules.js";

// ---------- Timing (ms) ----------
// The server waits for the clients' animations before the next automatic action.
// LUDO_TIME_SCALE speeds everything up for tests.
const SCALE = Number(process.env.LUDO_TIME_SCALE) || 1;
export const TURN_TIME = 30_000 * SCALE; // a player has this long to roll or move
const DECIDE_TIME = 5_000 * SCALE; // to choose re-roll or pass after a roll with no moves
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
  dice: DiceSkin;
  socket: WebSocket | null;
  chatTimes: number[];
}

const SKIN_IDS = Object.keys(DICE_SKINS) as DiceSkin[];

export function cleanSkin(raw: unknown): DiceSkin {
  return SKIN_IDS.includes(raw as DiceSkin) ? (raw as DiceSkin) : "classic";
}

/** Uniform random number in [0, 1) from the crypto generator. */
const secureRandom = () => randomInt(0, 2 ** 47) / 2 ** 47;

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
  options: GameOptions = { ...DEFAULT_OPTIONS };
  /** When the last human disconnected; used to clean up abandoned rooms. */
  emptySince: number | null = null;

  private seq = 0;
  private chatId = 0;
  private timer: NodeJS.Timeout | null = null;
  private deadline: number | null = null;
  /** Length of the current countdown, for the timer ring. */
  private timerLength = TURN_TIME;
  /** How long the clients need to animate what just happened. */
  private animating = 0;
  private event: RoomView["event"] = null;

  constructor(readonly code: string) {}

  // ---------- Seats ----------
  /** Seat a browser (new or returning). Returns an error message on failure. */
  join(socket: WebSocket, name: string, secret: string, dice: DiceSkin = "classic"): Seat | string {
    const existing = this.seats.find((s) => s.secret === secret);
    if (existing) {
      if (existing.socket && existing.socket !== socket) this.send(existing.socket, { t: "left" });
      existing.socket = socket;
      existing.left = false;
      existing.dice = dice;
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
      dice,
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
      dice: SKIN_IDS[randomInt(SKIN_IDS.length)],
      socket: null,
      chatTimes: [],
    });
    this.recolor();
    this.changed();
  }

  setDice(seat: Seat, skin: unknown): void {
    seat.dice = cleanSkin(skin);
    this.changed(false);
  }

  setOptions(by: Seat, options: unknown): string | void {
    if (by.id !== this.host) return "Only the host can change the rules.";
    if (this.status !== "lobby") return "Rules can only be changed before the game starts.";
    if (!options || typeof options !== "object") return;
    const o = options as Record<string, unknown>;
    if (typeof o.easySixes === "boolean") this.options.easySixes = o.easySixes;
    if (typeof o.quickStart === "boolean") this.options.quickStart = o.quickStart;
    if (typeof o.gems === "number" && Number.isFinite(o.gems)) this.options.gems = Math.max(0, Math.min(GEMS_PER_GAME, Math.round(o.gems)));
    this.changed(false);
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
    this.game = newGame(this.seats.map((s) => s.color), this.options);
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
    applyRoll(g, rollValue(g, secureRandom));
    this.animating = ROLL_ANIMATION;
    this.event = "roll";
    this.changed();
  }

  /** Spend a gem to roll again. */
  reroll(by: Seat | null): string | void {
    const g = this.game;
    if (!g || this.status !== "playing") return;
    if (by && by.color !== currentColor(g)) return "It's not your turn.";
    if (!canReroll(g)) return g.phase === "move" ? "You're out of gems! 💎" : undefined;
    applyReroll(g, rollValue(g, secureRandom));
    this.animating = ROLL_ANIMATION;
    this.event = "reroll";
    this.changed();
  }

  /** Give up the turn after a roll with no possible move. */
  pass(by: Seat | null): string | void {
    const g = this.game;
    if (!g || this.status !== "playing") return;
    if (by && by.color !== currentColor(g)) return "It's not your turn.";
    if (g.phase !== "move" || g.movable.length) return;
    applyPass(g);
    this.event = "pass";
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
    this.botBanter(m.color, m.captures.map((c) => c.color));
  }

  chatMessage(seat: Seat, text: unknown, emoji: unknown): string | void {
    if (!this.allowChat(seat)) return "Slow down a little!";
    const msg: ChatMessage = { id: ++this.chatId, seat: seat.id, name: seat.name, color: seat.color, at: Date.now() };
    if (typeof emoji === "string" && (EMOJIS as readonly string[]).includes(emoji)) msg.emoji = emoji;
    else {
      const clean = cleanChat(text);
      if (!clean) return;
      msg.text = clean;
    }
    this.pushChat(seat, msg);
  }

  /** Throw a sticker at another player during a game. */
  sticker(seat: Seat, sticker: unknown, to: unknown): string | void {
    if (this.status === "lobby") return "Stickers can be thrown once the game starts.";
    if (typeof sticker !== "string" || !Object.hasOwn(STICKERS, sticker)) return;
    const target = this.seats.find((s) => s.id === to);
    if (!target || target === seat) return;
    if (!this.allowChat(seat)) return "Slow down a little!";
    this.pushChat(seat, {
      id: ++this.chatId,
      seat: seat.id,
      name: seat.name,
      color: seat.color,
      sticker: sticker as StickerId,
      to: target.id,
      at: Date.now(),
    });
  }

  /** Computer players sometimes throw a sticker after a capture, to keep things lively. */
  private botBanter(mover: Color, victims: Color[]): void {
    const by = this.seatFor(mover);
    for (const v of new Set(victims)) {
      const victim = this.seatFor(v);
      if (!by || !victim) continue;
      // A bot teases the human it captured, or throws something at the human who captured it.
      let thrower: Seat, target: Seat, sticker: StickerId;
      if (by.bot && !victim.bot) [thrower, target, sticker] = [by, victim, Math.random() < 0.5 ? "chicken" : "tomato"];
      else if (victim.bot && !by.bot) [thrower, target, sticker] = [victim, by, Math.random() < 0.5 ? "tomato" : "bomb"];
      else continue;
      if (Math.random() > 0.4) continue;
      setTimeout(() => {
        if (this.status === "lobby") return;
        this.pushChat(thrower, {
          id: ++this.chatId,
          seat: thrower.id,
          name: thrower.name,
          color: thrower.color,
          sticker,
          to: target.id,
          at: Date.now(),
        });
      }, 1500 * SCALE);
    }
  }

  private allowChat(seat: Seat): boolean {
    const now = Date.now();
    seat.chatTimes = seat.chatTimes.filter((t) => now - t < 5000);
    return seat.chatTimes.length < 6;
  }

  private pushChat(seat: Seat, msg: ChatMessage): void {
    seat.chatTimes.push(msg.at);
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
    } else if (!g.movable.length) {
      // No move possible: re-roll with a gem, or pass.
      action = () => (auto && wantsReroll(g) ? this.reroll(null) : this.pass(null));
      delay = auto ? BOT_MOVE_DELAY : offline ? OFFLINE_DELAY : DECIDE_TIME;
    } else {
      action = () => this.move(null, chooseMove(g));
      if (onlyOneChoice(g)) delay = AUTO_MOVE_DELAY;
      else delay = auto ? BOT_MOVE_DELAY : offline ? OFFLINE_DELAY : TURN_TIME;
    }

    const at = Date.now() + wait + delay;
    if (!auto && !offline) {
      this.deadline = at;
      this.timerLength = delay;
    }
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
        dice: s.dice,
      })),
      options: this.options,
      game: this.game,
      timeLeft: this.deadline ? Math.max(0, this.deadline - Date.now()) : null,
      turnTime: this.timerLength,
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
