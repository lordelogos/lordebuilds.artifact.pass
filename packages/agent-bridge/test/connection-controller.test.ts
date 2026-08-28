import { describe, expect, it, vi } from "vitest";

import {
  createConnectionController,
} from "../src/connection/connection-controller";
import type { PendingDeviceAuthorization } from "../src/connection/device-authorization";

describe("plugin-native ArtifactPass connection", () => {
  it("starts disconnected, opens approval from the plugin, and connects without restarting", async () => {
    let approve: ((value: { accessToken: string; expiresIn: number }) => void) | undefined;
    const authorization: PendingDeviceAuthorization = {
      approvalUrl: "https://staging.artifactpass.com/connect/approve?user_code=connect-code",
      userCode: "connect-code",
      expiresAt: 2_000_000,
      waitForApproval: () => new Promise((resolve) => {
        approve = resolve;
      }),
    };
    let storedCredential: string | null = null;
    const credentialStore = {
      get: vi.fn(async () => storedCredential),
      set: vi.fn(async (value: string) => { storedCredential = value; }),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const openBrowser = vi.fn().mockResolvedValue(undefined);
    const controller = createConnectionController({
      origin: new URL("https://staging.artifactpass.com"),
      profileName: "staging",
      credentialStore,
      startDeviceAuthorization: vi.fn().mockResolvedValue(authorization),
      openBrowser,
      inspectCredential: vi.fn().mockResolvedValue({ expiresAt: 4_600_000 }),
      now: () => 1_000_000,
    });

    await expect(controller.status()).resolves.toMatchObject({
      status: "disconnected",
      profile: "staging",
      origin: "https://staging.artifactpass.com",
    });

    await expect(controller.connect()).resolves.toMatchObject({
      status: "connecting",
      user_code: "connect-code",
      approval_url: authorization.approvalUrl,
    });
    expect(openBrowser).toHaveBeenCalledWith(authorization.approvalUrl);

    approve?.({ accessToken: `as_${"a".repeat(43)}`, expiresIn: 3600 });
    await vi.waitFor(() => expect(credentialStore.set).toHaveBeenCalledTimes(1));
    await expect(controller.status()).resolves.toMatchObject({
      status: "connected",
      profile: "staging",
      origin: "https://staging.artifactpass.com",
    });
  });

  it("returns the approval URL when the browser cannot be opened", async () => {
    const authorization: PendingDeviceAuthorization = {
      approvalUrl: "https://artifactpass.com/connect/approve?user_code=manual-code",
      userCode: "manual-code",
      expiresAt: 2_000_000,
      waitForApproval: () => new Promise(() => undefined),
    };
    const controller = createConnectionController({
      origin: new URL("https://artifactpass.com"),
      profileName: "production",
      credentialStore: {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
      },
      startDeviceAuthorization: vi.fn().mockResolvedValue(authorization),
      openBrowser: vi.fn().mockRejectedValue(new Error("browser unavailable")),
      inspectCredential: vi.fn().mockResolvedValue(null),
      now: () => 1_000_000,
    });

    await expect(controller.connect()).resolves.toMatchObject({
      status: "connecting",
      approval_url: authorization.approvalUrl,
      browser_opened: false,
    });
  });

  it("re-inspects a cached connection so a revoked token can reconnect", async () => {
    const token = `as_${"r".repeat(43)}`;
    let active = true;
    const startDeviceAuthorization = vi.fn().mockResolvedValue({
      approvalUrl: "https://artifactpass.com/connect/approve?user_code=reconnect-code",
      userCode: "reconnect-code",
      expiresAt: 2_000_000,
      waitForApproval: () => new Promise(() => undefined),
    } satisfies PendingDeviceAuthorization);
    const controller = createConnectionController({
      origin: new URL("https://artifactpass.com"),
      profileName: "production",
      credentialStore: {
        get: vi.fn().mockResolvedValue(JSON.stringify({
          version: 1,
          origin: "https://artifactpass.com",
          token,
        })),
        set: vi.fn(),
        delete: vi.fn(),
      },
      inspectCredential: vi.fn(async () => active ? { expiresAt: 2_000_000 } : null),
      startDeviceAuthorization,
      openBrowser: vi.fn().mockResolvedValue(undefined),
      now: () => 1_000_000,
    });

    await expect(controller.status()).resolves.toMatchObject({ status: "connected" });
    active = false;
    await expect(controller.status()).resolves.toMatchObject({ status: "disconnected" });
    await expect(controller.connect()).resolves.toMatchObject({ status: "connecting" });
    expect(startDeviceAuthorization).toHaveBeenCalledTimes(1);
  });

  it("shares one device authorization across concurrent connect calls", async () => {
    let release: ((authorization: PendingDeviceAuthorization) => void) | undefined;
    const authorizationPromise = new Promise<PendingDeviceAuthorization>((resolve) => {
      release = resolve;
    });
    const startDeviceAuthorization = vi.fn(() => authorizationPromise);
    const openBrowser = vi.fn().mockResolvedValue(undefined);
    const controller = createConnectionController({
      origin: new URL("https://artifactpass.com"),
      profileName: "production",
      credentialStore: { get: vi.fn().mockResolvedValue(null), set: vi.fn(), delete: vi.fn() },
      inspectCredential: vi.fn().mockResolvedValue(null),
      startDeviceAuthorization,
      openBrowser,
    });

    const first = controller.connect();
    const second = controller.connect();
    release?.({
      approvalUrl: "https://artifactpass.com/connect/approve?user_code=shared-code",
      userCode: "shared-code",
      expiresAt: 2_000_000,
      waitForApproval: () => new Promise(() => undefined),
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: "connecting", user_code: "shared-code" }),
      expect.objectContaining({ status: "connecting", user_code: "shared-code" }),
    ]);
    expect(startDeviceAuthorization).toHaveBeenCalledTimes(1);
    expect(openBrowser).toHaveBeenCalledTimes(1);
  });

  it("revokes an issued token when credential persistence fails", async () => {
    const token = `as_${"f".repeat(43)}`;
    const revokeCredential = vi.fn().mockResolvedValue(undefined);
    const controller = createConnectionController({
      origin: new URL("https://artifactpass.com"),
      profileName: "production",
      credentialStore: {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockRejectedValue(new Error("keychain unavailable")),
        delete: vi.fn(),
      },
      inspectCredential: vi.fn().mockResolvedValue(null),
      startDeviceAuthorization: vi.fn().mockResolvedValue({
        approvalUrl: "https://artifactpass.com/connect/approve?user_code=failure-code",
        userCode: "failure-code",
        expiresAt: 2_000_000,
        waitForApproval: async () => ({ accessToken: token, expiresIn: 3600 }),
      } satisfies PendingDeviceAuthorization),
      openBrowser: vi.fn().mockResolvedValue(undefined),
      revokeCredential,
    });

    await expect(controller.connect()).resolves.toMatchObject({ status: "connecting" });
    await vi.waitFor(() => expect(revokeCredential).toHaveBeenCalledWith(token));
    await expect(controller.status()).resolves.toMatchObject({
      status: "failed",
      message: "keychain unavailable",
    });
    await expect(controller.status()).resolves.toMatchObject({ status: "disconnected" });
  });

  it("reports setup failures as structured connection states", async () => {
    const controller = createConnectionController({
      origin: new URL("https://artifactpass.com"),
      profileName: "production",
      credentialStore: {
        get: vi.fn().mockRejectedValue(new Error("keychain locked")),
        set: vi.fn(),
        delete: vi.fn(),
      },
      startDeviceAuthorization: vi.fn().mockRejectedValue(new Error("service unavailable")),
    });

    await expect(controller.status()).resolves.toMatchObject({
      status: "failed",
      message: "keychain locked",
    });
    await expect(controller.connect()).resolves.toMatchObject({
      status: "failed",
      message: "service unavailable",
    });
  });
});
