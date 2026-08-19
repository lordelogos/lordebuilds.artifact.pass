import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { candidateDigest } from "../src/candidate-digest";

describe("candidate digest", () => {
  it("changes when a shipped skill changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "artifactpass-candidate-digest-"));
    try {
      const plugin = join(root, "plugins/artifactpass");
      await mkdir(join(plugin, "dist"), { recursive: true });
      await mkdir(join(plugin, "skills/share-artifact"), { recursive: true });
      await writeFile(join(plugin, "dist/cli.mjs"), "bridge");
      const skill = join(plugin, "skills/share-artifact/SKILL.md");
      await writeFile(skill, "version one");
      const first = await candidateDigest(root);
      await writeFile(skill, "version two");
      expect(await candidateDigest(root)).not.toBe(first);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
