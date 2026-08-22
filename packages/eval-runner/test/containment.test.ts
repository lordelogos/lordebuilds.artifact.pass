import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  assertLoopbackOrigin,
  assertPathWithinRoot,
  assertRoutineNetworkTarget,
  createLocalEvalProcessEnvironment,
} from "../src/local-environment";

const execute = promisify(execFile);

describe("local eval containment", () => {
  it.each([
    "https://artifactpass.com",
    "http://192.168.1.20:8787",
    "http://127.0.0.1:8787/upload",
    "http://user:secret@127.0.0.1:8787",
  ])("rejects the non-routine origin %s", (origin) => {
    expect(() => assertLoopbackOrigin(new URL(origin))).toThrow(/loopback/u);
  });

  it("accepts only plain loopback HTTP origins", () => {
    expect(() => assertLoopbackOrigin(new URL("http://127.0.0.1:8787"))).not.toThrow();
    expect(() => assertLoopbackOrigin(new URL("http://localhost:8787"))).not.toThrow();
  });

  it("permits only the selected local service and does not inherit production credentials", () => {
    const origin = new URL("http://127.0.0.1:8787");
    expect(() => assertRoutineNetworkTarget(new URL("/health", origin), origin)).not.toThrow();
    expect(() => assertRoutineNetworkTarget(new URL("http://127.0.0.1:9999/health"), origin)).toThrow(/escaped/u);
    const environment = createLocalEvalProcessEnvironment("/tmp/artifactpass-eval-home");
    expect(environment).not.toHaveProperty("CLOUDFLARE_API_TOKEN");
    expect(environment).not.toHaveProperty("ARTIFACTPASS_TOKEN");
    expect(environment).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(environment).not.toHaveProperty("OPENAI_API_KEY");
  });

  it("applies the scrubbed home and temporary directory to a real child process", async () => {
    const home = await mkdtemp(join(tmpdir(), "artifactpass-contained-child-"));
    const temporary = join(home, "tmp");
    await mkdir(temporary);
    try {
      const result = await execute(process.execPath, [
        "-e",
        "process.stdout.write(JSON.stringify({home:process.env.HOME,tmp:process.env.TMPDIR,cloudflare:process.env.CLOUDFLARE_API_TOKEN,openai:process.env.OPENAI_API_KEY}))",
      ], {
        env: createLocalEvalProcessEnvironment(home),
      });
      expect(JSON.parse(result.stdout)).toEqual({ home, tmp: temporary });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects traversal and symbolic-link escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "artifactpass-containment-root-"));
    const outside = await mkdtemp(join(tmpdir(), "artifactpass-containment-outside-"));
    await mkdir(join(root, "safe"));
    await symlink(outside, join(root, "escape"));
    await expect(assertPathWithinRoot(root, join(root, "safe", "result.json"))).resolves.toBeUndefined();
    await expect(assertPathWithinRoot(root, join(root, "..", "outside.json"))).rejects.toThrow(/escaped/u);
    await expect(assertPathWithinRoot(root, join(root, "escape", "result.json"))).rejects.toThrow(/symbolic link/u);
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  });
});
