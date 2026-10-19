# 🎲 Ludo Live

Play Ludo in the browser with friends or against the computer. Works on phones, tablets and computers.

## Features

- **Play with friends:** create a room and share its 5-letter code or invite link. 2–4 players.
- **Computer players:** fill empty seats with bots, or play solo against 1–3 of them.
- **Chat and emoji reactions:** reactions pop up next to the player who sent them.
- **Stickers:** tap another player to throw a 🌹 rose, 💣 bomb, 🍅 tomato, 💋 kiss, ❤️ heart, 🥚 egg, 👑 crown or 🐔 chicken. Each one has its own effect. Computer players sometimes throw one back after a capture.
- **Gems 💎:** everyone gets 5 per game. Spend one to re-roll the dice, either to swap a bad number or to try again when you have no moves.
- **Dice skins:** pick Classic, Ruby, Gold, Galaxy, Neon or Wood. Everyone sees your skin when you roll.
- **House rules (host, in the waiting room):**
  - **Easy sixes** (on by default): while all your tokens are at home, a 6 comes up 40% of the time, and you get one by your third roll at the latest.
  - **Gems:** on by default.
  - **Quick start:** everyone begins with one token out.
- **Classic rules:**
  - Roll a 6 to bring a token out.
  - A 6, a capture, or getting a token home earns another roll. Three 6s in a row lose your turn.
  - Stars and start squares are safe.
  - You need the exact number to reach home.
  - Play continues until everyone has a finishing place.
- **Fair play:** the server rolls the dice and checks every move, so players can't cheat from their browser.
- **Reconnecting:** if your connection drops, you get your seat back automatically. If someone is away, a computer plays their turn after a timeout (30 seconds, or 4 seconds if they're offline) so the game keeps going. If everyone leaves, the game pauses.
- **Polish:**
  - Each player sees their own colour at the bottom left.
  - Tokens hop square by square, and a 3D dice tumbles.
  - Banners pop up for sixes, captures and tokens reaching home, and the board shakes on a capture.
  - Sound effects (with a mute button), vibration on phones, and confetti for the winner.

## Run locally

Requires Node.js 20+.

```bash
npm install
npm run dev     # game server on :8787 + Vite on http://localhost:5173 (with hot reload)
```

Open http://localhost:5173 in two browser windows (or one normal and one private) to play against yourself.

Production build:

```bash
npm run build   # type-check, build the client to dist/client and the server to dist/server
npm start       # serves the game and the WebSocket on http://localhost:8787 (set PORT to change)
npm test        # rules tests, 600 simulated games, and end-to-end server tests
```

## How it's built

```
shared/   board.ts     board layout (track, home columns, safe squares)
          rules.ts     game rules — pure functions, used by the server and tests
          bot.ts       computer player (moves and when to spend gems)
          protocol.ts  WebSocket message types
server/   index.ts     HTTP server for the built client + WebSocket endpoint at /ws
          room.ts      rooms, seats, turn timers, bots, chat
client/   index.html, src/main.ts (screens and app flow), board.ts (SVG board and
          animations), dice.ts (3D dice and skins), stickers.ts (sticker effects),
          sound.ts, net.ts (auto-reconnecting socket), style.css
```

Rooms live in the server's memory. Restarting the server ends any games in progress.

## Hosting

The game needs a Node.js host that supports WebSockets. GitHub Pages won't work, because it can't run a server.

**Render (free):** `render.yaml` sets everything up.

1. In Render, choose **New → Blueprint**.
2. Pick this repo, then click **Apply**.
3. Every push to `main` redeploys automatically.

On the free plan the server sleeps after 15 minutes with no visitors. The first visit afterwards takes about a minute to load. Browsers in a room send a small keep-alive every 4 minutes, so a game in progress doesn't put the server to sleep.

**Other hosts (Railway, Fly.io…):**

- **Build command:** `npm ci && npm run build`
- **Start command:** `npm start`
- **Health check:** `/health`
