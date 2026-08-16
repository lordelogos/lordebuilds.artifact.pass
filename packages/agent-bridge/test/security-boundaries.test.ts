import { describe, expect, it, vi } from "vitest";

import { createRedactingLogger } from "../src/logging/redacting-logger";
import {
  EnvironmentCredentialStore,
  OsCredentialStore,
  resolveCredential,
} from "../src/auth/credential-store";

const agentToken = `as_${"t".repeat(43)}`;
const shareToken = "s".repeat(32);

describe("credential and logging boundaries", () => {
  it("uses environment credentials in headless mode without a plaintext fallback", async () => {
    const store = new EnvironmentCredentialStore("ARTIFACT_SHARE_TOKEN", {
      ARTIFACT_SHARE_TOKEN: agentToken,
    });
    await expect(resolveCredential({ headless: true, environmentStore: store }))
      .resolves.toBe(agentToken);
    await expect(resolveCredential({
      headless: true,
      environmentStore: new EnvironmentCredentialStore("ARTIFACT_SHARE_TOKEN", {}),
    })).rejects.toThrow(/environment/u);
  });

  it.each(["darwin", "linux"] as const)("passes secrets to the %s OS store over stdin", async (platform) => {
    const runner = vi.fn().mockResolvedValue({ stdout: "" });
    const store = new OsCredentialStore({ platform, runner });
    const token = agentToken;

    await store.set(token);

    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0]?.[1]).not.toContain(token);
    expect(runner.mock.calls[0]?.[2]).toEqual({ input: token });
  });

  it("redacts bearer tokens, share URLs, and content from controlled logs", () => {
    const write = vi.fn();
    const logger = createRedactingLogger(write);
    logger.error("upload failed", {
      authorization: `Bearer ${agentToken}`,
      share_url: `https://artifacts.example.test/a/${shareToken}`,
      content: "TOP SECRET SOURCE",
      path: "/safe/workspace/report.md",
    });

    const line = write.mock.calls[0]?.[0] as string;
    expect(line).not.toContain(agentToken);
    expect(line).not.toContain(shareToken);
    expect(line).not.toContain("TOP SECRET SOURCE");
    expect(line).toContain("[REDACTED]");
  });
});
