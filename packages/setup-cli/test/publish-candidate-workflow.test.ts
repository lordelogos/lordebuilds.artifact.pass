import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("npm release publishing", () => {
  it("binds the public package to its source repository", async () => {
    const manifest = JSON.parse(await readFile(
      resolve(repositoryRoot, "packages/setup-cli/package.json"),
      "utf8",
    )) as { readonly repository?: { readonly url?: string } };

    expect(manifest.repository?.url).toBe(
      "git+https://github.com/lordelogos/lordebuilds.artifact.pass.git",
    );
  });

  it("publishes immutable validated RCs to rc and stable releases to latest through tokenless OIDC", async () => {
    const workflow = await readFile(
      resolve(repositoryRoot, ".github/workflows/publish-candidate.yml"),
      "utf8",
    );

    for (const expected of [
      '      - "v*"',
      "id-token: write",
      "persist-credentials: false",
      "pnpm release:check",
      "pnpm test:packed-install",
      "pnpm --dir packages/setup-cli pack",
      "node scripts/validate-candidate-tag.mjs",
      "git fetch --no-tags origin main",
      'npm publish "$package_archive" --tag "$release_channel" --access public --provenance',
    ]) {
      expect(workflow).toContain(expected);
    }
    expect(workflow).not.toContain("NODE_AUTH_TOKEN");
    expect(workflow).not.toContain("${{ secrets.");
    expect(workflow).toContain("github.event.repository.visibility");
    expect(workflow.match(/node scripts\/validate-candidate-tag\.mjs/gu)).toHaveLength(2);
  });

  it("pins every workflow action to an immutable commit", async () => {
    const workflows = await Promise.all([
      "ci.yml",
      "evals.yml",
      "publish-candidate.yml",
      "release.yml",
    ].map((name) => readFile(resolve(repositoryRoot, ".github/workflows", name), "utf8")));

    for (const workflow of workflows) {
      const actionReferences = [...workflow.matchAll(/^\s*(?:-\s+)?uses:\s+([^\s#]+)/gmu)]
        .map((match) => match[1]);
      expect(actionReferences.length).toBeGreaterThan(0);
      for (const reference of actionReferences) {
        expect(reference).toMatch(/^[^@]+@[0-9a-f]{40}$/u);
      }
    }
  });
});
