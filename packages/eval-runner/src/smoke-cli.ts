import { resolve } from "node:path";

import { runModelSmoke } from "./model-smoke";

const main = async (): Promise<void> => {
  const index = process.argv.indexOf("--host");
  const host = index < 0 ? undefined : process.argv[index + 1];
  if (host !== "codex" && host !== "claude") {
    throw new Error("Usage: pnpm eval:smoke --host <codex|claude>");
  }
  const result = await runModelSmoke({ host, repositoryRoot: resolve(process.cwd()) });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status !== "completed" || result.report?.result.outcome !== "pass") process.exitCode = 1;
};

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Model smoke failed"}\n`);
  process.exitCode = 1;
});
