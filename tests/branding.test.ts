import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(new URL("..", import.meta.url).pathname);

const read = async (path: string): Promise<string> =>
  readFile(resolve(repositoryRoot, path), "utf8");

describe("ArtifactPass active identity", () => {
  it("uses ArtifactPass on active browser, CLI, bridge, and skill surfaces", async () => {
    const files = [
      "apps/artifact-service/upload.html",
      "apps/artifact-service/src/server/routes/connect.ts",
      "apps/artifact-service/src/web/routes/upload-page.tsx",
      "apps/artifact-service/src/web/routes/share-page.tsx",
      "packages/agent-bridge/src/cli.ts",
      "packages/agent-bridge/src/http/safe-fetch.ts",
      "packages/agent-bridge/src/tools/publish-artifact.ts",
      "packages/agent-bridge/src/tools/read-artifact.ts",
      "packages/setup-cli/src/cli.ts",
      "packages/setup-cli/src/commands/connect.ts",
      "packages/setup-cli/src/commands/disconnect.ts",
      "plugins/artifactpass/skills/read-shared-artifact/SKILL.md",
      "plugins/artifactpass/skills/share-artifact/SKILL.md",
    ];
    const contents = await Promise.all(files.map(read));
    for (const content of contents) {
      expect(content).not.toContain("Artifact Share");
    }
    expect(contents.join("\n")).toContain("ArtifactPass");
  });

  it("documents one-command installation before custom and portable paths", async () => {
    const documents = await Promise.all([
      read("README.md"),
      read("docs/agent-setup.md"),
      read("docs/deployment.md"),
      read("docs/architecture.md"),
    ]);
    for (const document of documents) {
      expect(document).not.toContain("@artifact-share/setup");
      expect(document).not.toContain("plugins/artifact-share");
      expect(document).not.toContain("$artifact-share:");
    }
    expect(documents[0]).toContain("pnpm dlx artifactpass");
    expect(documents[1]?.indexOf("pnpm dlx artifactpass"))
      .toBeLessThan(documents[1]?.indexOf("--base-url https://artifacts.example.com") ?? 0);
  });

  it("retains only declared compatibility identifiers", async () => {
    expect(await read("apps/artifact-service/src/server/index.ts"))
      .toContain('service: "lordebuilds.artifacts.share"');
    expect(await read("packages/agent-bridge/src/server.ts"))
      .toContain('{ name: "lordebuilds.artifacts.share"');
    expect(await read("packages/agent-bridge/src/auth/credential-store.ts"))
      .toContain('LEGACY_ARTIFACT_SHARE_CREDENTIAL_SERVICE = "lordebuilds.artifacts.share"');
    const activation = await read("docs/hosted-activation.md");
    expect(activation).toContain("removes only the matching legacy Access application");
    expect(activation).not.toContain("existing Access allow policy remains");
  });
});
