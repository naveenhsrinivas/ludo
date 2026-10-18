import { randomInt } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientMessage, ServerMessage } from "../shared/protocol.js";
import { cleanName, Room, type Seat } from "./room.js";

const PORT = Number(process.env.PORT) || 8787;
const MAX_ROOMS = 1000;
const ROOM_IDLE_MS = 10 * 60_000; // drop rooms nobody has been connected to for this long
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O or 1/I mix-ups

// Built client files (only present after `npm run build`).
const here = fileURLToPath(new URL(".", import.meta.url));
const CLIENT_DIR = resolve(here, "../../client");

const rooms = new Map<string, Room>();

function newCode(): string {
  for (;;) {
    const code = Array.from({ length: 5 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join("");
    if (!rooms.has(code)) return code;
  }
}

// ---------- Static files ----------
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405).end();
    return;
  }

  let path: string;
  try {
    path = normalize(join(CLIENT_DIR, decodeURIComponent(url.pathname)));
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (path !== CLIENT_DIR && !path.startsWith(CLIENT_DIR + sep)) {
    res.writeHead(403).end();
    return;
  }

  let file = path;
  try {
    if (!statSync(file).isFile()) throw new Error();
  } catch {
    file = join(CLIENT_DIR, "index.html"); // single-page app: unknown paths get the app
  }

  try {
    const { size } = statSync(file);
    const hashed = file.includes(`${sep}assets${sep}`);
    res.writeHead(200, {
      "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
      "Content-Length": size,
      "Cache-Control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
      "X-Content-Type-Options": "nosniff",
    });
    if (req.method === "HEAD") res.end();
    else createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not built yet. Run `npm run build`, or use `npm run dev`.");
  }
}

// ---------- WebSocket ----------
const server = createServer(serveStatic);
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 4 * 1024 });

interface Conn {
  room: Room | null;
  seat: Seat | null;
}

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function isSecret(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(v);
}

function seatIn(ws: WebSocket, conn: Conn, room: Room, seat: Seat | string): void {
  if (typeof seat === "string") {
    send(ws, { t: "error", message: seat });
    return;
  }
  if (conn.room && conn.room !== room && conn.seat) conn.room.disconnect(ws);
  conn.room = room;
  conn.seat = seat;
  send(ws, { t: "chatHistory", msgs: room.chat });
}

function handle(ws: WebSocket, conn: Conn, msg: ClientMessage): string | void {
  switch (msg.t) {
    case "create": {
      if (!isSecret(msg.secret)) return "Invalid session.";
      if (rooms.size >= MAX_ROOMS) return "The server is busy. Please try again later.";
      const room = new Room(newCode());
      rooms.set(room.code, room);
      seatIn(ws, conn, room, room.join(ws, cleanName(msg.name), msg.secret));
      const bots = Math.min(3, Math.max(0, Number(msg.bots) || 0));
      for (let i = 0; i < bots && conn.seat; i++) room.addBot(conn.seat);
      if (msg.start && conn.seat) return room.start(conn.seat);
      return;
    }
    case "join": {
      if (!isSecret(msg.secret)) return "Invalid session.";
      const code = typeof msg.code === "string" ? msg.code.trim().toUpperCase() : "";
      const room = rooms.get(code);
      if (!room) return "No game found with that code. Check it and try again.";
      seatIn(ws, conn, room, room.join(ws, cleanName(msg.name), msg.secret));
      return;
    }
  }

  const { room, seat } = conn;
  if (!room || !seat) return "You're not in a game.";
  switch (msg.t) {
    case "addBot":
      return room.addBot(seat);
    case "removeSeat":
      return typeof msg.seat === "string" ? room.removeSeat(seat, msg.seat) : undefined;
    case "start":
      return room.start(seat);
    case "roll":
      return room.roll(seat);
    case "move":
      return Number.isInteger(msg.token) ? room.move(seat, msg.token) : undefined;
    case "chat":
      return room.chatMessage(seat, msg.text, undefined);
    case "emoji":
      return room.chatMessage(seat, undefined, msg.emoji);
    case "again":
      return room.again(seat);
    case "leave":
      room.leave(seat);
      conn.room = conn.seat = null;
      send(ws, { t: "left" });
      return;
  }
}

wss.on("connection", (ws) => {
  const conn: Conn = { room: null, seat: null };
  let alive = true;
  ws.on("pong", () => (alive = true));
  const ping = setInterval(() => {
    if (!alive) return ws.terminate();
    alive = false;
    ws.ping();
  }, 25_000);

  ws.on("message", (data) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(String(data));
      if (!msg || typeof msg !== "object" || typeof msg.t !== "string") throw new Error();
    } catch {
      return send(ws, { t: "error", message: "Bad message." });
    }
    try {
      const error = handle(ws, conn, msg);
      if (error) send(ws, { t: "error", message: error });
    } catch (err) {
      console.error("Error handling message", msg.t, err);
      send(ws, { t: "error", message: "Something went wrong." });
    }
  });

  // Without this, a bad frame (e.g. an oversized message) would crash the server.
  ws.on("error", () => ws.terminate());

  ws.on("close", () => {
    clearInterval(ping);
    conn.room?.disconnect(ws);
  });
});

// Clean up rooms nobody is connected to any more.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (!room.hasHumansOnline() && room.emptySince && now - room.emptySince > ROOM_IDLE_MS) {
      room.dispose();
      rooms.delete(code);
    }
  }
}, 60_000).unref();

server.listen(PORT, () => {
  console.log(`Ludo server running at http://localhost:${PORT}`);
});
