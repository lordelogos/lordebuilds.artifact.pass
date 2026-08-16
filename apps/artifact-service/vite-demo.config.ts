import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    react(),
    cloudflare({
      configPath: process.env.ARTIFACT_SHARE_DEMO_CONFIG_PATH ?? "./wrangler-demo.jsonc",
      persistState: {
        path: process.env.ARTIFACT_SHARE_DEMO_STATE_PATH ?? ".wrangler/demo-state",
      },
    }),
  ],
  server: {
    host: process.env.ARTIFACT_SHARE_DEMO_HOST ?? "0.0.0.0",
    port: Number(process.env.ARTIFACT_SHARE_DEMO_PORT ?? "8787"),
    strictPort: true,
    open: process.env.ARTIFACT_SHARE_DEMO_NO_OPEN === "1" ? false : "/upload",
  },
});
