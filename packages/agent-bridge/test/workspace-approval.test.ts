import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readLocalBridgeSettings } from "../src/config/local-config";
import {
  createBridgeConfigurationSource,
  createBridgeServer,
  type BridgeConfigurationSource,
} from "../src/server";

const hiddenValue = (html: string, name: string): string => {
  const match = html.match(new RegExp(`name="${name}" value="([^"]+)"`, "u"));
  if (match?.[1] === undefined) throw new Error(`Missing hidden input ${name}`);
  return match[1];
};

describe("workspace approval through MCP", () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("approves the displayed folder and resumes in the same MCP session", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "artifactpass-workspace-approval-"));
    temporaryRoots.push(root);
    const configHome = resolve(root, "config-home");
    const configPath = resolve(configHome, "artifactpass", "config.json");
    const workspace = resolve(root, "new-project");
    const artifact = resolve(workspace, "handoff.md");
    await mkdir(workspace);
    await writeFile(artifact, "# Approval test\n");
    const canonicalWorkspace = await realpath(workspace);
    const openBrowser = vi.fn().mockResolvedValue(undefined);
    const source = createBridgeConfigurationSource({ XDG_CONFIG_HOME: configHome }, root);
    const server = createBridgeServer(source, { openWorkspaceApprovalBrowser: openBrowser });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "artifactpass-workspace-approval-test", version: "0.0.0" });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const started = await client.callTool({
        name: "connect_artifactpass",
        arguments: { workspace_path: artifact, workspace_root: workspace },
      });
      expect(started.structuredContent).toMatchObject({
        status: "connecting",
        phase: "workspace_approval",
        browser_opened: true,
        workspace_root: canonicalWorkspace,
        approval_url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/workspace-approval\?/u),
      });
      const approvalUrl = String((started.structuredContent as { approval_url?: unknown }).approval_url);
      expect(openBrowser).toHaveBeenCalledWith(approvalUrl);

      const page = await fetch(approvalUrl);
      const html = await page.text();
      expect(page.status).toBe(200);
      expect(html).toContain(canonicalWorkspace);
      expect(html).toContain("https://artifactpass.com");
      const token = hiddenValue(html, "token");

      const approved = await fetch(new URL("/workspace-approval", approvalUrl), {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: new URL(approvalUrl).origin,
        },
        body: new URLSearchParams({ action: "approve", token, origin: "https://artifactpass.com" }),
      });
      expect(approved.status).toBe(200);
      expect(await approved.text()).toContain("Project approved");

      const status = await client.callTool({
        name: "connection_status",
        arguments: { workspace_path: artifact, workspace_root: workspace },
      });
      expect(status).toMatchObject({
        structuredContent: {
          workspace_status: "approved",
          profile: "production",
          origin: "https://artifactpass.com",
          workspace_root: canonicalWorkspace,
        },
      });
      expect(["connected", "disconnected"]).toContain(
        (status.structuredContent as { status?: unknown }).status,
      );
      await expect(readLocalBridgeSettings(configPath)).resolves.toMatchObject({
        workspace_profiles: { [canonicalWorkspace]: "production" },
        profiles: {
          production: {
            base_url: "https://artifactpass.com",
            workspace_roots: [canonicalWorkspace],
          },
        },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("publishes the original request after project approval without restarting MCP", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "artifactpass-workspace-resume-"));
    temporaryRoots.push(root);
    const artifact = resolve(root, "handoff.md");
    const contents = "# Resume the original share\n";
    await writeFile(artifact, contents);
    const canonicalRoot = await realpath(root);
    const shareUrl = `http://127.0.0.1:8787/a/${"r".repeat(43)}`;
    const uploadFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({
      protocol_version: 1,
      manifest: {
        protocol_version: 1,
        artifact_id: "018f1f52-cbf1-7a5e-b66e-9ac829614b53",
        filename: "handoff.md",
        mime_type: "text/markdown",
        byte_size: Buffer.byteLength(contents),
        sha256: "a".repeat(64),
        created_at: "2026-10-03T10:00:00.000Z",
        expires_at: "2026-10-10T10:00:00.000Z",
        extraction: { status: "not_applicable" },
        pdf_trust: { status: "not_applicable" },
      },
      share_url: shareUrl,
    }, { status: 201 }));
    const configuration = {
      profileName: "local",
      baseUrl: new URL("http://127.0.0.1:8787"),
      workspaceRoots: [canonicalRoot],
      openDevelopment: true,
      headless: false,
      environmentStore: {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn(),
        delete: vi.fn(),
      },
      connectionController: {
        status: vi.fn().mockResolvedValue({
          status: "connected" as const,
          profile: "local",
          origin: "http://127.0.0.1:8787",
        }),
        connect: vi.fn(),
      },
      fetch: uploadFetch,
    };
    let approved = false;
    const source: BridgeConfigurationSource = {
      defaultConfiguration: () => configuration,
      forWorkspacePath: () => configuration,
      resolveWorkspacePath: vi.fn(async () => approved
        ? { status: "approved" as const, configuration, workspaceRoot: canonicalRoot }
        : {
            status: "workspace_required" as const,
            workspaceRoot: canonicalRoot,
            proposedOrigin: "http://127.0.0.1:8787",
            availableOrigins: ["http://127.0.0.1:8787"],
            deploymentFixed: false,
          }),
      approveWorkspace: vi.fn(async (_request, origin) => {
        expect(origin).toBe("http://127.0.0.1:8787");
        approved = true;
      }),
      forShareUrl: () => configuration,
      runtimeKey: () => "local",
    };
    const server = createBridgeServer(source, {
      openWorkspaceApprovalBrowser: vi.fn().mockResolvedValue(undefined),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "artifactpass-workspace-resume-test", version: "0.0.0" });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const blocked = await client.callTool({
        name: "publish_artifact",
        arguments: { path: artifact, workspace_root: root, expires_in_seconds: 604800 },
      });
      expect(blocked).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "workspace_not_approved" } },
      });
      expect(uploadFetch).not.toHaveBeenCalled();

      const started = await client.callTool({
        name: "connect_artifactpass",
        arguments: { workspace_path: artifact, workspace_root: root },
      });
      const approvalUrl = String((started.structuredContent as { approval_url?: unknown }).approval_url);
      const html = await (await fetch(approvalUrl)).text();
      const token = hiddenValue(html, "token");
      await fetch(new URL("/workspace-approval", approvalUrl), {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: new URL(approvalUrl).origin,
        },
        body: new URLSearchParams({
          action: "approve",
          token,
          origin: "http://127.0.0.1:8787",
        }),
      });

      await expect(client.callTool({
        name: "connection_status",
        arguments: { workspace_path: artifact, workspace_root: root },
      })).resolves.toMatchObject({
        structuredContent: { ready_to_publish: true, workspace_status: "approved" },
      });
      await expect(client.callTool({
        name: "publish_artifact",
        arguments: { path: artifact, workspace_root: root, expires_in_seconds: 604800 },
      })).resolves.toMatchObject({ structuredContent: { share_url: shareUrl } });
      expect(uploadFetch).toHaveBeenCalledTimes(1);
      const upload = uploadFetch.mock.calls[0]?.[1]?.body as FormData;
      expect(upload.get("expires_in_seconds")).toBe("604800");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("does not grant access when approval is cancelled", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "artifactpass-workspace-cancel-"));
    temporaryRoots.push(root);
    const configHome = resolve(root, "config-home");
    const configPath = resolve(configHome, "artifactpass", "config.json");
    const workspace = resolve(root, "cancel-project");
    await mkdir(workspace);
    const source = createBridgeConfigurationSource({ XDG_CONFIG_HOME: configHome }, root);
    const server = createBridgeServer(source, {
      openWorkspaceApprovalBrowser: vi.fn().mockResolvedValue(undefined),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "artifactpass-workspace-cancel-test", version: "0.0.0" });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const started = await client.callTool({
        name: "connect_artifactpass",
        arguments: { workspace_path: workspace },
      });
      const approvalUrl = String((started.structuredContent as { approval_url?: unknown }).approval_url);
      const html = await (await fetch(approvalUrl)).text();
      const token = hiddenValue(html, "token");
      const cancelled = await fetch(new URL("/workspace-approval", approvalUrl), {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: new URL(approvalUrl).origin,
        },
        body: new URLSearchParams({ action: "cancel", token }),
      });
      expect(cancelled.status).toBe(200);
      await expect(client.callTool({
        name: "connection_status",
        arguments: { workspace_path: workspace },
      })).resolves.toMatchObject({
        structuredContent: {
          status: "failed",
          error_code: "workspace_approval_cancelled",
          ready_to_publish: false,
        },
      });
      await expect(readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("keeps approval scoped against replay, cross-origin posts, and unsafe folder text", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "artifactpass-workspace-safety-"));
    temporaryRoots.push(root);
    const configHome = resolve(root, "config-home");
    const configPath = resolve(configHome, "artifactpass", "config.json");
    const workspace = resolve(root, "<img src=x onerror=alert(1)>");
    await mkdir(workspace);
    const openBrowser = vi.fn().mockRejectedValue(new Error("No default browser"));
    const server = createBridgeServer(
      createBridgeConfigurationSource({ XDG_CONFIG_HOME: configHome }, root),
      { openWorkspaceApprovalBrowser: openBrowser },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "artifactpass-workspace-safety-test", version: "0.0.0" });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const first = await client.callTool({
        name: "connect_artifactpass",
        arguments: { workspace_path: workspace },
      });
      const second = await client.callTool({
        name: "connect_artifactpass",
        arguments: { workspace_path: workspace },
      });
      expect(second.structuredContent).toMatchObject(first.structuredContent as Record<string, unknown>);
      expect(first.structuredContent).toMatchObject({ browser_opened: false });
      expect(openBrowser).toHaveBeenCalledTimes(1);
      const approvalUrl = String((first.structuredContent as { approval_url?: unknown }).approval_url);
      const page = await fetch(approvalUrl);
      const html = await page.text();
      expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
      expect(html).not.toContain("<img src=x onerror=alert(1)>");
      const token = hiddenValue(html, "token");

      const rejected = await fetch(new URL("/workspace-approval", approvalUrl), {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://attacker.invalid",
        },
        body: new URLSearchParams({ action: "approve", token, origin: "https://artifactpass.com" }),
      });
      expect(rejected.status).toBe(403);
      await expect(readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      const cancelled = await fetch(new URL("/workspace-approval", approvalUrl), {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: new URL(approvalUrl).origin,
        },
        body: new URLSearchParams({ action: "cancel", token }),
      });
      expect(cancelled.status).toBe(200);
      await expect(fetch(approvalUrl)).rejects.toThrow();
      await expect(readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("expires without granting project access", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "artifactpass-workspace-expiry-"));
    temporaryRoots.push(root);
    const configHome = resolve(root, "config-home");
    const configPath = resolve(configHome, "artifactpass", "config.json");
    const workspace = resolve(root, "expiring-project");
    await mkdir(workspace);
    const server = createBridgeServer(
      createBridgeConfigurationSource({ XDG_CONFIG_HOME: configHome }, root),
      {
        openWorkspaceApprovalBrowser: vi.fn().mockResolvedValue(undefined),
        workspaceApprovalTimeoutMilliseconds: 10,
      },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "artifactpass-workspace-expiry-test", version: "0.0.0" });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      await client.callTool({
        name: "connect_artifactpass",
        arguments: { workspace_path: workspace },
      });
      await vi.waitFor(async () => {
        const status = await client.callTool({
          name: "connection_status",
          arguments: { workspace_path: workspace },
        });
        expect(status.structuredContent).toMatchObject({
          status: "failed",
          error_code: "workspace_approval_expired",
        });
      });
      await expect(readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
