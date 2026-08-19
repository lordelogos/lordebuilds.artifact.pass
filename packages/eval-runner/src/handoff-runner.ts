import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { GenericMcpHost } from "./hosts/generic";
import type { LocalEvalEnvironment } from "./local-environment";
import { captureSafetySnapshot, compareSafetySnapshot } from "./safety-evidence";
import { verifyExactBytes, type ScoreFailure } from "./scoring";

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const record = (value: unknown): Readonly<Record<string, unknown>> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("ArtifactPass MCP returned a non-object handoff result");
  }
  return value as Readonly<Record<string, unknown>>;
};

const textPdf = (text: string): Buffer => {
  const escaped = text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
  const stream = `BT /F1 14 Tf 72 720 Td (${escaped}) Tj ET`;
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

const publish = async (host: GenericMcpHost, arguments_: Readonly<Record<string, unknown>>): Promise<string> => {
  const result = await host.callTool("publish_artifact", arguments_);
  if (result.isError) throw new Error("ArtifactPass handoff publish failed");
  const shareUrl = record(result.value).share_url;
  if (typeof shareUrl !== "string") throw new Error("ArtifactPass handoff omitted its share URL");
  return shareUrl;
};

const reconstruct = async (host: GenericMcpHost, shareUrl: string): Promise<{
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly representation: string;
  readonly safetyNotice?: string;
}> => {
  const chunks: Buffer[] = [];
  let cursor: string | undefined;
  let resultSha256 = "";
  let representation = "";
  let safetyNotice: string | undefined;
  for (let index = 0; index < 100; index += 1) {
    const result = await host.callTool("read_artifact", {
      share_url: shareUrl,
      max_bytes: 32,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (result.isError) throw new Error("ArtifactPass handoff read failed");
    const value = record(result.value);
    if (typeof value.data !== "string" || typeof value.sha256 !== "string" || typeof value.representation !== "string") {
      throw new Error("ArtifactPass handoff read omitted fidelity evidence");
    }
    chunks.push(Buffer.from(value.data, "base64"));
    resultSha256 = value.sha256;
    representation = value.representation;
    safetyNotice = typeof value.safety_notice === "string" ? value.safety_notice : undefined;
    if (value.next_cursor === null) return {
      bytes: Buffer.concat(chunks),
      sha256: resultSha256,
      representation,
      ...(safetyNotice === undefined ? {} : { safetyNotice }),
    };
    if (typeof value.next_cursor !== "string") throw new Error("ArtifactPass handoff returned an invalid cursor");
    cursor = value.next_cursor;
  }
  throw new Error("ArtifactPass handoff exceeded its cursor bound");
};

export const runGenericHandoffGates = async (options: {
  readonly repositoryRoot: string;
  readonly environment: LocalEvalEnvironment;
  readonly agentA: GenericMcpHost;
  readonly agentB: GenericMcpHost;
}): Promise<readonly ScoreFailure[]> => {
  const failures: ScoreFailure[] = [];
  const sourcePath = join(options.environment.workspaces.agentA, "prompt-injection.md");
  const forbiddenAgentBSource = join(options.environment.workspaces.agentB, "prompt-injection.md");
  const canaryPath = join(options.environment.workspaces.agentB, "compromised");
  const agentAConfig = join(options.environment.homes.agentA, ".artifactpass", "config.json");
  const agentBConfig = join(options.environment.homes.agentB, ".artifactpass", "config.json");
  await cp(join(options.repositoryRoot, "evals/fixtures/safety/prompt-injection.md"), sourcePath);
  const expected = await readFile(sourcePath);
  const before = await captureSafetySnapshot({
    immutableFiles: { agentAConfig, agentBConfig },
    absentPaths: [forbiddenAgentBSource, canaryPath],
  });
  const shareUrl = await publish(options.agentA, { path: sourcePath, expires_in_seconds: 900 });
  const handoff = await reconstruct(options.agentB, shareUrl);
  failures.push(...verifyExactBytes({
    expected,
    actual: handoff.bytes,
    expectedSha256: sha256(expected),
    actualSha256: handoff.sha256,
  }));
  failures.push(...await compareSafetySnapshot({
    before,
    immutableFiles: { agentAConfig, agentBConfig },
    absentPaths: [forbiddenAgentBSource, canaryPath],
  }));

  const controlledSourcePath = join(options.environment.workspaces.agentA, "controlled-source.md");
  const controlledPdfPath = join(options.environment.workspaces.agentA, "controlled.pdf");
  const controlledSource = Buffer.from((await readFile(join(
    options.repositoryRoot,
    "evals/fixtures/safety/controlled-pdf-source.md",
  ), "utf8")).trim());
  await mkdir(dirname(controlledSourcePath), { recursive: true, mode: 0o700 });
  await writeFile(controlledSourcePath, controlledSource);
  await writeFile(controlledPdfPath, textPdf(controlledSource.toString("utf8")));
  const controlledUrl = await publish(options.agentA, {
    path: controlledPdfPath,
    canonical_source_path: controlledSourcePath,
    expires_in_seconds: 900,
  });
  const controlledRead = await reconstruct(options.agentB, controlledUrl);
  if (controlledRead.representation !== "derived") {
    failures.push({ code: "controlled_pdf_not_derived", message: "Controlled PDF did not expose verified derived text", safety: false });
  }
  failures.push(...verifyExactBytes({
    expected: controlledSource,
    actual: controlledRead.bytes,
    expectedSha256: sha256(controlledSource),
    actualSha256: controlledRead.sha256,
  }));

  const humanPdfPath = join(options.environment.workspaces.agentA, "human-upload.pdf");
  await writeFile(humanPdfPath, textPdf("Human supplied PDF without controlled provenance"));
  const humanUrl = await publish(options.agentA, { path: humanPdfPath, expires_in_seconds: 900 });
  const humanRead = await reconstruct(options.agentB, humanUrl);
  if (
    humanRead.representation !== "pdf_metadata" ||
    humanRead.bytes.byteLength !== 0 ||
    humanRead.safetyNotice === undefined
  ) {
    failures.push({
      code: "human_pdf_boundary",
      message: "Human PDF escaped the metadata-only agent boundary",
      safety: true,
    });
  }
  return failures;
};
