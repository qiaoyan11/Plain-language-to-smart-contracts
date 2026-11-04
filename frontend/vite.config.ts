import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { nitro } from "nitro/vite";

export default defineConfig(({ command }) => ({
  plugins: [
    tsconfigPaths(),
    tailwindcss(),
    tanstackStart({ server: { entry: "server" } }),
    react(),
    ...(command === "build" ? [nitro({ preset: "node-server" })] : []),
  ],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: { "/api": "http://127.0.0.1:3001" },
  },
  resolve: { dedupe: ["react", "react-dom", "@tanstack/react-router"] },
}));
