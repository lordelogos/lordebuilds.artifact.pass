import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(new URL("../../..", import.meta.url).pathname);
const scanner = join(repositoryRoot, "scripts/scan-secrets.mjs");

const commitAll = (root: string, message: string) => {
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", [
    "-c", "user.name=ArtifactPass Test",
    "-c", "user.email=test@artifactpass.test",
    "commit", "--quiet", "-m", message,
  ], { cwd: root });
};

const createRepository = async () => {
  const root = await mkdtemp(join(tmpdir(), "artifactpass-secret-history-"));
  execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: root });
  await writeFile(join(root, "README.md"), "clean\n");
  commitAll(root, "initial");
  return root;
};

describe("history-aware secret scanning", () => {
  it("blocks a credential removed from the current checkout but retained in history", async () => {
    const root = await createRepository();
    const historicalSecret = `cf${"ut_"}${"a".repeat(32)}`;
    await writeFile(join(root, "temporary.txt"), `${historicalSecret}\n`);
    commitAll(root, "add credential");
    await writeFile(join(root, "temporary.txt"), "removed\n");
    commitAll(root, "remove credential");

    const execution = spawnSync(process.execPath, [scanner, "--history"], {
      cwd: root,
      encoding: "utf8",
    });

    expect(execution.status).not.toBe(0);
    expect(execution.stderr).toContain("Cloudflare user token");
    expect(execution.stderr).not.toContain(historicalSecret);
  });

  it("writes a redacted ref-closure and identity-metadata report", async () => {
    const root = await createRepository();
    const reportPath = join(root, "audit-report.json");
    const inertCapability = `https://artifacts.example/a/${"s".repeat(43)}`;
    await writeFile(join(root, "fixture.txt"), `${inertCapability}\n`);
    commitAll(root, "add inert reserved-domain fixture");

    const execution = spawnSync(process.execPath, [
      scanner,
      "--history",
      "--report",
      reportPath,
    ], { cwd: root, encoding: "utf8" });

    expect(execution.status).toBe(0);
    const report = JSON.parse(await readFile(reportPath, "utf8")) as {
      readonly status: string;
      readonly history: { readonly closure_sha256: string; readonly blob_count: number };
      readonly identity_metadata: readonly { readonly name: string; readonly email: string }[];
    };
    expect(report.status).toBe("pass");
    expect(report.history.closure_sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(report.history.blob_count).toBeGreaterThan(0);
    expect(report.identity_metadata).toContainEqual({
      name: "ArtifactPass Test",
      email: "test@artifactpass.test",
    });
  });
});
