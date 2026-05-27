/// <reference types="vitest" />
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  server: {
    port: 5173,
    host: true,            // listen on 0.0.0.0 — required inside Docker
    strictPort: true,
    proxy: {
      // VITE_API_TARGET is set in docker-compose.dev.yml so the proxy can
      // reach the backend service over the compose network. Defaults to
      // localhost:8000 for non-docker dev (two-terminal setup).
      "/api": process.env.VITE_API_TARGET ?? "http://localhost:8000",
    },
  },
  build: {
    outDir: "dist",
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
  },
});
