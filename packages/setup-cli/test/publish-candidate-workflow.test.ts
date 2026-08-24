import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("npm release-candidate publishing", () => {
  it("binds the public package to its source repository", async () => {
    const manifest = JSON.parse(await readFile(
      resolve(repositoryRoot, "packages/setup-cli/package.json"),
      "utf8",
    )) as { readonly repository?: { readonly url?: string } };

    expect(manifest.repository?.url).toBe(
      "git+https://github.com/lordelogos/lordebuilds.artifact.pass.git",
    );
  });

  it("publishes only an immutable validated candidate through tokenless OIDC", async () => {
    const workflow = await readFile(
      resolve(repositoryRoot, ".github/workflows/publish-candidate.yml"),
      "utf8",
    );

    for (const expected of [
      '      - "v*-rc.*"',
      "id-token: write",
      "persist-credentials: false",
      "pnpm release:check",
      "pnpm test:packed-install",
      "pnpm --dir packages/setup-cli pack",
      'npm publish "$package_archive" --tag rc --access public',
    ]) {
      expect(workflow).toContain(expected);
    }
    expect(workflow).not.toContain("NODE_AUTH_TOKEN");
    expect(workflow).not.toContain("secrets.");
  });
});
