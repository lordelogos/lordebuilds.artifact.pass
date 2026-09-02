import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
process.chdir(repositoryRoot);
const root = await mkdtemp(resolve(repositoryRoot, "packages/setup-cli/.artifactpass-private-resilience-runner-"));
const output = resolve(root, "qualification.mjs");
try {
  await build({
    entryPoints: [resolve("scripts/qualify-private-resilience.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: output,
    logLevel: "silent",
  });
  const loaded = await import(`${pathToFileURL(output).href}?run=${Date.now()}`);
  await loaded.runPrivateResilienceQualification();
} finally {
  await rm(root, { recursive: true, force: true });
}
