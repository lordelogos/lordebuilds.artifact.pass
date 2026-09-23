import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

import { staticPublicAssets } from "./src/build/static-public-assets.ts";

const browserTestUploadEntry = (): Plugin => ({
  name: "artifactpass-browser-test-upload-entry",
  configureServer(server) {
    server.middlewares.use((request, _response, next) => {
      if (request.url !== undefined) {
        const requestUrl = new URL(request.url, "http://artifactpass.local");
        if (requestUrl.pathname === "/" || requestUrl.pathname === "/upload") {
          request.url = `/upload.html${requestUrl.search}`;
        }
      }
      next();
    });
  },
});

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    staticPublicAssets(fileURLToPath(new URL("./dist/client", import.meta.url))),
    ...(mode === "browser-test" ? [browserTestUploadEntry()] : [cloudflare()]),
  ],
  environments: {
    client: {
      build: {
        rollupOptions: {
          input: {
            main: fileURLToPath(new URL("./upload.html", import.meta.url)),
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
