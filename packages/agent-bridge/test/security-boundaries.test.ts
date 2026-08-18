import { describe, expect, it, vi } from "vitest";

import { createRedactingLogger } from "../src/logging/redacting-logger";
import {
  agentCredentialAccountForProfile,
  CompatibleCredentialStore,
  CompatibleEnvironmentCredentialStore,
  CredentialStoreCommandError,
  EnvironmentCredentialStore,
  OsCredentialStore,
  resolveCredential,
} from "../src/auth/credential-store";

const agentToken = `as_${"t".repeat(43)}`;
const shareToken = "s".repeat(32);

describe("credential and logging boundaries", () => {
  it("preserves the legacy production account while isolating additional profiles", () => {
    expect(agentCredentialAccountForProfile("production")).toBe("agent-token");
    expect(agentCredentialAccountForProfile("environment")).toBe("agent-token:environment");
    expect(agentCredentialAccountForProfile("staging")).toBe("agent-token:staging");
  });

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

  it("uses matching environment aliases and rejects conflicting secrets", async () => {
    await expect(new CompatibleEnvironmentCredentialStore(
      "ARTIFACTPASS_TOKEN",
      "ARTIFACT_SHARE_TOKEN",
      { ARTIFACTPASS_TOKEN: agentToken, ARTIFACT_SHARE_TOKEN: agentToken },
    ).get()).resolves.toBe(agentToken);
    await expect(new CompatibleEnvironmentCredentialStore(
      "ARTIFACTPASS_TOKEN",
      "ARTIFACT_SHARE_TOKEN",
      { ARTIFACTPASS_TOKEN: agentToken, ARTIFACT_SHARE_TOKEN: `as_${"x".repeat(43)}` },
    ).get()).rejects.toThrow("conflicts");
  });

  it("reads a legacy credential but writes only to ArtifactPass", async () => {
    const artifactpass = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn(),
      delete: vi.fn(),
    };
    const legacy = {
      get: vi.fn().mockResolvedValue(agentToken),
      set: vi.fn(),
      delete: vi.fn(),
    };
    const store = new CompatibleCredentialStore({
      artifactpassStore: artifactpass,
      legacyStore: legacy,
    });

    await expect(store.get()).resolves.toBe(agentToken);
    await store.set(`as_${"n".repeat(43)}`);
    expect(artifactpass.set).toHaveBeenCalledOnce();
    expect(legacy.set).not.toHaveBeenCalled();
  });

  it("passes secrets to the Linux OS store over stdin", async () => {
    const runner = vi.fn().mockResolvedValue({ stdout: "" });
    const store = new OsCredentialStore({ platform: "linux", runner });
    const token = agentToken;

    await store.set(token);

    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0]?.[1]).not.toContain(token);
    expect(runner.mock.calls[0]?.[2]).toEqual({ input: token });
  });

  it("passes the macOS password as the value required by security(1)", async () => {
    const runner = vi.fn().mockResolvedValue({ stdout: "" });
    const store = new OsCredentialStore({ platform: "darwin", runner });

    await store.set(agentToken);

    expect(runner).toHaveBeenCalledWith("/usr/bin/security", [
      "add-generic-password", "-U", "-s", "artifactpass",
      "-a", "agent-token", "-w", agentToken,
    ]);
  });

  it("distinguishes a missing macOS credential from a credential-store outage", async () => {
    const missing = new OsCredentialStore({
      platform: "darwin",
      runner: vi.fn().mockRejectedValue(new CredentialStoreCommandError(44)),
    });
    await expect(missing.get()).resolves.toBeNull();

    const unavailable = new OsCredentialStore({
      platform: "darwin",
      runner: vi.fn().mockRejectedValue(new Error("Keychain is unavailable")),
    });
    await expect(unavailable.get()).rejects.toThrow("Keychain is unavailable");
    await expect(unavailable.delete()).rejects.toThrow("Keychain is unavailable");
  });

  it("redacts bearer tokens, share URLs, and content from controlled logs", () => {
    const write = vi.fn();
    const logger = createRedactingLogger(write);
    const cloudflareToken = `cfut_${"c".repeat(40)}`;
    logger.error(`upload failed with ${cloudflareToken}`, {
      authorization: `Bearer ${agentToken}`,
      share_url: `https://artifacts.example.test/a/${shareToken}`,
      content: "TOP SECRET SOURCE",
      path: "/safe/workspace/report.md",
    });

    const line = write.mock.calls[0]?.[0] as string;
    expect(line).not.toContain(agentToken);
    expect(line).not.toContain(shareToken);
    expect(line).not.toContain("TOP SECRET SOURCE");
    expect(line).not.toContain(cloudflareToken);
    expect(line).toContain("[REDACTED]");
  });
});
