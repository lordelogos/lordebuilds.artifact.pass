import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createConnectionController } from "../src/connection/connection-controller";
import type { PendingDeviceAuthorization } from "../src/connection/device-authorization";
import { createBridgeServer } from "../src/server";

describe("plugin-native connection through MCP", () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("retries publishing in the same MCP session after browser approval", async () => {
    const root = await mkdtemp(join(tmpdir(), "artifactpass-server-connect-"));
    temporaryRoots.push(root);
    const source = "# Connected\n";
    const path = join(root, "handoff.md");
    await writeFile(path, source);

    let storedCredential: string | null = null;
    let approve: ((value: { accessToken: string; expiresIn: number }) => void) | undefined;
    const credentialStore = {
      get: vi.fn(async () => storedCredential),
      set: vi.fn(async (value: string) => { storedCredential = value; }),
      delete: vi.fn(async () => { storedCredential = null; }),
    };
    const authorization: PendingDeviceAuthorization = {
      approvalUrl: "https://staging.artifactpass.com/connect/approve?user_code=session-code",
      userCode: "session-code",
      expiresAt: Date.now() + 600_000,
      waitForApproval: () => new Promise((resolve) => { approve = resolve; }),
    };
    const openBrowser = vi.fn().mockResolvedValue(undefined);
    const connectionController = createConnectionController({
      origin: new URL("https://staging.artifactpass.com"),
      profileName: "staging",
      credentialStore,
      startDeviceAuthorization: vi.fn().mockResolvedValue(authorization),
      openBrowser,
      inspectCredential: vi.fn().mockResolvedValue({ expiresAt: Date.now() + 3_600_000 }),
    });
    const shareUrl = `https://staging.artifactpass.com/a/${"s".repeat(43)}`;
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      protocol_version: 1,
      manifest: {
        protocol_version: 1,
        artifact_id: "018f1f52-cbf1-7a5e-b66e-9ac829614b53",
        filename: "handoff.md",
        mime_type: "text/markdown",
        byte_size: Buffer.byteLength(source),
        sha256: "a".repeat(64),
        created_at: "2026-08-27T20:00:00.000Z",
        expires_at: "2026-08-27T21:00:00.000Z",
        extraction: { status: "not_applicable" },
        pdf_trust: { status: "not_applicable" },
      },
      share_url: shareUrl,
    }), { status: 201, headers: { "content-type": "application/json" } }));
    const server = createBridgeServer({
      profileName: "staging",
      baseUrl: new URL("https://staging.artifactpass.com"),
      workspaceRoots: [root],
      headless: false,
      environmentStore: {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn(),
        delete: vi.fn(),
      },
      osStore: credentialStore,
      requireOriginBoundCredential: true,
      connectionController,
      fetch,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "artifactpass-connection-test", version: "0.0.0" });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      await expect(client.callTool({ name: "connection_status", arguments: {} }))
        .resolves.toMatchObject({ structuredContent: { status: "disconnected" } });
      await expect(client.callTool({ name: "publish_artifact", arguments: { path } }))
        .resolves.toMatchObject({ isError: true });

      await expect(client.callTool({ name: "connect_artifactpass", arguments: {} }))
        .resolves.toMatchObject({ structuredContent: { status: "connecting" } });
      expect(openBrowser).toHaveBeenCalledWith(authorization.approvalUrl);

      approve?.({ accessToken: `as_${"a".repeat(43)}`, expiresIn: 3600 });
      await vi.waitFor(async () => {
        const status = await client.callTool({ name: "connection_status", arguments: {} });
        expect(status.structuredContent).toMatchObject({ status: "connected" });
      });

      const published = await client.callTool({ name: "publish_artifact", arguments: { path } });
      expect(published.isError).not.toBe(true);
      expect(published.structuredContent).toMatchObject({ share_url: shareUrl });
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
