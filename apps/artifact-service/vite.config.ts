import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === "browser-test" ? [] : [cloudflare()])],
  environments: {
    client: {
      build: {
        rollupOptions: {
          input: {
            main: fileURLToPath(new URL("./index.html", import.meta.url)),
            "homepage-validation": fileURLToPath(new URL("./src/web/file-validation.ts", import.meta.url)),
          },
          output: {
            entryFileNames: (chunk) =>
              chunk.name === "homepage-validation"
                ? "assets/homepage-validation.js"
                : "assets/[name]-[hash].js",
          },
        },
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 8787,
    strictPort: true,
  },
}));
