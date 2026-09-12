import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { findSensitiveContent } from "./security-patterns.mjs";

const repositoryRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

const failUsage = (message) => {
  throw new Error(`Secret scan configuration failed: ${message}`);
};

const options = {
  history: false,
  reportPath: undefined,
  fetchRemote: undefined,
  expectedRemoteClosure: undefined,
};
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === "--history") {
    options.history = true;
  } else if (argument === "--report") {
    options.reportPath = process.argv[++index];
    if (!options.reportPath) failUsage("--report requires a path");
  } else if (argument === "--fetch-remote") {
    options.fetchRemote = process.argv[++index];
    if (!options.fetchRemote) failUsage("--fetch-remote requires a remote name");
  } else if (argument === "--expect-remote-closure") {
    options.expectedRemoteClosure = process.argv[++index];
    if (!/^[0-9a-f]{64}$/u.test(options.expectedRemoteClosure ?? "")) {
      failUsage("--expect-remote-closure requires a SHA-256 digest");
    }
  } else {
    failUsage(`unknown option ${argument}`);
  }
}
if ((options.fetchRemote || options.expectedRemoteClosure) && !options.history) {
  failUsage("remote closure verification requires --history");
}
if (options.fetchRemote && !/^[A-Za-z0-9._-]+$/u.test(options.fetchRemote)) {
  failUsage("remote names may contain only letters, numbers, dots, underscores, and hyphens");
}

const git = (arguments_, extra = {}) => execFileSync("git", arguments_, {
  cwd: repositoryRoot,
  encoding: "utf8",
  maxBuffer: 256 * 1024 * 1024,
  ...extra,
});
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const forbiddenTrackedNames = [
  /(?:^|\/)\.dev\.vars$/u,
  /(?:^|\/)\.env$/u,
  /(?:^|\/)\.env\.(?!example$)[^/]+$/u,
  /(?:^|\/)(?:id_rsa|id_ed25519)$/u,
];
const findings = [];

const isReservedCapabilityFixture = (source, match) => {
  if (match.label !== "ArtifactPass capability URL") return false;
  const candidate = source.slice(match.index).match(
    /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/a\/[A-Za-z0-9_-]{32,256}/u,
  )?.[0];
  if (!candidate) return false;
  return new URL(candidate).hostname.endsWith(".example");
};

const scanBytes = (bytes, location) => {
  if (bytes.includes(0)) return false;
  const source = bytes.toString("utf8");
  for (const match of findSensitiveContent(source)) {
    if (isReservedCapabilityFixture(source, match)) continue;
    const line = source.slice(0, match.index).split("\n").length;
    findings.push(`${location}:${line}: ${match.label}`);
  }
  return true;
};

const trackedFiles = git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
  .split("\0")
  .filter(Boolean);
let currentTextFiles = 0;
for (const file of trackedFiles) {
  if (forbiddenTrackedNames.some((pattern) => pattern.test(file))) {
    findings.push(`${file}: tracked secret-bearing filename`);
    continue;
  }
  if (scanBytes(await readFile(resolve(repositoryRoot, file)), file)) currentTextFiles += 1;
}

let history = {
  enabled: false,
  closure_sha256: sha256(""),
  remote_closure_sha256: null,
  ref_count: 0,
  object_count: 0,
  blob_count: 0,
  text_blob_count: 0,
};
let identityMetadata = [];

if (options.history) {
  if (options.fetchRemote) {
    git([
      "fetch",
      "--force",
      "--prune",
      options.fetchRemote,
      `+refs/*:refs/artifactpass-audit/${options.fetchRemote}/*`,
    ], { stdio: "pipe" });
  }

  const refs = git(["for-each-ref", "--format=%(refname) %(objectname)"])
    .split("\n")
    .filter(Boolean)
    .sort();
  let remoteClosure = null;
  if (options.fetchRemote) {
    const remoteRefs = git(["ls-remote", "--refs", options.fetchRemote])
      .split("\n")
      .filter(Boolean)
      .sort();
    remoteClosure = sha256(`${remoteRefs.join("\n")}\n`);
    if (options.expectedRemoteClosure && remoteClosure !== options.expectedRemoteClosure) {
      findings.push("remote ref closure changed after approval");
    }
  } else if (options.expectedRemoteClosure) {
    failUsage("--expect-remote-closure also requires --fetch-remote");
  }

  const historicPaths = git(["log", "--all", "--pretty=format:", "--name-only", "-z"])
    .split("\0")
    .map((path) => path.trim())
    .filter(Boolean);
  for (const path of new Set(historicPaths)) {
    if (forbiddenTrackedNames.some((pattern) => pattern.test(path))) {
      findings.push(`history:${path}: tracked secret-bearing filename`);
    }
  }

  const objectRows = git(["rev-list", "--objects", "--all"])
    .split("\n")
    .filter(Boolean)
    .map((row) => {
      const separator = row.indexOf(" ");
      return separator === -1
        ? { objectId: row, path: undefined }
        : { objectId: row.slice(0, separator), path: row.slice(separator + 1) };
    });
  const objectIds = objectRows.map(({ objectId }) => objectId);
  const objectPaths = new Map();
  for (const { objectId, path } of objectRows) {
    if (!path) continue;
    const paths = objectPaths.get(objectId) ?? [];
    paths.push(path);
    objectPaths.set(objectId, paths);
  }
  const types = git(
    ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
    { input: `${objectIds.join("\n")}\n` },
  ).split("\n").filter(Boolean);
  const blobIds = types
    .map((row) => row.split(" "))
    .filter(([, type]) => type === "blob")
    .map(([objectId]) => objectId);

  const batch = execFileSync("git", ["cat-file", "--batch"], {
    cwd: repositoryRoot,
    input: `${blobIds.join("\n")}\n`,
    maxBuffer: 256 * 1024 * 1024,
  });
  let offset = 0;
  let textBlobCount = 0;
  while (offset < batch.length) {
    const headerEnd = batch.indexOf(10, offset);
    if (headerEnd === -1) failUsage("git returned an incomplete object header");
    const [objectId, type, sizeText] = batch.subarray(offset, headerEnd).toString("utf8").split(" ");
    if (type !== "blob") failUsage(`expected blob ${objectId}, received ${type}`);
    const size = Number.parseInt(sizeText, 10);
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + size;
    const bytes = batch.subarray(contentStart, contentEnd);
    const location = `history:${objectId}:${objectPaths.get(objectId)?.[0] ?? "<unknown>"}`;
    if (scanBytes(bytes, location)) textBlobCount += 1;
    offset = contentEnd + 1;
  }

  const identities = git(["log", "--all", "--format=%an%x00%ae%x00"])
    .split("\0")
    .map((value) => value.trim());
  const uniqueIdentities = new Map();
  for (let index = 0; index + 1 < identities.length; index += 2) {
    const name = identities[index];
    const email = identities[index + 1];
    if (name && email) uniqueIdentities.set(`${name}\0${email}`, { name, email });
  }
  identityMetadata = [...uniqueIdentities.values()]
    .sort((left, right) => `${left.name}\0${left.email}`.localeCompare(`${right.name}\0${right.email}`));
  history = {
    enabled: true,
    closure_sha256: sha256(`${refs.join("\n")}\n`),
    remote_closure_sha256: remoteClosure,
    ref_count: refs.length,
    object_count: objectRows.length,
    blob_count: blobIds.length,
    text_blob_count: textBlobCount,
  };
}

const report = {
  report_version: 1,
  status: findings.length === 0 ? "pass" : "fail",
  repository_head: git(["rev-parse", "HEAD"]).trim(),
  current: {
    file_count: trackedFiles.length,
    text_file_count: currentTextFiles,
  },
  history,
  identity_metadata: identityMetadata,
  findings,
};
if (options.reportPath) {
  await writeFile(resolve(options.reportPath), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

if (findings.length > 0) {
  process.stderr.write(`Secret scan failed:\n${findings.map((finding) => `- ${finding}`).join("\n")}\n`);
  process.exit(1);
}
const historySummary = options.history
  ? `; ${history.blob_count} reachable blobs across ${history.ref_count} refs`
  : "";
process.stdout.write(`Secret scan passed (${trackedFiles.length} release-candidate files${historySummary}).\n`);
