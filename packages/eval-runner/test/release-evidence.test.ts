import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadReleaseEvidenceManifest } from "../src/release-evidence";

const manifest = (reports: readonly string[], cohorts: readonly string[]) => ({
  version: 1,
  candidate_sha256: "a".repeat(64),
  created_at: "2026-08-22T00:00:00.000Z",
  reports,
  cohorts,
});

describe("release evidence bundle", () => {
  it("loads only relative evidence contained in the bundle", async () => {
    const root = await mkdtemp(join(tmpdir(), "artifactpass-release-evidence-"));
    await Promise.all([
      writeFile(join(root, "report.json"), "{}"),
      writeFile(join(root, "cohort.json"), "{}"),
      writeFile(join(root, "release-evidence.json"), JSON.stringify(manifest(["report.json"], ["cohort.json"]))),
    ]);
    const canonicalRoot = await realpath(root);
    await expect(loadReleaseEvidenceManifest(join(root, "release-evidence.json"))).resolves.toMatchObject({
      reports: [join(canonicalRoot, "report.json")],
      cohorts: [join(canonicalRoot, "cohort.json")],
    });
  });

  it("rejects traversal and symbolic-link escapes", async () => {
    const parent = await mkdtemp(join(tmpdir(), "artifactpass-release-evidence-"));
    const root = join(parent, "bundle");
    await mkdir(root);
    await writeFile(join(parent, "outside.json"), "{}");
    await symlink(join(parent, "outside.json"), join(root, "linked.json"));
    for (const reference of ["../outside.json", "linked.json"]) {
      await writeFile(
        join(root, "release-evidence.json"),
        JSON.stringify(manifest([reference], [reference])),
      );
      await expect(loadReleaseEvidenceManifest(join(root, "release-evidence.json"))).rejects.toThrow(/escaped/u);
    }
  });
});
