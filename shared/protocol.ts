// Messages exchanged over the WebSocket. Everything is JSON.
import type { Color } from "./board.js";
import type { GameOptions, GameState } from "./rules.js";

export const MAX_PLAYERS = 4;
export const MAX_NAME = 16;
export const MAX_CHAT = 200;
export const EMOJIS = ["😀", "😂", "😮", "😡", "😭", "👍", "🎉", "🔥"] as const;

/** Stickers you can throw at another player. */
export const STICKERS = {
  rose: { emoji: "🌹", label: "Rose" },
  bomb: { emoji: "💣", label: "Bomb" },
  tomato: { emoji: "🍅", label: "Tomato" },
  kiss: { emoji: "💋", label: "Kiss" },
  heart: { emoji: "❤️", label: "Heart" },
  egg: { emoji: "🥚", label: "Egg" },
  crown: { emoji: "👑", label: "Crown" },
  chicken: { emoji: "🐔", label: "Chicken" },
} as const;
export type StickerId = keyof typeof STICKERS;

export const DICE_SKINS = {
  classic: "Classic",
  ruby: "Ruby",
  gold: "Gold",
  galaxy: "Galaxy",
  neon: "Neon",
  wood: "Wood",
} as const;
export type DiceSkin = keyof typeof DICE_SKINS;

export type ClientMessage =
  /** `secret` identifies this browser so it can rejoin its seat after a disconnect. */
  | { t: "create"; name: string; secret: string; dice?: string; bots?: number; start?: boolean }
  | { t: "join"; code: string; name: string; secret: string; dice?: string }
  | { t: "dice"; skin: string }
  | { t: "options"; options: Partial<GameOptions> }
  | { t: "sticker"; sticker: string; to: string }
  | { t: "addBot" }
  | { t: "removeSeat"; seat: string }
  | { t: "start" }
  | { t: "roll" }
  | { t: "reroll" }
  | { t: "pass" }
  | { t: "move"; token: number }
  | { t: "chat"; text: string }
  | { t: "emoji"; emoji: string }
  | { t: "again" }
  | { t: "leave" }
  /** Keep-alive, so free hosting doesn't sleep mid-game. */
  | { t: "ping" };

export interface SeatView {
  /** Public id (never the secret). */
  id: string;
  name: string;
  color: Color;
  bot: boolean;
  connected: boolean;
  /** Left mid-game; a computer is playing for them. */
  left: boolean;
  dice: DiceSkin;
}

export interface RoomView {
  code: string;
  status: "lobby" | "playing" | "over";
  /** Your seat id, if you have one. */
  you: string | null;
  host: string;
  seats: SeatView[];
  /** House rules for the next game (the host can change them in the lobby). */
  options: GameOptions;
  game: GameState | null;
  /** Milliseconds left for the current player to act, if a timer is running. */
  timeLeft: number | null;
  turnTime: number;
  /** Increases with every change, so clients can tell new events from repeats. */
  seq: number;
  /** What caused this update, so clients know what to animate. Null for snapshots. */
  event: "start" | "roll" | "reroll" | "pass" | "move" | null;
}

export interface ChatMessage {
  id: number;
  seat: string;
  name: string;
  color: Color;
  text?: string;
  emoji?: string;
  /** A sticker thrown at the seat `to`. */
  sticker?: StickerId;
  to?: string;
  at: number;
}

export type ServerMessage =
  | { t: "room"; room: RoomView }
  | { t: "chat"; msg: ChatMessage }
  | { t: "chatHistory"; msgs: ChatMessage[] }
  | { t: "error"; message: string }
  | { t: "left" };
