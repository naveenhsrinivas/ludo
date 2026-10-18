// End-to-end: runs the real server and plays games over WebSockets.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { after, before, test } from "node:test";
import { WebSocket } from "ws";
import type { ChatMessage, ClientMessage, RoomView, ServerMessage } from "../shared/protocol.js";

const PORT = 8799;
let server: ChildProcess;

before(async () => {
  server = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    // Speed up bot and animation delays so a full game takes seconds.
    env: { ...process.env, PORT: String(PORT), LUDO_TIME_SCALE: "0.01" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((resolve) => server.stdout!.on("data", (d) => String(d).includes("running") && resolve()));
});

after(() => server.kill());

class Player {
  ws!: WebSocket;
  room: RoomView | null = null;
  chat: ChatMessage[] = [];
  errors: string[] = [];
  autoplay = false;
  private waiters: (() => void)[] = [];

  constructor(readonly name: string, readonly secret = `secret-${name}-${Math.random().toString(36).slice(2, 12)}`) {}

  async connect(): Promise<void> {
    this.ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    this.ws.on("message", (d) => this.onMessage(JSON.parse(String(d))));
    await new Promise((r) => this.ws.once("open", r));
  }

  private onMessage(msg: ServerMessage): void {
    if (msg.t === "room") this.room = msg.room;
    if (msg.t === "chat") this.chat.push(msg.msg);
    if (msg.t === "error") this.errors.push(msg.message);
    if (msg.t === "room" && this.autoplay) this.act();
    this.waiters.splice(0).forEach((w) => w());
  }

  /** Play instantly whenever it's our turn. */
  private act(): void {
    const r = this.room!;
    const g = r.game;
    const me = r.seats.find((s) => s.id === r.you);
    if (!g || r.status !== "playing" || !me || g.colors[g.turn] !== me.color) return;
    if (g.phase === "roll") this.send({ t: "roll" });
    else this.send({ t: "move", token: g.movable[0] });
  }

  send(msg: ClientMessage): void {
    this.ws.send(JSON.stringify(msg));
  }

  async until(check: (p: Player) => boolean, ms = 5000): Promise<void> {
    const end = Date.now() + ms;
    while (!check(this)) {
      if (Date.now() > end) throw new Error(`${this.name}: timed out waiting`);
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, 50);
      });
    }
  }

  close(): void {
    this.ws.close();
  }
}

test("create, join, chat, add a computer player and play a full game", { timeout: 120_000 }, async () => {
  const alice = new Player("Alice");
  const bob = new Player("Bob");
  await alice.connect();
  await bob.connect();

  alice.send({ t: "create", name: "  Alice  ", secret: alice.secret });
  await alice.until((p) => !!p.room);
  const code = alice.room!.code;
  assert.match(code, /^[A-Z2-9]{5}$/);
  assert.equal(alice.room!.seats[0].name, "Alice", "names are trimmed");

  bob.send({ t: "join", code: code.toLowerCase(), name: "Bob", secret: bob.secret });
  await bob.until((p) => p.room?.seats.length === 2);

  // Only the host can start or add players.
  bob.send({ t: "start" });
  await bob.until((p) => p.errors.length > 0);
  assert.match(bob.errors[0], /host/);

  alice.send({ t: "addBot" });
  await alice.until((p) => p.room?.seats.length === 3);
  assert.deepEqual(alice.room!.seats.map((s) => s.color), ["red", "green", "yellow"]);

  bob.send({ t: "chat", text: "hi\u0000 there   everyone" });
  bob.send({ t: "emoji", emoji: "🎉" });
  bob.send({ t: "emoji", emoji: "<script>" });
  await alice.until((p) => p.chat.length === 2);
  assert.equal(alice.chat[0].text, "hi there everyone", "control characters and extra spaces removed");
  assert.equal(alice.chat[1].emoji, "🎉");

  alice.autoplay = bob.autoplay = true;
  alice.send({ t: "start" });
  await alice.until((p) => p.room?.status === "playing");

  await alice.until((p) => p.room?.status === "over", 110_000);
  await bob.until((p) => p.room?.status === "over");
  const ranking = alice.room!.game!.ranking;
  assert.equal(ranking.length, 3);
  assert.deepEqual(bob.room!.game!.ranking, ranking, "everyone sees the same result");

  // Back to the lobby for another round, keeping the players.
  alice.send({ t: "again" });
  await bob.until((p) => p.room?.status === "lobby");
  assert.equal(bob.room!.seats.length, 3);
  alice.close();
  bob.close();
});

test("a player who disconnects mid-game can rejoin their seat", { timeout: 30_000 }, async () => {
  const host = new Player("Host");
  await host.connect();
  host.send({ t: "create", name: "Host", secret: host.secret });
  await host.until((p) => !!p.room);
  const code = host.room!.code;

  const guest = new Player("Guest");
  await guest.connect();
  guest.send({ t: "join", code, name: "Guest", secret: guest.secret });
  await host.until((p) => p.room?.seats.length === 2);
  host.send({ t: "start" });
  await guest.until((p) => p.room?.status === "playing");
  const seatId = guest.room!.you;

  guest.close();
  await host.until((p) => p.room!.seats.some((s) => s.id === seatId && !s.connected));

  // A stranger can't join a game in progress…
  const stranger = new Player("Stranger");
  await stranger.connect();
  stranger.send({ t: "join", code, name: "Stranger", secret: stranger.secret });
  await stranger.until((p) => p.errors.length > 0);
  assert.match(stranger.errors[0], /already started/);

  // …but the same browser (same secret) gets its seat back.
  const back = new Player("Guest", guest.secret);
  await back.connect();
  back.send({ t: "join", code, name: "Guest", secret: guest.secret });
  await back.until((p) => p.room?.status === "playing");
  assert.equal(back.room!.you, seatId);
  await host.until((p) => p.room!.seats.find((s) => s.id === seatId)!.connected);

  // Acting out of turn does nothing.
  const g = back.room!.game!;
  const outOfTurn = g.colors[g.turn] === "red" ? back : host;
  outOfTurn.send({ t: "roll" });
  await outOfTurn.until((p) => p.errors.some((e) => /not your turn/.test(e)));

  host.close();
  back.close();
  stranger.close();
});

test("bad input is rejected without crashing the server", { timeout: 10_000 }, async () => {
  const p = new Player("Mallory");
  await p.connect();
  p.ws.send("not json");
  p.send({ t: "join", code: "ZZZZZ", name: "M", secret: p.secret });
  p.send({ t: "create", name: "M", secret: "short" });
  p.send({ t: "roll" });
  await p.until((x) => x.errors.length >= 4);
  assert.match(p.errors[0], /Bad message/);
  assert.match(p.errors[1], /No game found/);
  assert.match(p.errors[2], /Invalid session/);
  assert.match(p.errors[3], /not in a game/);

  // Oversized messages close the connection; the server keeps running.
  p.ws.send("x".repeat(10_000));
  await new Promise((r) => p.ws.once("close", r));
  const q = new Player("Quinn");
  await q.connect();
  q.send({ t: "create", name: "Q", secret: q.secret, bots: 3, start: true });
  await q.until((x) => x.room?.status === "playing");
  assert.equal(q.room!.seats.length, 4);
  q.close();
});
