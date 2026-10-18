import "./style.css";
import { FINISH, type Color } from "../../shared/board.js";
import { EMOJIS, MAX_PLAYERS, type ChatMessage, type RoomView, type SeatView, type ServerMessage } from "../../shared/protocol.js";
import { onlyOneChoice } from "../../shared/rules.js";
import { Board, cornerOf, PALETTE } from "./board.js";
import { confetti } from "./confetti.js";
import { Dice } from "./dice.js";
import { Connection, socketUrl } from "./net.js";
import { buzz, play, setSound, soundOn, unlockAudio } from "./sound.js";

// ---------- Helpers ----------
function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`Missing #${id}`);
  return e as T;
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function store(key: string, value?: string | null): string | null {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // storage unavailable
  }
  return null;
}

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function toast(text: string, kind: "info" | "error" | "good" = "info", ms = 2600): void {
  const t = h("div", `toast ${kind}`, text);
  $("toasts").appendChild(t);
  setTimeout(() => t.classList.add("out"), ms);
  setTimeout(() => t.remove(), ms + 400);
}

const COLOR_NAMES: Record<Color, string> = { red: "Red", green: "Green", yellow: "Yellow", blue: "Blue" };

// ---------- Session ----------
const secret = store("ludo:secret") ?? randomSecret();
store("ludo:secret", secret);

const nameInput = $<HTMLInputElement>("name-input");
nameInput.value = store("ludo:name") ?? "";
nameInput.addEventListener("input", () => store("ludo:name", nameInput.value.trim()));

let savedRoom = store("ludo:room");
let rejoining = false;

const params = new URLSearchParams(location.search);
const inviteCode = params.get("room")?.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5);
if (inviteCode) {
  $<HTMLInputElement>("code-input").value = inviteCode;
  if (savedRoom !== inviteCode) savedRoom = null;
  history.replaceState(null, "", location.pathname);
}

function playerName(): string | null {
  const name = nameInput.value.trim();
  if (name) return name;
  nameInput.focus();
  nameInput.classList.remove("shake");
  void nameInput.offsetWidth;
  nameInput.classList.add("shake");
  toast("Enter your name first 🙂");
  return null;
}

// ---------- Connection ----------
const conn = new Connection(socketUrl());
conn.hello = () => {
  if (!savedRoom) return null;
  rejoining = true;
  return { t: "join", code: savedRoom, name: nameInput.value.trim() || "Player", secret };
};
let wasOnline = true;
conn.onStatus((online) => {
  document.body.classList.toggle("offline", !online);
  if (!online && wasOnline && room) toast("Connection lost — reconnecting…", "error", 3000);
  if (online && !wasOnline && room) toast("Reconnected", "good", 1500);
  wasOnline = online;
});

// ---------- State ----------
let room: RoomView | null = null;
let chat: ChatMessage[] = [];
let unread = 0;
let chatOpen = false;
let awaitingRoll = false;
let resultsShownFor = -1;
let turnEndsAt: number | null = null;
let queue: Promise<void> = Promise.resolve();
let queued = 0;

const board = new Board($("board"), (token) => conn.send({ t: "move", token }));
const dice = new Dice();
dice.el.addEventListener("click", () => rollDice());

function mySeat(r: RoomView | null = room): SeatView | undefined {
  return r?.seats.find((s) => s.id === r.you);
}

function seatOf(color: Color, r: RoomView | null = room): SeatView | undefined {
  return r?.seats.find((s) => s.color === color);
}

function isMyTurn(r: RoomView | null = room): boolean {
  const g = r?.game;
  return !!g && r!.status === "playing" && g.colors[g.turn] === mySeat(r)?.color;
}

conn.onMessage((msg: ServerMessage) => {
  switch (msg.t) {
    case "room":
      rejoining = false;
      savedRoom = msg.room.code;
      store("ludo:room", savedRoom);
      enqueue(msg.room);
      break;
    case "chatHistory":
      chat = msg.msgs;
      renderChat();
      break;
    case "chat":
      onChat(msg.msg);
      break;
    case "error":
      if (rejoining) {
        rejoining = false;
        forgetRoom();
        if (!room) showScreen("home");
        return;
      }
      awaitingRoll = false;
      toast(msg.message, "error");
      break;
    case "left":
      forgetRoom();
      room = null;
      closeModal("results");
      closeChat();
      showScreen("home");
      break;
  }
});

function forgetRoom(): void {
  savedRoom = null;
  store("ludo:room", null);
}

// ---------- Applying updates (in order, with animations) ----------
function enqueue(next: RoomView): void {
  queued++;
  queue = queue.then(() => apply(next)).catch((err) => console.error(err)).finally(() => queued--);
}

async function apply(next: RoomView): Promise<void> {
  const prev = room;
  room = next;
  if (!prev) $("toasts").replaceChildren(); // e.g. the "enter your name" hint
  // Any roll result unlocks the dice, whether or not we animate it.
  if (next.event === "roll" || !isMyTurn(next)) awaitingRoll = false;
  // Skip animations if we've fallen behind (e.g. the tab was in the background).
  const animate = queued <= 2 && !document.hidden && !!prev && prev.seq < next.seq;

  if (next.status === "lobby") {
    closeModal("results");
    showScreen("lobby");
    renderLobby(next);
    return;
  }

  const g = next.game!;
  showScreen("game");
  $("game-code").textContent = next.code;
  board.setPerspective(mySeat(next)?.color ?? null);
  renderPanels(next);
  setTimer(next);

  if (animate && next.event === "roll" && g.lastRoll) {
    const roller = seatOf(g.lastRoll.color, next);
    setStatus(roller?.id === next.you ? "Rolling…" : `${roller?.name ?? "They"} rolled…`, roller?.id === next.you);
    placeDice(g.lastRoll.color, false);
    play("roll");
    buzz(20);
    await dice.roll(g.lastRoll.value);
    if (g.lastRoll.value === 6) play("six");
    const who = seatOf(g.lastRoll.color, next);
    const mine = who?.id === next.you;
    if (g.lastRoll.outcome === "no-move") {
      setStatus(mine ? `You rolled ${g.lastRoll.value} — no moves this time` : `${who?.name ?? "They"} rolled ${g.lastRoll.value} — no moves`);
      await sleep(600);
    } else if (g.lastRoll.outcome === "three-sixes") {
      toast(`${mine ? "You" : who?.name} rolled three 6s — turn lost! 😬`, "error");
      await sleep(600);
    }
  } else if (animate && next.event === "move" && g.lastMove) {
    const mover = seatOf(g.lastMove.color, next);
    if (mover?.id !== next.you) setStatus(`${mover?.name ?? "They"} is moving…`);
    await board.animate(g.lastMove);
    if (g.lastMove.captures.length) {
      const by = seatOf(g.lastMove.color, next);
      for (const c of g.lastMove.captures) {
        const victim = seatOf(c.color, next);
        if (victim?.id === next.you) {
          toast(`${by?.name} captured your token! 😱`, "error");
          buzz([40, 60, 40]);
        } else if (by?.id === next.you) toast(`Captured ${victim?.name}! 💥`, "good");
      }
    }
  } else if (g.lastRoll) {
    dice.show(g.lastRoll.value);
  }

  // A newer update may have arrived while we were animating; it'll render next.
  board.render(g);
  renderPanels(next);
  renderStatus(next);

  const turnStarted = isMyTurn(next) && g.phase === "roll" && !(prev && isMyTurn(prev) && prev.game?.phase === "roll");
  if (animate && turnStarted) {
    play("turn");
    buzz(30);
  }

  if (next.status === "over" && resultsShownFor !== next.seq) {
    resultsShownFor = next.seq;
    if (animate) await sleep(500);
    showResults(next);
  }
}

// ---------- Screens ----------
type ScreenId = "home" | "lobby" | "game";
function showScreen(id: ScreenId): void {
  for (const s of ["home", "lobby", "game"] as const) $(s).classList.toggle("hidden", s !== id);
  document.body.dataset.screen = id;
}

// ---------- Home ----------
$("create-btn").addEventListener("click", () => {
  const name = playerName();
  if (name) conn.send({ t: "create", name, secret });
});

$("join-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = playerName();
  const code = $<HTMLInputElement>("code-input").value.trim().toUpperCase();
  if (!name) return;
  if (code.length !== 5) {
    toast("Room codes have 5 letters or numbers.", "error");
    $("code-input").focus();
    return;
  }
  conn.send({ t: "join", code, name, secret });
});

$("code-input").addEventListener("input", (e) => {
  const input = e.target as HTMLInputElement;
  input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
});

let botCount = 1;
$("bot-count").addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
  if (!btn) return;
  botCount = Number(btn.dataset.value);
  for (const b of $("bot-count").querySelectorAll("button")) {
    b.classList.toggle("active", b === btn);
    b.setAttribute("aria-checked", String(b === btn));
  }
});

$("bots-btn").addEventListener("click", () => {
  const name = playerName();
  if (name) conn.send({ t: "create", name, secret, bots: botCount, start: true });
});

// ---------- Lobby ----------
function avatar(seat: SeatView | undefined, color: Color | null): HTMLElement {
  const a = h("div", "avatar");
  if (color) a.style.setProperty("--c", PALETTE[color].main);
  a.textContent = seat ? (seat.bot ? "🤖" : [...seat.name][0]?.toUpperCase() ?? "?") : "+";
  return a;
}

function renderLobby(r: RoomView): void {
  $("lobby-code").textContent = r.code;
  const me = mySeat(r);
  const isHost = me?.id === r.host;
  const list = $("seats");
  list.replaceChildren();

  for (let i = 0; i < MAX_PLAYERS; i++) {
    const seat = r.seats[i];
    const card = h("div", `seat ${seat ? "filled" : "empty"}`);
    if (seat) {
      card.style.setProperty("--c", PALETTE[seat.color].main);
      card.appendChild(avatar(seat, seat.color));
      const info = h("div", "seat-info");
      info.appendChild(h("div", "seat-name", seat.name));
      const tags = h("div", "tags");
      if (seat.id === r.host) tags.appendChild(h("span", "tag host", "👑 Host"));
      if (seat.id === r.you) tags.appendChild(h("span", "tag you", "You"));
      if (seat.bot) tags.appendChild(h("span", "tag", "Computer"));
      if (!seat.connected) tags.appendChild(h("span", "tag warn", "Offline"));
      tags.appendChild(h("span", "tag color", COLOR_NAMES[seat.color]));
      info.appendChild(tags);
      card.appendChild(info);
      if (isHost && seat.id !== r.you) {
        const x = h("button", "icon-btn remove", "✕");
        x.setAttribute("aria-label", `Remove ${seat.name}`);
        x.addEventListener("click", () => conn.send({ t: "removeSeat", seat: seat.id }));
        card.appendChild(x);
      }
    } else if (isHost) {
      const add = h("button", "add-bot", "＋ Add computer");
      add.addEventListener("click", () => conn.send({ t: "addBot" }));
      card.appendChild(add);
    } else {
      card.appendChild(h("div", "waiting", "Waiting for a friend…"));
    }
    list.appendChild(card);
  }

  const start = $<HTMLButtonElement>("start-btn");
  start.classList.toggle("hidden", !isHost);
  start.disabled = r.seats.length < 2;
  $("lobby-hint").textContent = !isHost
    ? "Waiting for the host to start the game…"
    : r.seats.length < 2
      ? "Share the code with friends, or add a computer player to start."
      : r.seats.length < MAX_PLAYERS
        ? "Ready when you are! You can still invite more players."
        : "The table is full — let's play!";
}

$("start-btn").addEventListener("click", () => conn.send({ t: "start" }));

$("copy-code").addEventListener("click", async () => {
  if (!room) return;
  try {
    await navigator.clipboard.writeText(room.code);
    toast("Code copied!", "good");
  } catch {
    toast(`Room code: ${room.code}`);
  }
});

$("share-link").addEventListener("click", async () => {
  if (!room) return;
  const url = `${location.origin}${location.pathname}?room=${room.code}`;
  const text = `Join my Ludo game! Room code: ${room.code}`;
  if (navigator.share) {
    try {
      await navigator.share({ title: "Ludo Live", text, url });
      return;
    } catch {
      // cancelled — fall through to copying
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast("Invite link copied!", "good");
  } catch {
    toast(url);
  }
});

$("lobby-leave").addEventListener("click", () => conn.send({ t: "leave" }));

// ---------- Game: panels, dice, status ----------
const panels = new Map<Color, HTMLElement>();

function panelFor(color: Color): HTMLElement {
  let p = panels.get(color);
  if (p) return p;
  p = h("div", `panel ${color}`);
  p.style.setProperty("--c", PALETTE[color].main);
  p.style.setProperty("--c-dark", PALETTE[color].dark);
  const av = h("div", "avatar-wrap");
  av.appendChild(h("div", "avatar"));
  av.insertAdjacentHTML(
    "beforeend",
    `<svg class="timer" viewBox="0 0 44 44" aria-hidden="true"><circle cx="22" cy="22" r="20" pathLength="100"/></svg>`
  );
  p.appendChild(av);
  const info = h("div", "pinfo");
  info.appendChild(h("div", "pname"));
  info.appendChild(h("div", "psub"));
  info.appendChild(h("div", "pips"));
  p.appendChild(info);
  p.appendChild(h("div", "dice-slot"));
  p.appendChild(h("div", "bubble"));
  panels.set(color, p);
  return p;
}

function renderPanels(r: RoomView): void {
  const g = r.game;
  if (!g) return;
  const turns = board.rotation;
  const used = new Set<string>();
  const current = g.colors[g.turn];

  for (const color of g.colors) {
    const seat = seatOf(color, r);
    const p = panelFor(color);
    const corner = cornerOf(color, turns);
    used.add(corner);
    const slot = document.querySelector<HTMLElement>(`.panel-slot[data-corner="${corner}"]`)!;
    if (p.parentElement !== slot) slot.replaceChildren(p);

    const rank = g.ranking.indexOf(color);
    p.classList.toggle("active", r.status === "playing" && color === current);
    p.classList.toggle("me", seat?.id === r.you);
    p.classList.toggle("away", !!seat && (!seat.connected || seat.left));
    p.classList.toggle("finished", rank >= 0);

    const av = p.querySelector<HTMLElement>(".avatar")!;
    av.textContent = rank >= 0 ? (["🥇", "🥈", "🥉", "4️⃣"][rank] ?? "🏁") : seat?.bot || seat?.left ? "🤖" : [...(seat?.name ?? "?")][0].toUpperCase();
    p.querySelector(".pname")!.textContent = seat ? (seat.id === r.you ? `${seat.name} (you)` : seat.name) : COLOR_NAMES[color];
    p.querySelector(".psub")!.textContent = !seat
      ? ""
      : seat.left
        ? "Left · computer playing"
        : seat.bot
          ? "Computer"
          : !seat.connected
            ? "Offline"
            : rank >= 0
              ? `Finished ${["1st", "2nd", "3rd", "4th"][rank]}`
              : "";
    const pips = p.querySelector(".pips")!;
    const home = g.tokens[color].filter((t) => t === FINISH).length;
    pips.replaceChildren(...[0, 1, 2, 3].map((i) => h("span", i < home ? "pip on" : "pip")));
    pips.setAttribute("aria-label", `${home} of 4 tokens home`);
  }
  for (const slot of document.querySelectorAll<HTMLElement>(".panel-slot")) {
    if (!used.has(slot.dataset.corner!)) slot.replaceChildren();
  }

  if (r.status === "playing") placeDice(current, isMyTurn(r) && g.phase === "roll");
  else dice.el.remove();
}

function placeDice(color: Color, ready: boolean): void {
  const slot = panelFor(color).querySelector(".dice-slot")!;
  if (dice.el.parentElement !== slot) slot.appendChild(dice.el);
  dice.el.classList.toggle("ready", ready && !awaitingRoll);
  dice.el.disabled = !ready || awaitingRoll;
  dice.el.style.setProperty("--c", PALETTE[color].main);
}

function rollDice(): void {
  if (!room || !isMyTurn() || room.game?.phase !== "roll" || awaitingRoll) return;
  unlockAudio();
  awaitingRoll = true;
  dice.el.classList.remove("ready");
  dice.el.disabled = true;
  conn.send({ t: "roll" });
  // If the reply never comes (e.g. the connection dropped), let them try again.
  const sentAt = room.seq;
  setTimeout(() => {
    if (awaitingRoll && room?.seq === sentAt) {
      awaitingRoll = false;
      if (room) renderPanels(room);
    }
  }, 4000);
}

function setStatus(text: string, mine = false): void {
  const s = $("status");
  s.textContent = text;
  s.classList.toggle("mine", mine);
}

function renderStatus(r: RoomView): void {
  const g = r.game!;
  if (r.status === "over") return setStatus("Game over!");
  const color = g.colors[g.turn];
  const seat = seatOf(color, r);
  if (isMyTurn(r)) {
    if (g.phase === "roll") setStatus(g.sixes ? "🎉 Rolled a 6 — roll again!" : "Your turn — tap the dice 🎲", true);
    else setStatus(onlyOneChoice(g) ? "Moving…" : "Pick a token to move ✨", true);
    return;
  }
  const name = seat?.name ?? COLOR_NAMES[color];
  if (seat?.bot || seat?.left) setStatus(`${name} is thinking…`);
  else if (seat && !seat.connected) setStatus(`${name} is offline — playing for them shortly…`);
  else setStatus(g.phase === "roll" ? `Waiting for ${name} to roll…` : `${name} is choosing a move…`);
}

// Countdown ring around the current player's avatar.
function setTimer(r: RoomView): void {
  turnEndsAt = r.timeLeft !== null && r.status === "playing" ? performance.now() + r.timeLeft : null;
}

function tick(): void {
  const g = room?.game;
  for (const [color, p] of panels) {
    const active = !!g && room!.status === "playing" && g.colors[g.turn] === color && turnEndsAt !== null;
    const left = active ? Math.max(0, turnEndsAt! - performance.now()) : 0;
    const frac = active ? left / room!.turnTime : 0;
    p.style.setProperty("--t", String(frac * 100));
    p.classList.toggle("timing", active);
    p.classList.toggle("hurry", active && left < 8000);
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

$("sound-btn").addEventListener("click", () => {
  unlockAudio();
  setSound(!soundOn());
  renderSoundBtn();
  if (soundOn()) play("pop");
});
function renderSoundBtn(): void {
  const b = $("sound-btn");
  b.textContent = soundOn() ? "🔊" : "🔇";
  b.setAttribute("aria-label", soundOn() ? "Mute sound" : "Turn sound on");
}
renderSoundBtn();

// ---------- Results ----------
function showResults(r: RoomView): void {
  const g = r.game!;
  const list = $("ranking");
  list.replaceChildren();
  g.ranking.forEach((color, i) => {
    const seat = seatOf(color, r);
    const li = h("li", `rank-row${seat?.id === r.you ? " me" : ""}`);
    li.style.setProperty("--c", PALETTE[color].main);
    li.appendChild(h("span", "medal", ["🥇", "🥈", "🥉", "4"][i]));
    li.appendChild(avatar(seat, color));
    li.appendChild(h("span", "rank-name", seat ? (seat.id === r.you ? `${seat.name} (you)` : seat.name) : COLOR_NAMES[color]));
    list.appendChild(li);
  });

  const winner = seatOf(g.ranking[0], r);
  const iWon = winner?.id === r.you;
  $("results-title").textContent = iWon ? "You win! 🎉" : `${winner?.name ?? "Someone"} wins!`;
  const isHost = mySeat(r)?.id === r.host;
  $("again-btn").classList.toggle("hidden", !isHost);
  $("again-hint").textContent = isHost ? "" : "Waiting for the host to start another game…";
  openModal("results");
  if (iWon) {
    play("win");
    buzz([60, 40, 60, 40, 120]);
  } else play("home");
  confetti($<HTMLCanvasElement>("confetti"), iWon ? 4000 : 2500);
}

$("again-btn").addEventListener("click", () => conn.send({ t: "again" }));
$("home-btn").addEventListener("click", () => conn.send({ t: "leave" }));

function openModal(id: string): void {
  $(id).classList.remove("hidden");
  $(id).querySelector<HTMLElement>(".btn:not(.hidden)")?.focus();
}
function closeModal(id: string): void {
  $(id).classList.add("hidden");
}

// ---------- Leaving ----------
$("game-leave").addEventListener("click", () => {
  if (room?.status === "playing") openModal("confirm");
  else conn.send({ t: "leave" });
});
$("confirm-yes").addEventListener("click", () => {
  closeModal("confirm");
  conn.send({ t: "leave" });
});
$("confirm-no").addEventListener("click", () => closeModal("confirm"));

// ---------- Chat & reactions ----------
function emojiButtons(host: HTMLElement): void {
  for (const e of EMOJIS) {
    const b = h("button", "emoji-btn", e);
    b.type = "button";
    b.setAttribute("aria-label", `Send ${e}`);
    b.addEventListener("click", () => {
      unlockAudio();
      conn.send({ t: "emoji", emoji: e });
    });
    host.appendChild(b);
  }
}
emojiButtons($("react-bar"));
emojiButtons($("chat-emojis"));

function onChat(msg: ChatMessage): void {
  chat.push(msg);
  chat = chat.slice(-50);
  renderChat();
  const mine = msg.seat === room?.you;
  if (!chatOpen && !mine) {
    unread++;
    renderBadge();
  }
  if (!mine) play("pop");

  // Show it as a bubble next to the sender during a game.
  const seat = room?.seats.find((s) => s.id === msg.seat);
  const panel = seat && room?.game ? panels.get(seat.color) : undefined;
  if (panel?.isConnected) {
    const bubble = panel.querySelector<HTMLElement>(".bubble")!;
    bubble.textContent = msg.emoji ?? (msg.text!.length > 40 ? `${msg.text!.slice(0, 40)}…` : msg.text!);
    bubble.classList.toggle("big", !!msg.emoji);
    bubble.classList.remove("show");
    void bubble.offsetWidth;
    bubble.classList.add("show");
  } else if (!mine && !chatOpen) {
    toast(`${msg.name}: ${msg.emoji ?? msg.text}`);
  }
}

function renderChat(): void {
  const log = $("chat-log");
  log.replaceChildren();
  if (!chat.length) log.appendChild(h("li", "chat-empty", "No messages yet. Say hi! 👋"));
  for (const m of chat) {
    const li = h("li", `chat-msg${m.seat === room?.you ? " mine" : ""}`);
    li.style.setProperty("--c", PALETTE[m.color].main);
    li.appendChild(h("span", "chat-name", m.name));
    li.appendChild(h("span", m.emoji ? "chat-text emoji" : "chat-text", m.emoji ?? m.text));
    log.appendChild(li);
  }
  log.scrollTop = log.scrollHeight;
}

function renderBadge(): void {
  for (const b of document.querySelectorAll(".chat-toggle .badge")) {
    b.textContent = unread > 9 ? "9+" : String(unread);
    b.classList.toggle("hidden", unread === 0);
  }
}

function openChat(): void {
  chatOpen = true;
  unread = 0;
  renderBadge();
  $("chat").classList.add("open");
  $("chat").setAttribute("aria-hidden", "false");
  document.body.classList.add("chat-open");
  renderChat();
  if (matchMedia("(pointer: fine)").matches) $("chat-input").focus();
}

function closeChat(): void {
  chatOpen = false;
  $("chat").classList.remove("open");
  $("chat").setAttribute("aria-hidden", "true");
  document.body.classList.remove("chat-open");
}

for (const b of document.querySelectorAll(".chat-toggle")) {
  b.addEventListener("click", () => (chatOpen ? closeChat() : openChat()));
}
$("chat-close").addEventListener("click", closeChat);
$("chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>("chat-input");
  const text = input.value.trim();
  if (!text) return;
  conn.send({ t: "chat", text });
  input.value = "";
});

// ---------- Keyboard ----------
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!$("confirm").classList.contains("hidden")) closeModal("confirm");
    else if (chatOpen) closeChat();
    return;
  }
  const typing = (e.target as HTMLElement).closest("input, textarea");
  if (typing || document.body.dataset.screen !== "game" || !room?.game) return;
  const g = room.game;
  if ((e.key === " " || e.key === "Enter") && g.phase === "roll" && isMyTurn()) {
    e.preventDefault();
    rollDice();
  } else if (/^[1-4]$/.test(e.key) && g.phase === "move" && isMyTurn()) {
    const token = Number(e.key) - 1;
    if (g.movable.includes(token)) conn.send({ t: "move", token });
  }
});

// Audio can only start after a user gesture.
document.addEventListener("pointerdown", unlockAudio, { once: true });

showScreen("home");
if (inviteCode) {
  toast(`Joining room ${inviteCode} — enter your name and tap Join`, "info", 4000);
  (nameInput.value ? $("code-input") : nameInput).focus();
}
