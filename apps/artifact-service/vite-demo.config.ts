import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    react(),
    cloudflare({
      configPath: "./wrangler-demo.jsonc",
      persistState: { path: ".wrangler/demo-state" },
    }),
  ],
  server: {
    host: "0.0.0.0",
    port: 8787,
    strictPort: true,
    open: "/upload",
  },
});
