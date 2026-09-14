import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execute = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../../..");
const validator = resolve(repositoryRoot, "scripts/validate-candidate-tag.mjs");

const fixture = async (version: string) => {
  const root = await mkdtemp(resolve(tmpdir(), "artifactpass-tag-validation-"));
  await mkdir(resolve(root, "packages/setup-cli"), { recursive: true });
  await mkdir(resolve(root, "plugins/artifactpass"), { recursive: true });
  for (const path of ["package.json", "packages/setup-cli/package.json", "plugins/artifactpass/plugin-metadata.json"]) {
    await writeFile(resolve(root, path), JSON.stringify({ version }));
  }
  const git = (...args: string[]) => execute("git", args, { cwd: root });
  await git("init");
  await git("config", "user.email", "release-test@example.invalid");
  await git("config", "user.name", "Release Test");
  await git("add", ".");
  await git("commit", "-m", "initial");
  const initial = (await git("rev-parse", "HEAD")).stdout.trim();
  await git("update-ref", "refs/remotes/origin/main", initial);
  return { root, git, initial };
};

const validate = async (root: string, version: string, visibility = "public") => {
  const githubEnvironment = resolve(root, "github-env");
  const result = await execute(process.execPath, [validator], {
    cwd: root,
    env: {
      ...process.env,
      RELEASE_TAG: `v${version}`,
      REPOSITORY_VISIBILITY: visibility,
      GITHUB_ENV: githubEnvironment,
    },
  });
  return { result, githubEnvironment };
};

describe("candidate tag validation", () => {
  it("accepts a stable version only at the public main tip", async () => {
    const { root } = await fixture("0.1.2");
    const { result, githubEnvironment } = await validate(root, "0.1.2");
    expect(result.stdout).toContain("candidate channel");
    expect(await readFile(githubEnvironment, "utf8")).toBe("release_channel=candidate\n");
  });

  it("rejects a stable version behind the main tip", async () => {
    const { root, git } = await fixture("0.1.2");
    await writeFile(resolve(root, "later.txt"), "later\n");
    await git("add", ".");
    await git("commit", "-m", "later");
    const later = (await git("rev-parse", "HEAD")).stdout.trim();
    await git("update-ref", "refs/remotes/origin/main", later);
    await git("checkout", "HEAD~1");
    await expect(validate(root, "0.1.2")).rejects.toThrow("reviewed tip of main");
  });

  it("accepts a reachable RC without requiring the current main tip", async () => {
    const { root, git } = await fixture("0.1.2-rc.4");
    await writeFile(resolve(root, "later.txt"), "later\n");
    await git("add", ".");
    await git("commit", "-m", "later");
    const later = (await git("rev-parse", "HEAD")).stdout.trim();
    await git("update-ref", "refs/remotes/origin/main", later);
    await git("checkout", "HEAD~1");
    const { githubEnvironment } = await validate(root, "0.1.2-rc.4", "private");
    expect(await readFile(githubEnvironment, "utf8")).toBe("release_channel=rc\n");
  });

  it("rejects a mismatched tag", async () => {
    const { root } = await fixture("0.1.2");
    await expect(validate(root, "0.1.3")).rejects.toThrow("does not match package version");
  });
});
