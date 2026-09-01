import { describe, expect, it, vi } from "vitest";

import { startDeviceAuthorization } from "../src/connection/device-authorization";

describe("device authorization key registration", () => {
  it("sends only the public key to the deployment and returns the private key after approval", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ url, body });
      if (url.endsWith("/connect/device")) {
        return Response.json({
          device_code: "c".repeat(43),
          user_code: "approval-code",
          verification_uri: "https://private.example.com/connect/approve",
          expires_in: 600,
          interval: 1,
        }, { status: 201 });
      }
      return Response.json({
        access_token: `as_${"t".repeat(43)}`,
        expires_in: 3600,
      });
    });

    const pending = await startDeviceAuthorization("https://private.example.com", {
      fetch,
      wait: async () => undefined,
      now: () => 1_000_000,
      agentName: "Claude Code",
      workspaceIdentity: "/Users/team/product",
    });
    const result = await pending.waitForApproval();

    const registration = requests[0]?.body;
    expect(registration).toMatchObject({
      code_challenge_method: "S256",
      agent_name: "Claude Code",
      workspace_identity: "/Users/team/product",
      device_key_id: expect.stringMatching(/^dk_[A-Za-z0-9_-]{43}$/u),
      device_public_key: expect.stringMatching(/^[A-Za-z0-9+/]{43}=$/u),
    });
    expect(JSON.stringify(registration)).not.toContain("private");
    expect(result.deviceSigning).toMatchObject({
      keyId: registration?.device_key_id,
      publicKeyBase64: registration?.device_public_key,
      privateKeyPkcs8Base64: expect.any(String),
    });
    expect(requests[1]?.body).toEqual({
      device_code: "c".repeat(43),
      code_verifier: expect.any(String),
    });
  });
});
