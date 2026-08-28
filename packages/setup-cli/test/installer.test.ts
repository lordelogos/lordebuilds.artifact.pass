import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  ArtifactpassInstallError,
  parseArtifactpassInstallReceipt,
  renderInstallFailure,
  renderInstallReceipt,
  runArtifactpassInstall,
  type ArtifactpassInstallReceipt,
} from "../src/installer";

const portableFixture = async (root: string) => {
  const rootDirectory = resolve(root, "portable");
  const skillsDirectory = resolve(rootDirectory, "plugin", "skills");
  for (const name of ["read-shared-artifact", "share-artifact"]) {
    const directory = resolve(skillsDirectory, name);
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, "SKILL.md"), `---\nname: ${name}\ndescription: test\n---\n`);
  }
  const mcpConfig = resolve(rootDirectory, "mcp.json");
  await writeFile(mcpConfig, "{}");
  return {
    digest: "a".repeat(64),
    rootDirectory,
    mcpConfig,
    skillsDirectory,
  };
};

describe("one-command ArtifactPass installer", () => {
  it("installs the plugin and MCP without starting authentication", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "artifactpass-installer-disconnected-"));
    const workspace = resolve(root, "workspace");
    await mkdir(workspace);
    const configPath = resolve(root, "config", "config.json");
    const portable = await portableFixture(root);
    const connect = vi.fn();

    const receipt = await runArtifactpassInstall({
      marketplaceSource: "/package/marketplace",
      workspaceRoot: workspace,
      configPath,
      connectAfterInstall: false,
      installKnownHostAdapters: false,
    }, {
      connect,
      connectDependencies: { deviceFlowDependencies: { openBrowser: async () => undefined } },
      installPortable: vi.fn().mockResolvedValue(portable),
      smoke: vi.fn().mockResolvedValue({
        negotiated: true,
        tools: ["connect_artifactpass", "connection_status", "publish_artifact", "read_artifact"],
        representativeInvocation: true,
      }),
      operationId: () => "disconnected-operation",
    });

    expect(connect).not.toHaveBeenCalled();
    expect(receipt).toMatchObject({
      status: "success",
      origin: "https://artifactpass.com",
      credential: "none",
      mcp: { negotiated: true },
      skills: { verified: true },
    });
    await expect(readFile(configPath, "utf8").then(JSON.parse)).resolves.toMatchObject({
      active_profile: "production",
      workspace_profiles: {
        [workspace]: "production",
      },
      profiles: {
        production: {
          base_url: "https://artifactpass.com",
          workspace_roots: [workspace],
        },
      },
    });
    expect(renderInstallReceipt(receipt)).toContain("installed");
    expect(renderInstallReceipt(receipt)).toContain("not connected");
    expect(renderInstallReceipt(receipt)).toContain("choose Connect ArtifactPass");
  });

  it("rebinds one workspace without changing another workspace's deployment", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "artifactpass-installer-workspace-rebind-"));
    const personalWorkspace = resolve(root, "personal");
    const companyWorkspace = resolve(root, "company");
    await mkdir(personalWorkspace);
    await mkdir(companyWorkspace);
    const configPath = resolve(root, "config", "config.json");
    const portable = await portableFixture(root);
    const dependencies = {
      connectDependencies: { deviceFlowDependencies: { openBrowser: async () => undefined } },
      installPortable: vi.fn().mockResolvedValue(portable),
      smoke: vi.fn().mockResolvedValue({
        negotiated: true,
        tools: ["connect_artifactpass", "connection_status", "publish_artifact", "read_artifact"],
        representativeInvocation: true,
      }),
    };

    await runArtifactpassInstall({
      marketplaceSource: "/package/marketplace",
      workspaceRoot: personalWorkspace,
      configPath,
      connectAfterInstall: false,
      installKnownHostAdapters: false,
    }, { ...dependencies, operationId: () => "personal-install" });
    await runArtifactpassInstall({
      marketplaceSource: "/package/marketplace",
      baseUrl: "https://artifacts.company.example",
      profileName: "company",
      workspaceRoot: companyWorkspace,
      configPath,
      connectAfterInstall: false,
      installKnownHostAdapters: false,
    }, { ...dependencies, operationId: () => "company-install" });

    await expect(readFile(configPath, "utf8").then(JSON.parse)).resolves.toMatchObject({
      workspace_profiles: {
        [personalWorkspace]: "production",
        [companyWorkspace]: "company",
      },
      profiles: {
        production: { base_url: "https://artifactpass.com" },
        company: { base_url: "https://artifacts.company.example" },
      },
    });
  });

  it("preserves publication and PDF settings when reinstalling without authentication", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "artifactpass-installer-preserve-profile-"));
    const workspace = resolve(root, "workspace");
    const previousWorkspace = resolve(root, "previous-workspace");
    const publicationStatePath = resolve(root, "publication-state.json");
    await mkdir(workspace);
    const configPath = resolve(root, "config", "config.json");
    await mkdir(resolve(root, "config"));
    await writeFile(configPath, JSON.stringify({
      version: 2,
      active_profile: "production",
      profiles: {
        production: {
          base_url: "https://artifactpass.com",
          workspace_roots: [previousWorkspace],
          credential_namespace: "artifactpass",
          credential_binding: "origin",
          pdf_key_id: "artifactpass-primary",
          publication_state: "legacy",
          publication_state_path: publicationStatePath,
        },
      },
    }));
    const portable = await portableFixture(root);

    await runArtifactpassInstall({
      marketplaceSource: "/package/marketplace",
      workspaceRoot: workspace,
      configPath,
      connectAfterInstall: false,
      installKnownHostAdapters: false,
    }, {
      connectDependencies: { deviceFlowDependencies: { openBrowser: async () => undefined } },
      installPortable: vi.fn().mockResolvedValue(portable),
      smoke: vi.fn().mockResolvedValue({
        negotiated: true,
        tools: ["connect_artifactpass", "connection_status", "publish_artifact", "read_artifact"],
        representativeInvocation: true,
      }),
      operationId: () => "preserve-profile-operation",
    });

    await expect(readFile(configPath, "utf8").then(JSON.parse)).resolves.toMatchObject({
      active_profile: "production",
      profiles: {
        production: {
          base_url: "https://artifactpass.com",
          workspace_roots: [previousWorkspace, workspace],
          credential_namespace: "artifactpass",
          credential_binding: "origin",
          pdf_key_id: "artifactpass-primary",
          publication_state: "legacy",
          publication_state_path: publicationStatePath,
        },
      },
    });
  });

  it("preserves the active deployment during a bare disconnected reinstall", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "artifactpass-installer-active-profile-"));
    const workspace = resolve(root, "workspace");
    await mkdir(workspace);
    const configPath = resolve(root, "config", "config.json");
    await mkdir(resolve(root, "config"));
    await writeFile(configPath, JSON.stringify({
      version: 2,
      active_profile: "company",
      profiles: {
        company: {
          base_url: "https://artifacts.company.example",
          workspace_roots: [workspace],
          credential_namespace: "artifactpass",
          credential_binding: "origin",
        },
      },
    }));
    const portable = await portableFixture(root);

    await runArtifactpassInstall({
      marketplaceSource: "/package/marketplace",
      workspaceRoot: workspace,
      configPath,
      connectAfterInstall: false,
      installKnownHostAdapters: false,
    }, {
      connectDependencies: { deviceFlowDependencies: { openBrowser: async () => undefined } },
      installPortable: vi.fn().mockResolvedValue(portable),
      smoke: vi.fn().mockResolvedValue({
        negotiated: true,
        tools: ["connect_artifactpass", "connection_status", "publish_artifact", "read_artifact"],
        representativeInvocation: true,
      }),
      operationId: () => "active-profile-operation",
    });

    await expect(readFile(configPath, "utf8").then(JSON.parse)).resolves.toMatchObject({
      active_profile: "company",
      workspace_profiles: {
        [workspace]: "company",
      },
      profiles: {
        company: {
          base_url: "https://artifacts.company.example",
          credential_binding: "origin",
        },
      },
    });
  });

  it("refuses to retarget an existing profile during disconnected installation", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "artifactpass-installer-retarget-profile-"));
    const workspace = resolve(root, "workspace");
    await mkdir(workspace);
    const configPath = resolve(root, "config", "config.json");
    await mkdir(resolve(root, "config"));
    const originalSettings = {
      version: 2,
      active_profile: "company",
      profiles: {
        company: {
          base_url: "https://artifacts.company.example",
          workspace_roots: [workspace],
          credential_namespace: "artifactpass",
        },
      },
    } as const;
    await writeFile(configPath, JSON.stringify(originalSettings));
    const portable = await portableFixture(root);

    await expect(runArtifactpassInstall({
      marketplaceSource: "/package/marketplace",
      baseUrl: "https://artifactpass.com",
      profileName: "company",
      workspaceRoot: workspace,
      configPath,
      connectAfterInstall: false,
      installKnownHostAdapters: false,
    }, {
      connectDependencies: { deviceFlowDependencies: { openBrowser: async () => undefined } },
      installPortable: vi.fn().mockResolvedValue(portable),
      operationId: () => "retarget-profile-operation",
    })).rejects.toThrow("installation failed during connection");

    await expect(readFile(configPath, "utf8").then(JSON.parse)).resolves.toEqual(originalSettings);
  });

  it("returns one private, redacted receipt after connection and MCP verification", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "artifactpass-installer-success-"));
    const workspace = resolve(root, "workspace");
    await mkdir(workspace);
    const configPath = resolve(root, "config", "config.json");
    const portable = await portableFixture(root);
    const connect = vi.fn(async (input, dependencies) => {
      await dependencies.verifyConnection?.({
        configPath,
        profileName: "production",
        hosts: ["codex", "claude"],
      });
      return {
        hosts: ["codex", "claude"] as const,
        profileName: "production",
        configPath,
        expiresIn: 3600,
        credentialAction: "created" as const,
        migration: {
          operationId: "migration-operation",
          actions: ["config"],
          legacyPreserved: true,
        },
      };
    });

    const receipt = await runArtifactpassInstall({
      marketplaceSource: "/package/marketplace",
      connectAfterInstall: true,
      workspaceRoot: workspace,
      configPath,
    }, {
      connect,
      connectDependencies: { deviceFlowDependencies: { openBrowser: async () => undefined } },
      installPortable: vi.fn().mockResolvedValue(portable),
      smoke: vi.fn().mockResolvedValue({
        negotiated: true,
        tools: ["connect_artifactpass", "connection_status", "publish_artifact", "read_artifact"],
        representativeInvocation: true,
      }),
      skipCredentialStorePreflight: true,
      operationId: () => "install-operation",
    });

    expect(receipt).toMatchObject({
      receipt_version: 3,
      product: "ArtifactPass",
      operation_id: "install-operation",
      status: "success",
      profile: "production",
      origin: "https://artifactpass.com",
      workspace_roots: [workspace],
      adapters: ["codex", "claude"],
      portable_bundle: {
        sha256: "a".repeat(64),
        host_registration: "installed",
      },
      mcp: {
        negotiated: true,
        tools: ["connect_artifactpass", "connection_status", "publish_artifact", "read_artifact"],
        representative_invocation: true,
      },
      skills: {
        verified: true,
        names: ["read-shared-artifact", "share-artifact"],
      },
      credential: "created",
      migration: { actions: ["config"], legacy_preserved: true },
      restart_required: true,
      rollback: "not-required",
    });
    expect(receipt.portable_bundle).not.toHaveProperty("mcp_config");
    expect(connect).toHaveBeenCalledWith(
      expect.not.objectContaining({ hostBridgePath: expect.anything() }),
      expect.anything(),
    );
    expect(parseArtifactpassInstallReceipt(receipt)).toEqual(receipt);
    expect(() => parseArtifactpassInstallReceipt({ ...receipt, receipt_version: 1 })).toThrow(
      "ArtifactPass install receipt v3 is invalid",
    );
    expect(() => parseArtifactpassInstallReceipt({ ...receipt, unexpected: true })).toThrow(
      "ArtifactPass install receipt v3 is invalid",
    );
    expect(renderInstallReceipt(receipt)).toContain("Start a new agent session");
    const persisted = await readFile(receipt.receipt_path, "utf8");
    expect(JSON.parse(persisted)).toEqual(receipt);
    expect((await stat(receipt.receipt_path)).mode & 0o777).toBe(0o600);
    expect(persisted).not.toMatch(/as_[A-Za-z0-9_-]{43}/u);
    expect(persisted).not.toContain("private-key-material");
  });

  it("keeps old receipt inventories immutable and versions connection tools as v3", async () => {
    const [v1, v2, current] = await Promise.all([
      readFile(new URL("../install-receipt-v1.schema.json", import.meta.url), "utf8").then(JSON.parse),
      readFile(new URL("../install-receipt-v2.schema.json", import.meta.url), "utf8").then(JSON.parse),
      readFile(new URL("../install-receipt.schema.json", import.meta.url), "utf8").then(JSON.parse),
    ]);
    const tools = (schema: { properties: { mcp: { properties: { tools: { items: { enum: string[] } } } } } }) =>
      schema.properties.mcp.properties.tools.items.enum;

    expect(v1.properties.receipt_version.const).toBe(1);
    expect(v2.properties.receipt_version.const).toBe(2);
    expect(tools(v1)).toEqual(["publish_artifact", "read_artifact"]);
    expect(tools(v2)).toEqual(["publish_artifact", "read_artifact"]);
    expect(current.properties.receipt_version.const).toBe(3);
    expect(tools(current)).toEqual([
      "connect_artifactpass", "connection_status", "publish_artifact", "read_artifact",
    ]);
  });

  it("reports exact portable registration paths when no adapter is available", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "artifactpass-installer-portable-"));
    const workspace = resolve(root, "workspace");
    await mkdir(workspace);
    const configPath = resolve(root, "config.json");
    const portable = await portableFixture(root);
    const connect = vi.fn(async (_input, dependencies) => {
      await dependencies.verifyConnection?.({
        configPath,
        profileName: "production",
        hosts: [],
        portableIntegration: portable,
      });
      return {
        hosts: [] as const,
        profileName: "production",
        configPath,
        credentialAction: "reused" as const,
      };
    });

    const receipt = await runArtifactpassInstall({
      marketplaceSource: "/package/marketplace",
      connectAfterInstall: true,
      workspaceRoot: workspace,
      configPath,
    }, {
      connect,
      connectDependencies: { deviceFlowDependencies: { openBrowser: async () => undefined } },
      installPortable: vi.fn().mockResolvedValue(portable),
      smoke: vi.fn().mockResolvedValue({
        negotiated: true,
        tools: ["connect_artifactpass", "connection_status", "publish_artifact", "read_artifact"],
        representativeInvocation: true,
      }),
      skipCredentialStorePreflight: true,
      operationId: () => "portable-operation",
    });

    expect(receipt.portable_bundle).toEqual({
      sha256: portable.digest,
      host_registration: "manual-required",
      mcp_config: portable.mcpConfig,
      skills_directory: portable.skillsDirectory,
    });
    expect(renderInstallReceipt(receipt)).toContain(portable.mcpConfig);
  });

  it("removes a newly created portable bundle when verification fails", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "artifactpass-installer-rollback-"));
    const workspace = resolve(root, "workspace");
    await mkdir(workspace);
    const configPath = resolve(root, "config.json");
    const portable = await portableFixture(root);
    const connect = vi.fn(async (_input, dependencies) => {
      await dependencies.verifyConnection?.({
        configPath,
        profileName: "local-eval",
        hosts: [],
      });
      throw new Error("verification should have failed");
    });
    let failure: ArtifactpassInstallError | undefined;

    try {
      await runArtifactpassInstall({
        marketplaceSource: "/package/marketplace",
        connectAfterInstall: true,
        workspaceRoot: workspace,
        configPath,
        openDevelopment: true,
        installKnownHostAdapters: false,
      }, {
        connect,
        connectDependencies: { deviceFlowDependencies: { openBrowser: async () => undefined } },
        installPortable: vi.fn().mockResolvedValue(portable),
        portableWasCreated: () => true,
        smoke: vi.fn().mockRejectedValue(new Error("MCP verification failed")),
        skipCredentialStorePreflight: true,
        operationId: () => "rollback-operation",
      });
    } catch (error) {
      if (error instanceof ArtifactpassInstallError) failure = error;
      else throw error;
    }

    expect(failure?.receipt).toMatchObject({
      status: "failed",
      failed_stage: "connection",
      rollback: "complete",
      outcomes: expect.arrayContaining(["rollback:complete"]),
    });
    expect(renderInstallFailure(failure as ArtifactpassInstallError))
      .toContain("Cause: MCP verification failed");
    expect(renderInstallFailure(failure as ArtifactpassInstallError))
      .not.toContain("Previous working state was restored");
    await expect(stat(portable.rootDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(configPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports incomplete rollback when a committed host registration cannot be verified removed", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "artifactpass-installer-incomplete-"));
    const workspace = resolve(root, "workspace");
    await mkdir(workspace);
    const configPath = resolve(root, "config.json");
    const portable = await portableFixture(root);
    const connect = vi.fn(async (_input, dependencies) => {
      await dependencies.verifyConnection?.({
        configPath,
        profileName: "production",
        hosts: ["codex"],
      });
      return {
        hosts: ["codex"] as const,
        profileName: "production",
        configPath,
        credentialAction: "reused" as const,
      };
    });

    let failure: ArtifactpassInstallError | undefined;
    try {
      await runArtifactpassInstall({
        marketplaceSource: "/package/marketplace",
        connectAfterInstall: true,
        workspaceRoot: workspace,
        configPath,
      }, {
        connect,
        connectDependencies: { deviceFlowDependencies: { openBrowser: async () => undefined } },
        installPortable: vi.fn().mockResolvedValue(portable),
        portableWasCreated: () => false,
        smoke: vi.fn().mockResolvedValue({
          negotiated: true,
          tools: ["connect_artifactpass", "connection_status", "publish_artifact", "read_artifact"],
          representativeInvocation: true,
        }),
        skipCredentialStorePreflight: true,
        operationId: () => "incomplete-operation",
        afterStage: (stage) => {
          if (stage === "connection") throw new Error("staged failure");
        },
      });
    } catch (error) {
      if (error instanceof ArtifactpassInstallError) failure = error;
      else throw error;
    }

    expect(failure?.receipt).toMatchObject({
      rollback: "incomplete",
      rollback_failures: ["host-registration-unverified"],
    });
    expect(renderInstallReceipt(failure?.receipt as ArtifactpassInstallReceipt))
      .toContain("Rollback is incomplete: host-registration-unverified");
  });

  it("fails before connection for unsafe roots and emits the same receipt shape", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "artifactpass-installer-preflight-"));
    const connect = vi.fn();
    let failure: ArtifactpassInstallError | undefined;
    try {
      await runArtifactpassInstall({
        marketplaceSource: "/package/marketplace",
        connectAfterInstall: true,
        workspaceRoot: root,
        configPath: resolve(root, "config.json"),
      }, {
        connect,
        connectDependencies: { deviceFlowDependencies: { openBrowser: async () => undefined } },
        homeDirectory: root,
        skipCredentialStorePreflight: true,
        operationId: () => "failed-operation",
      });
    } catch (error) {
      if (error instanceof ArtifactpassInstallError) failure = error;
      else throw error;
    }

    expect(failure?.receipt).toMatchObject({
      receipt_version: 3,
      status: "failed",
      failed_stage: "preflight",
      rollback: "complete",
      operation_id: "failed-operation",
    });
    expect(connect).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(failure?.receipt.receipt_path ?? "", "utf8")))
      .toEqual(failure?.receipt);
  });

  it.each([
    ["missing credential store", "linux" as const, vi.fn().mockRejectedValue(new Error("missing secret-tool"))],
    ["unsupported platform", "win32" as const, vi.fn()],
  ])("fails preflight for %s", async (_label, platform, runner) => {
    const root = await mkdtemp(resolve(tmpdir(), "artifactpass-installer-platform-"));
    const workspace = resolve(root, "workspace");
    await mkdir(workspace);
    const connect = vi.fn();

    await expect(runArtifactpassInstall({
      marketplaceSource: "/package/marketplace",
      connectAfterInstall: true,
      workspaceRoot: workspace,
      configPath: resolve(root, "config.json"),
    }, {
      connect,
      connectDependencies: { deviceFlowDependencies: { openBrowser: async () => undefined } },
      platform,
      runner,
      operationId: () => `preflight-${platform}`,
    })).rejects.toMatchObject({
      receipt: { status: "failed", failed_stage: "preflight" },
    });
    expect(connect).not.toHaveBeenCalled();
  });

  it("records and resumes an interrupted operation under a new operation ID", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "artifactpass-installer-resume-"));
    const workspace = resolve(root, "workspace");
    await mkdir(workspace);
    const configPath = resolve(root, "config.json");
    await writeFile(`${configPath}.install.json`, JSON.stringify({
      version: 1,
      operation_id: "interrupted-operation",
      status: "in-progress",
      stage: "connection",
      started_at: 1,
    }));
    const portable = await portableFixture(root);
    const connect = vi.fn(async (_input, dependencies) => {
      await dependencies.verifyConnection?.({
        configPath,
        profileName: "production",
        hosts: ["codex"],
      });
      return {
        hosts: ["codex"] as const,
        profileName: "production",
        configPath,
        credentialAction: "reused" as const,
      };
    });

    const receipt = await runArtifactpassInstall({
      marketplaceSource: "/package/marketplace",
      connectAfterInstall: true,
      workspaceRoot: workspace,
      configPath,
    }, {
      connect,
      connectDependencies: { deviceFlowDependencies: { openBrowser: async () => undefined } },
      installPortable: vi.fn().mockResolvedValue(portable),
      smoke: vi.fn().mockResolvedValue({
        negotiated: true,
        tools: ["connect_artifactpass", "connection_status", "publish_artifact", "read_artifact"],
        representativeInvocation: true,
      }),
      skipCredentialStorePreflight: true,
      operationId: () => "resumed-operation",
    });

    expect(receipt.resumed_from).toBe("interrupted-operation");
    expect(JSON.parse(await readFile(`${configPath}.install.json`, "utf8")))
      .toMatchObject({ status: "committed", operation_id: "resumed-operation" });
  });
});
