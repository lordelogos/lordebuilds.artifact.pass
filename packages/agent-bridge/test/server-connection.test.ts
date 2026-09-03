import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createConnectionController } from "../src/connection/connection-controller";
import type { PendingDeviceAuthorization } from "../src/connection/device-authorization";
import {
  createBridgeServer,
  type BridgeConfiguration,
  type BridgeConfigurationSource,
} from "../src/server";

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
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({
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
    }, { status: 201 }));
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

      await expect(client.callTool({
        name: "connection_status",
        arguments: { workspace_path: root },
      }))
        .resolves.toMatchObject({ structuredContent: { status: "disconnected" } });
      await expect(client.callTool({ name: "publish_artifact", arguments: { path } }))
        .resolves.toMatchObject({ isError: true });

      await expect(client.callTool({
        name: "connect_artifactpass",
        arguments: { workspace_path: root },
      }))
        .resolves.toMatchObject({ structuredContent: { status: "connecting" } });
      expect(openBrowser).toHaveBeenCalledWith(authorization.approvalUrl);

      approve?.({ accessToken: `as_${"a".repeat(43)}`, expiresIn: 3600 });
      await vi.waitFor(async () => {
        const status = await client.callTool({
          name: "connection_status",
          arguments: { workspace_path: root },
        });
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

  it("requires a workspace path before selecting a connection deployment", async () => {
    const status = vi.fn().mockResolvedValue({
      status: "connected" as const,
      profile: "production",
      origin: "https://artifactpass.com",
    });
    const connect = vi.fn();
    const configuration: BridgeConfiguration = {
      profileName: "production",
      baseUrl: new URL("https://artifactpass.com"),
      workspaceRoots: [process.cwd()],
      headless: true,
      environmentStore: {
        get: vi.fn().mockResolvedValue(`as_${"a".repeat(43)}`),
        set: vi.fn(),
        delete: vi.fn(),
      },
      connectionController: {
        status,
        connect,
      },
    };
    const server = createBridgeServer(configuration);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "artifactpass-required-workspace-test", version: "0.0.0" });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      await expect(client.callTool({ name: "connection_status", arguments: {} }))
        .resolves.toMatchObject({
          isError: true,
          content: [{ text: expect.stringMatching(/workspace_path/u) }],
        });
      await expect(client.callTool({ name: "connect_artifactpass", arguments: {} }))
        .resolves.toMatchObject({
          isError: true,
          content: [{ text: expect.stringMatching(/workspace_path/u) }],
        });
      expect(status).not.toHaveBeenCalled();
      expect(connect).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("passes the artifact path into workspace-aware connection tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "artifactpass-server-workspace-route-"));
    temporaryRoots.push(root);
    const path = join(root, "handoff.md");
    const contents = "# Routed\n";
    await writeFile(path, contents);
    const shareUrl = `https://artifacts.company.example/a/${"r".repeat(43)}`;
    const manifest = {
      protocol_version: 1 as const,
      artifact_id: "018f1f52-cbf1-7a5e-b66e-9ac829614b53",
      filename: "handoff.md",
      mime_type: "text/markdown",
      byte_size: Buffer.byteLength(contents),
      sha256: "b".repeat(64),
      created_at: "2026-08-29T12:00:00.000Z",
      expires_at: "2026-08-29T13:00:00.000Z",
      extraction: { status: "not_applicable" },
      pdf_trust: { status: "not_applicable" },
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (init?.method === "POST") return Response.json({
        protocol_version: 1,
        manifest,
        share_url: shareUrl,
      }, { status: 201 });
      if (url.pathname.endsWith("/manifest")) return Response.json(manifest);
      return Response.json({
        protocol_version: 1,
        artifact_id: manifest.artifact_id,
        encoding: "base64",
        byte_offset: 0,
        byte_length: Buffer.byteLength(contents),
        total_size: Buffer.byteLength(contents),
        sha256: manifest.sha256,
        data: Buffer.from(contents).toString("base64"),
        next_cursor: null,
      });
    });
    const companyConnectionController = {
      status: vi.fn().mockResolvedValue({
        status: "connected" as const,
        profile: "company",
        origin: "https://artifacts.company.example",
      }),
      connect: vi.fn().mockResolvedValue({
        status: "connected" as const,
        profile: "company",
        origin: "https://artifacts.company.example",
      }),
    };
    const configuration: BridgeConfiguration = {
      profileName: "company",
      baseUrl: new URL("https://artifacts.company.example"),
      workspaceRoots: [root],
      headless: true,
      environmentStore: {
        get: vi.fn().mockResolvedValue(`as_${"a".repeat(43)}`),
        set: vi.fn(),
        delete: vi.fn(),
      },
      connectionController: companyConnectionController,
      fetch,
    };
    const source: BridgeConfigurationSource = {
      defaultConfiguration: () => ({ ...configuration, profileName: "production" }),
      forWorkspacePath: vi.fn().mockReturnValue(configuration),
      forShareUrl: vi.fn().mockReturnValue(configuration),
      runtimeKey: vi.fn().mockReturnValue("company"),
    };
    const server = createBridgeServer(source);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "artifactpass-workspace-route-test", version: "0.0.0" });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      await expect(client.callTool({
        name: "connection_status",
        arguments: { workspace_path: path },
      })).resolves.toMatchObject({
        structuredContent: {
          status: "connected",
          profile: "company",
          origin: "https://artifacts.company.example",
        },
      });
      expect(source.forWorkspacePath).toHaveBeenCalledWith(path);

      await expect(client.callTool({
        name: "connect_artifactpass",
        arguments: { workspace_path: path },
      })).resolves.toMatchObject({
        structuredContent: { status: "connected", profile: "company" },
      });
      expect(companyConnectionController.connect).toHaveBeenCalledTimes(1);

      await expect(client.callTool({
        name: "publish_artifact",
        arguments: { path },
      })).resolves.toMatchObject({
        structuredContent: { share_url: shareUrl },
      });
      await expect(client.callTool({
        name: "read_artifact",
        arguments: { share_url: shareUrl },
      })).resolves.toMatchObject({
        structuredContent: { text: contents },
      });
      expect(source.forShareUrl).toHaveBeenCalledWith(shareUrl);
      expect(fetch).toHaveBeenCalledTimes(3);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
