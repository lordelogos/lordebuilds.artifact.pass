import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = resolve(repositoryRoot, "packages/setup-cli");
const outputRoot = resolve(packageRoot, "dist");
const serviceRoot = resolve(repositoryRoot, "apps/artifact-service");
const builtWorkerRoot = resolve(serviceRoot, "dist/lordebuilds_artifacts_share");

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
await build({
  entryPoints: [resolve(packageRoot, "src/cli.ts")],
  outfile: resolve(outputRoot, "cli.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  external: ["@modelcontextprotocol/client", "@modelcontextprotocol/client/stdio"],
  banner: { js: "#!/usr/bin/env node" },
});
await cp(
  resolve(packageRoot, "install-receipt.schema.json"),
  resolve(outputRoot, "install-receipt.schema.json"),
);
await cp(
  resolve(packageRoot, "install-receipt-v1.schema.json"),
  resolve(outputRoot, "install-receipt-v1.schema.json"),
);
await cp(
  resolve(packageRoot, "install-receipt-v2.schema.json"),
  resolve(outputRoot, "install-receipt-v2.schema.json"),
);

const deploymentRoot = resolve(outputRoot, "deployment");
await mkdir(deploymentRoot, { recursive: true });
await cp(resolve(builtWorkerRoot, "index.js"), resolve(deploymentRoot, "index.js"));
await cp(resolve(serviceRoot, "dist/client"), resolve(deploymentRoot, "client"), { recursive: true });
await cp(resolve(serviceRoot, "migrations"), resolve(deploymentRoot, "migrations"), { recursive: true });
await cp(resolve(serviceRoot, "storage-lifecycle.json"), resolve(deploymentRoot, "storage-lifecycle.json"));
const workerConfiguration = JSON.parse(await readFile(resolve(builtWorkerRoot, "wrangler.json"), "utf8"));
workerConfiguration.main = "./index.js";
workerConfiguration.assets.directory = "./client";
workerConfiguration.d1_databases[0].migrations_dir = "./migrations";
await writeFile(
  resolve(deploymentRoot, "wrangler-template.json"),
  `${JSON.stringify(workerConfiguration, null, 2)}\n`,
);

const marketplaceRoot = resolve(outputRoot, "marketplace");
await mkdir(resolve(marketplaceRoot, ".agents/plugins"), { recursive: true });
await mkdir(resolve(marketplaceRoot, ".claude-plugin"), { recursive: true });
await mkdir(resolve(marketplaceRoot, "plugins"), { recursive: true });
await cp(
  resolve(repositoryRoot, ".agents/plugins/marketplace.json"),
  resolve(marketplaceRoot, ".agents/plugins/marketplace.json"),
);
await cp(
  resolve(repositoryRoot, ".claude-plugin/marketplace.json"),
  resolve(marketplaceRoot, ".claude-plugin/marketplace.json"),
);
await cp(
  resolve(repositoryRoot, "plugins/artifactpass"),
  resolve(marketplaceRoot, "plugins/artifactpass"),
  { recursive: true },
);
