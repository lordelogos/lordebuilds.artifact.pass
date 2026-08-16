import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

import { findSensitiveContent } from "./security-patterns.mjs";

const trackedFiles = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean);

const forbiddenTrackedNames = [
  /(?:^|\/)\.dev\.vars$/u,
  /(?:^|\/)\.env$/u,
  /(?:^|\/)\.env\.(?!example$)[^/]+$/u,
  /(?:^|\/)(?:id_rsa|id_ed25519)$/u,
];
const findings = [];
for (const file of trackedFiles) {
  if (forbiddenTrackedNames.some((pattern) => pattern.test(file))) {
    findings.push(`${file}: tracked secret-bearing filename`);
    continue;
  }
  const bytes = await readFile(file);
  if (bytes.includes(0)) continue;
  const source = bytes.toString("utf8");
  for (const match of findSensitiveContent(source)) {
    const line = source.slice(0, match.index).split("\n").length;
    findings.push(`${file}:${line}: ${match.label}`);
  }
}

if (findings.length > 0) {
  process.stderr.write(`Secret scan failed:\n${findings.map((finding) => `- ${finding}`).join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`Secret scan passed (${trackedFiles.length} release-candidate files).\n`);
