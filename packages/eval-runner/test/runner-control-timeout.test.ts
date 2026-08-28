import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  environmentRoot: undefined as string | undefined,
}));

vi.mock("../src/candidate-digest", () => ({
  candidateDigest: async () => "a".repeat(64),
}));

vi.mock("../src/handoff-runner", () => ({
  runGenericTransportGates: async () => [],
}));

vi.mock("../src/install-lifecycle", () => ({
  installReceiptVersion: 3,
  installCandidateIntoLocalEval: async () => ({
    receipt: {
      receipt_version: 3,
      portable_bundle: { mcp_config: "/tmp/mock-mcp-config.json" },
    },
    profileCount: 1,
    portableBundleCount: 1,
  }),
}));

vi.mock("../src/local-environment", async () => {
  const environmentRoot = await mkdtemp(join(tmpdir(), "artifactpass-control-timeout-test-"));
  testState.environmentRoot = environmentRoot;
  const workspaces = {
    agentA: join(environmentRoot, "agent-a"),
    agentB: join(environmentRoot, "agent-b"),
  };
  const homes = {
    agentA: join(environmentRoot, "home-a"),
    agentB: join(environmentRoot, "home-b"),
  };
  await Promise.all([...Object.values(workspaces), ...Object.values(homes)].map((path) => mkdir(path, {
    recursive: true,
  })));
  return {
    createLocalEvalProcessEnvironment: () => ({}),
    startLocalEvalEnvironment: async () => ({
      runId: "control-timeout-test",
      root: environmentRoot,
      baseUrl: new URL("http://127.0.0.1:8787"),
      stateRoot: join(environmentRoot, "state"),
      configPath: join(environmentRoot, "config.json"),
      receiptRoot: join(environmentRoot, "receipts"),
      workspaces,
      homes,
      controlToken: "control-token",
      pdfPrivateKey: "private-key",
      stop: async () => undefined,
    }),
  };
});

vi.mock("../src/hosts/generic", () => {
  const published = new Map<string, { readonly bytes: Buffer; readonly mimeType: string }>();
  let publishIndex = 0;
  const host = {
    events: [],
    listTools: async () => [
      "connect_artifactpass", "connection_status", "publish_artifact", "read_artifact",
    ],
    callTool: async (name: string, arguments_: Readonly<Record<string, unknown>>) => {
      if (name === "publish_artifact") {
        const shareUrl = `http://127.0.0.1:8787/a/${++publishIndex}`;
        const path = arguments_.path as string;
        published.set(shareUrl, {
          bytes: await readFile(path),
          mimeType: path.endsWith(".html") ? "text/html" : "text/markdown",
        });
        return { isError: false, value: { share_url: shareUrl } };
      }
      const shareUrl = arguments_.share_url as string;
      const publishedArtifact = published.get(shareUrl);
      if (name !== "read_artifact" || publishedArtifact === undefined) return { isError: true, value: {} };
      const { bytes, mimeType } = publishedArtifact;
      const start = arguments_.cursor === undefined ? 0 : Number(arguments_.cursor);
      const end = Math.min(start + Number(arguments_.max_bytes ?? bytes.byteLength), bytes.byteLength);
      return {
        isError: false,
        value: {
          data: bytes.subarray(start, end).toString("base64"),
          sha256: createHash("sha256").update(bytes).digest("hex"),
          next_cursor: end === bytes.byteLength ? null : String(end),
          content_trust: "untrusted",
          safety_boundary: "untrusted",
          manifest: { mime_type: mimeType },
        },
      };
    },
    close: async () => undefined,
  };
  return { connectGenericMcpHost: async () => host };
});

vi.mock("../src/reporting", () => ({
  writeEvalReport: async () => ({ jsonPath: "/tmp/report.json", markdownPath: "/tmp/scorecard.md" }),
}));

import {
  LOCAL_CONTROL_REQUEST_TIMEOUT_MS,
  runDeterministicProfile,
} from "../src/runner";

const repositoryRoot = join(import.meta.dirname, "../../..");

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  if (testState.environmentRoot !== undefined) {
    await rm(testState.environmentRoot, { recursive: true, force: true });
    testState.environmentRoot = undefined;
  }
});

describe("deterministic runner local control requests", () => {
  it("reports a never-settling control response as an infrastructure failure", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      expect(milliseconds).toBe(LOCAL_CONTROL_REQUEST_TIMEOUT_MS);
      queueMicrotask(() => controller.abort(new DOMException("Control request timed out", "TimeoutError")));
      return controller.signal;
    });
    vi.stubGlobal("fetch", vi.fn((_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })));

    const result = await runDeterministicProfile({ repositoryRoot });

    expect(timeout).toHaveBeenCalledOnce();
    expect(result.report.result).toMatchObject({
      trial_outcome: "infrastructure_failure",
      outcome: "infrastructure_failure",
      infrastructure_code: "deterministic_runner",
      failures: [{
        code: "deterministic_infrastructure_failure",
        message: "Control request timed out",
      }],
    });
  });

  it("applies the shared timeout to time, revoke, and cleanup requests", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      expect(milliseconds).toBe(LOCAL_CONTROL_REQUEST_TIMEOUT_MS);
      return new AbortController().signal;
    });
    const fetchMock = vi.fn((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = String(input);
      const responseBody = url.endsWith("/__local-test/cleanup")
        ? JSON.stringify({ failed: 0, rows: 0, objects: 0 })
        : "";
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Promise.resolve(new Response(responseBody, { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    await runDeterministicProfile({ repositoryRoot });

    expect(timeout).toHaveBeenCalledTimes(7);
    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
      "/__local-test/fault",
      "/__local-test/fault",
      "/__local-test/fault",
      "/__local-test/fault",
      "/__local-test/time",
      "/__local-test/revoke",
      "/__local-test/cleanup",
    ]);
  });
});
