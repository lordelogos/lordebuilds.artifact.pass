import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

import { staticPublicAssets } from "../artifact-service/src/build/static-public-assets.ts";

const outputDirectory = fileURLToPath(new URL("./dist", import.meta.url));

export default defineConfig({
  publicDir: fileURLToPath(new URL("../artifact-service/public", import.meta.url)),
  plugins: [staticPublicAssets(outputDirectory)],
  build: {
    outDir: outputDirectory,
    emptyOutDir: true,
    rollupOptions: {
      input: {
        "homepage-validation": fileURLToPath(new URL(
          "../artifact-service/src/web/file-validation.ts",
          import.meta.url,
        )),
      },
      output: {
        entryFileNames: "assets/[name].js",
      },
    },
  },
});
