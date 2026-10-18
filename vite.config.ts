import { defineConfig } from "vite";

export default defineConfig({
  root: "client",
  build: { outDir: "../dist/client", emptyOutDir: true },
  server: {
    port: 5173,
    // In development the game server runs separately on port 8787.
    proxy: { "/ws": { target: "ws://localhost:8787", ws: true } },
  },
});
