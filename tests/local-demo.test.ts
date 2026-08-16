import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";

import {
  chromium,
  expect as expectPage,
  type Browser,
  type BrowserContext,
} from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FilePublicationJournal } from "../packages/agent-bridge/src/state/publication-journal";
import { publishArtifact } from "../packages/agent-bridge/src/tools/publish-artifact";
import { readArtifact } from "../packages/agent-bridge/src/tools/read-artifact";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const applicationRoot = join(repositoryRoot, "apps/artifact-service");
const migrationsRoot = join(applicationRoot, "migrations");
const workerEntry = join(applicationRoot, "src/demo/index.ts");

interface PublishedArtifact {
  readonly bytes: Buffer;
  readonly mimeType: "text/markdown" | "text/html" | "application/pdf";
  readonly shareUrl: string;
}

interface CleanupResult {
  readonly scanned: number;
  readonly deleted: number;
  readonly failed: number;
  readonly rows: number;
  readonly objects: number;
}

let temporaryRoot = "";
let stateRoot = "";
let configPath = "";
let baseUrl = "";
let controlToken = "";
let demoProcess: ChildProcess | undefined;
let browser: Browser | undefined;
let mobileContext: BrowserContext | undefined;
let processLog = "";

const freePort = async (): Promise<number> => new Promise((resolvePort, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      reject(new Error("Could not allocate a local demo port"));
      return;
    }
    server.close((error) => error === undefined ? resolvePort(address.port) : reject(error));
  });
});

const run = async (arguments_: readonly string[]): Promise<void> => new Promise((resolveRun, reject) => {
  const child = spawn("pnpm", arguments_, {
    cwd: repositoryRoot,
    env: { ...process.env, CI: "1", NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk) => { output += String(chunk); });
  child.stderr?.on("data", (chunk) => { output += String(chunk); });
  child.once("error", reject);
  child.once("exit", (code) => {
    if (code === 0) resolveRun();
    else reject(new Error(`Command failed (${code ?? "signal"}): pnpm ${arguments_.join(" ")}\n${output}`));
  });
});

const waitForHealth = async (): Promise<void> => {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (demoProcess?.exitCode !== null) {
      throw new Error(`Local demo exited before becoming healthy.\n${processLog}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // The Worker is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error(`Local demo did not become healthy.\n${processLog}`);
};

const startDemo = async (): Promise<void> => {
  processLog = "";
  demoProcess = spawn(
    "pnpm",
    ["--dir", applicationRoot, "exec", "vite", "--config", "vite-demo.config.ts"],
    {
      cwd: repositoryRoot,
      detached: true,
      env: {
        ...process.env,
        ARTIFACT_SHARE_DEMO_CONFIG_PATH: configPath,
        ARTIFACT_SHARE_DEMO_STATE_PATH: stateRoot,
        ARTIFACT_SHARE_DEMO_HOST: "127.0.0.1",
        ARTIFACT_SHARE_DEMO_PORT: new URL(baseUrl).port,
        ARTIFACT_SHARE_DEMO_NO_OPEN: "1",
        CI: "1",
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const append = (chunk: unknown) => {
    processLog = `${processLog}${String(chunk)}`.slice(-20_000);
  };
  demoProcess.stdout?.on("data", append);
  demoProcess.stderr?.on("data", append);
  await waitForHealth();
};

const stopDemo = async (): Promise<void> => {
  const child = demoProcess;
  demoProcess = undefined;
  if (child?.pid === undefined || child.exitCode !== null) return;
  const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise<false>((resolveWait) => setTimeout(() => resolveWait(false), 10_000)),
  ]);
  if (!graceful) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
    await exited;
  }
};

const control = async <T>(path: string, body?: unknown): Promise<T> => {
  const response = await fetch(`${baseUrl}/__local-test/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-artifact-test-control": controlToken,
    },
    body: JSON.stringify(body ?? {}),
  });
  if (!response.ok) throw new Error(`Local test control ${path} failed: ${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
};

const sha256 = async (bytes: Uint8Array): Promise<string> =>
  Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");

const textPdf = (text: string): Buffer => {
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let source = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(source));
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(source);
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  source += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(source);
};

const expectExactRepresentations = async (artifact: PublishedArtifact): Promise<void> => {
  const manifestResponse = await fetch(`${artifact.shareUrl}/manifest`);
  expect(manifestResponse.status).toBe(200);
  const manifest = await manifestResponse.json() as {
    byte_size: number;
    mime_type: string;
    sha256: string;
  };
  expect(manifest).toMatchObject({
    byte_size: artifact.bytes.byteLength,
    mime_type: artifact.mimeType,
    sha256: await sha256(artifact.bytes),
  });

  const raw = await fetch(`${artifact.shareUrl}/raw`);
  expect(raw.status).toBe(200);
  expect(raw.headers.get("content-disposition")).toContain("attachment");
  expect(Buffer.from(await raw.arrayBuffer())).toEqual(artifact.bytes);

  const agentRead = await readArtifact({ shareUrl: artifact.shareUrl }, {
    baseUrl: new URL(baseUrl),
    openDevelopment: true,
  });
  expect(agentRead.manifest.sha256).toBe(manifest.sha256);
  if (artifact.mimeType === "application/pdf") {
    expect(["derived", "pdf_metadata"]).toContain(agentRead.representation);
    expect(agentRead.exact_source_url).toBe(`${artifact.shareUrl}/raw`);
  } else {
    expect(agentRead.representation).toBe("source");
    expect(Buffer.from(agentRead.data, "base64")).toEqual(artifact.bytes);
  }
};

beforeAll(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), "artifact-share-local-demo-"));
  stateRoot = join(temporaryRoot, "state");
  configPath = join(temporaryRoot, "wrangler-local-test.jsonc");
  controlToken = randomBytes(32).toString("base64url");
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  await writeFile(configPath, `${JSON.stringify({
    name: "lordebuilds-artifacts-share-local-test",
    main: workerEntry,
    compatibility_date: "2026-08-16",
    vars: {
      ALLOWED_EXPIRY_SECONDS: "900,1800,3600,43200,86400",
      MAX_ARTIFACT_BYTES: "26214400",
      MAX_EXPIRY_SECONDS: "86400",
      LOCAL_TEST_CONTROL_TOKEN: controlToken,
    },
    d1_databases: [{
      binding: "ARTIFACT_DB",
      database_name: "lordebuilds-artifacts-share-local-test",
      database_id: "00000000-0000-0000-0000-000000000000",
      migrations_dir: migrationsRoot,
    }],
    r2_buckets: [{
      binding: "ARTIFACTS",
      bucket_name: "lordebuilds-artifacts-share-local-test",
    }],
    assets: {
      binding: "ASSETS",
      run_worker_first: ["/health", "/upload", "/connect/*", "/api/*", "/a/*", "/__local-test/*"],
    },
  }, null, 2)}\n`, { mode: 0o600 });
  await run([
    "--dir", applicationRoot,
    "exec", "wrangler", "d1", "migrations", "apply", "ARTIFACT_DB",
    "--local", "--persist-to", stateRoot, "--config", configPath,
  ]);
  await startDemo();
  browser = await chromium.launch({ headless: true });
}, 120_000);

afterAll(async () => {
  await mobileContext?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  await stopDemo();
  if (temporaryRoot !== "") await rm(temporaryRoot, { recursive: true, force: true });
});

describe("real persistent local Cloudflare lifecycle", () => {
  it("proves browser and agent flows, restart, exact expiry, and physical cleanup", async () => {
    const fixedNow = Date.now();
    expect((await fetch(`${baseUrl}/__local-test/time`, { method: "POST" })).status).toBe(404);
    await control("time", { now_ms: fixedNow });

    mobileContext = await browser?.newContext({
      hasTouch: true,
      isMobile: true,
      viewport: { width: 390, height: 844 },
    });
    if (mobileContext === undefined) throw new Error("Chromium did not create a mobile context");
    const page = await mobileContext.newPage();
    const externalRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().startsWith("https://leak.invalid")) externalRequests.push(request.url());
    });
    await page.goto(`${baseUrl}/upload`);
    await expectPage(page.getByRole("heading", { name: /Share the work/ })).toBeVisible();
    await expectPage(page.getByRole("button", { name: "Choose a file" })).toBeVisible();
    await expectPage(page.getByLabel("Link expires after")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    const markdownBytes = Buffer.from([
      "# Local lifecycle",
      "",
      "Exact Markdown survives restart.",
      '<script>document.body.dataset.executed="yes"</script>',
      '<img src="https://leak.invalid/pixel" onerror="document.body.dataset.executed=\'yes\'">',
    ].join("\n"));
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Choose a file" }).tap();
    await (await chooser).setFiles({
      name: "local-lifecycle.md",
      mimeType: "text/markdown",
      buffer: markdownBytes,
    });
    await page.getByRole("button", { name: "Create temporary link" }).tap();
    const shareField = page.getByLabel("Share URL");
    await expectPage(shareField).toHaveValue(/\/a\/[A-Za-z0-9_-]{43}$/u, { timeout: 20_000 });
    const markdownUrl = await shareField.inputValue();

    const desktopPage = await browser?.newPage({ viewport: { width: 1280, height: 800 } });
    if (desktopPage === undefined) throw new Error("Chromium did not create a desktop page");
    await desktopPage.goto(`${baseUrl}/upload`);
    await expectPage(desktopPage.getByRole("button", { name: "Choose a file" })).toBeEnabled();
    await desktopPage.keyboard.press("Tab");
    expect(await desktopPage.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe(
      "Artifact Share upload",
    );
    for (let presses = 0; presses < 3; presses += 1) {
      await desktopPage.keyboard.press("Tab");
      if (await desktopPage.getByRole("button", { name: "Choose a file" }).evaluate(
        (element) => element === document.activeElement,
      )) break;
    }
    await expectPage(desktopPage.getByRole("button", { name: "Choose a file" })).toBeFocused();
    await desktopPage.close();

    const htmlBytes = Buffer.from(
      '<main><h1>Contained HTML</h1><script>parent.document.body.dataset.executed="yes"</script><img src="https://leak.invalid/pixel"></main>',
    );
    const pdfBytes = textPdf("Agent readable PDF lifecycle");
    const htmlPath = join(temporaryRoot, "local-lifecycle.html");
    const pdfPath = join(temporaryRoot, "local-lifecycle.pdf");
    await writeFile(htmlPath, htmlBytes);
    await writeFile(pdfPath, pdfBytes);
    const journal = new FilePublicationJournal(join(temporaryRoot, "publication-state.json"));
    const publishDependencies = {
      baseUrl: new URL(baseUrl),
      workspaceRoots: [temporaryRoot],
      openDevelopment: true as const,
      journal,
    };
    const htmlPublished = await publishArtifact(
      { path: htmlPath, expiresInSeconds: 900 },
      publishDependencies,
    );
    const pdfPublished = await publishArtifact(
      { path: pdfPath, expiresInSeconds: 900 },
      publishDependencies,
    );
    const artifacts: readonly PublishedArtifact[] = [
      { bytes: markdownBytes, mimeType: "text/markdown", shareUrl: markdownUrl },
      { bytes: htmlBytes, mimeType: "text/html", shareUrl: htmlPublished.share_url },
      { bytes: pdfBytes, mimeType: "application/pdf", shareUrl: pdfPublished.share_url },
    ];

    for (const artifact of artifacts) await expectExactRepresentations(artifact);

    await page.goto(markdownUrl);
    await expectPage(page.getByRole("heading", { name: "Local lifecycle" })).toBeVisible();
    expect(await page.locator("script").count()).toBe(1);
    expect(await page.locator('img[src^="https://leak.invalid"]').count()).toBe(0);
    expect(await page.locator("body").getAttribute("data-executed")).toBeNull();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await page.goto(htmlPublished.share_url);
    await expectPage(page.locator('iframe[title="Sanitized HTML preview"]')).toHaveAttribute("sandbox", "");
    await expectPage(
      page.frameLocator('iframe[title="Sanitized HTML preview"]').getByRole("heading", {
        name: "Contained HTML",
      }),
    ).toBeVisible();
    expect(await page.locator("body").getAttribute("data-executed")).toBeNull();
    expect(externalRequests).toEqual([]);
    await page.goto(pdfPublished.share_url);
    await expectPage(page.locator('iframe[title="PDF preview"]')).toHaveAttribute(
      "src",
      `${new URL(pdfPublished.share_url).pathname}/content`,
    );
    const pdfAgentRead = await readArtifact({ shareUrl: pdfPublished.share_url }, {
      baseUrl: new URL(baseUrl),
      openDevelopment: true,
    });
    expect(pdfAgentRead.representation).toBe("derived");
    expect(pdfAgentRead.text).toContain("Agent readable PDF lifecycle");

    await stopDemo();
    await startDemo();
    await control("time", { now_ms: fixedNow + 899_999 });
    for (const artifact of artifacts) await expectExactRepresentations(artifact);

    await control("time", { now_ms: fixedNow + 900_000 });
    for (const artifact of artifacts) {
      const suffixes = artifact.mimeType === "application/pdf"
        ? ["", "/manifest", "/source", "/raw", "/content", "/derived"]
        : ["", "/manifest", "/source", "/raw"];
      for (const suffix of suffixes) {
        expect((await fetch(`${artifact.shareUrl}${suffix}`)).status, `${artifact.mimeType}${suffix}`).toBe(404);
      }
    }

    const firstCleanup = await control<CleanupResult>("cleanup");
    expect(firstCleanup).toMatchObject({ scanned: 3, deleted: 3, failed: 0, rows: 0, objects: 0 });
    const secondCleanup = await control<CleanupResult>("cleanup");
    expect(secondCleanup).toEqual({ scanned: 0, deleted: 0, failed: 0, rows: 0, objects: 0 });
  }, 120_000);
});
