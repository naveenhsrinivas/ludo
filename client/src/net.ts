import type { ClientMessage, ServerMessage } from "../../shared/protocol.js";

type Listener = (msg: ServerMessage) => void;
type StatusListener = (online: boolean) => void;

/** A WebSocket that reconnects on its own, with backoff. */
export class Connection {
  private ws: WebSocket | null = null;
  private retry = 0;
  private queue: ClientMessage[] = [];
  private listeners: Listener[] = [];
  private statusListeners: StatusListener[] = [];
  /** Sent first after every (re)connect, e.g. to rejoin a room. */
  hello: () => ClientMessage | null = () => null;

  constructor(private url: string) {
    this.open();
    // Phones often drop sockets in the background; reconnect when we come back.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && !this.online) this.open();
    });
    window.addEventListener("online", () => this.open());
    // Free hosting (e.g. Render) sleeps after 15 idle minutes; a small message keeps a game awake.
    setInterval(() => {
      if (this.online && this.keepAlive()) this.ws!.send(JSON.stringify({ t: "ping" }));
    }, 4 * 60_000);
  }

  /** Whether to send keep-alives (only while in a room). */
  keepAlive: () => boolean = () => false;

  get online(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  onMessage(fn: Listener): void {
    this.listeners.push(fn);
  }

  onStatus(fn: StatusListener): void {
    this.statusListeners.push(fn);
  }

  send(msg: ClientMessage): void {
    if (this.online) this.ws!.send(JSON.stringify(msg));
    else this.queue.push(msg);
  }

  private open(): void {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.retry = 0;
      const hello = this.hello();
      if (hello) ws.send(JSON.stringify(hello));
      for (const m of this.queue.splice(0)) ws.send(JSON.stringify(m));
      this.statusListeners.forEach((fn) => fn(true));
    };
    ws.onmessage = (e) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(e.data as string);
      } catch {
        return;
      }
      this.listeners.forEach((fn) => fn(msg));
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.statusListeners.forEach((fn) => fn(false));
      const delay = Math.min(10_000, 500 * 2 ** this.retry++);
      setTimeout(() => this.open(), delay);
    };
  }
}

export function socketUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}
