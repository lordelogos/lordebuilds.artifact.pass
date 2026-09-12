import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { auditSurfacePaths, auditSurfaceText } from "./github-surface-audit-core.mjs";

const options = { repository: undefined, reportPath: undefined };
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === "--repository") options.repository = process.argv[++index];
  else if (argument === "--report") options.reportPath = process.argv[++index];
  else throw new Error(`GitHub surface audit: unknown option ${argument}`);
}
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(options.repository ?? "")) {
  throw new Error("GitHub surface audit: --repository must be OWNER/REPOSITORY");
}
if (!options.reportPath) throw new Error("GitHub surface audit: --report is required");

const gh = (arguments_, extra = {}) => execFileSync("gh", arguments_, {
  encoding: "utf8",
  maxBuffer: 256 * 1024 * 1024,
  ...extra,
});
const apiJson = (endpoint, optional = false) => {
  const result = spawnSync("gh", ["api", endpoint], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    if (optional && /HTTP (403|404)/u.test(result.stderr)) return null;
    throw new Error(`GitHub surface audit: ${endpoint} failed`);
  }
  return JSON.parse(result.stdout);
};
const apiPages = (endpoint, key) => {
  const pages = JSON.parse(gh(["api", "--paginate", "--slurp", endpoint]));
  return pages.flatMap((page) => Array.isArray(page) ? page : (page[key] ?? []));
};
const downloadApi = (endpoint) => {
  const result = spawnSync("gh", ["api", endpoint], {
    maxBuffer: 256 * 1024 * 1024,
  });
  return result.status === 0 ? result.stdout : null;
};

const repository = options.repository;
const root = `repos/${repository}`;
const temporaryRoot = await mkdtemp(join(tmpdir(), "artifactpass-github-audit-"));
const textRecords = [];
const pathRecords = [];
const findings = [];
const warnings = [];
let binaryArchiveEntries = 0;
let archiveSequence = 0;

const addText = (surface, identity, ...values) => {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      textRecords.push({ surface, identity, text: value });
    }
  }
};
const addPath = (surface, identity, path) => {
  if (typeof path === "string" && path.length > 0) pathRecords.push({ surface, identity, path });
};
const scanArchive = async (surface, identity, bytes, depth = 0) => {
  if (depth > 3) {
    binaryArchiveEntries += 1;
    return;
  }
  archiveSequence += 1;
  const archivePath = join(
    temporaryRoot,
    `${archiveSequence}-${surface}-${identity}.archive`.replaceAll(/[^A-Za-z0-9_.-]/gu, "-"),
  );
  await writeFile(archivePath, bytes, { mode: 0o600 });
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  const isGzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
  const listing = isZip
    ? spawnSync("unzip", ["-Z1", archivePath], { encoding: "utf8" })
    : isGzip
      ? spawnSync("tar", ["-tzf", archivePath], { encoding: "utf8" })
      : { status: 1, stdout: "" };
  if (listing.status !== 0) {
    if (!bytes.includes(0)) addText(surface, identity, bytes.toString("utf8"));
    else binaryArchiveEntries += 1;
    return;
  }
  const entries = listing.stdout.split("\n").filter((entry) => entry && !entry.endsWith("/"));
  for (const entry of entries) addPath(surface, identity, entry);
  for (const entry of entries) {
    const expanded = execFileSync(isZip ? "unzip" : "tar", isZip
      ? ["-p", archivePath, entry]
      : ["-xOzf", archivePath, entry], {
      maxBuffer: 256 * 1024 * 1024,
    });
    const nestedArchive = (expanded[0] === 0x50 && expanded[1] === 0x4b)
      || (expanded[0] === 0x1f && expanded[1] === 0x8b);
    if (nestedArchive) await scanArchive(surface, `${identity}:${entry}`, expanded, depth + 1);
    else if (expanded.includes(0)) binaryArchiveEntries += 1;
    else addText(surface, `${identity}:${entry}`, expanded.toString("utf8"));
  }
};

try {
  const repositorySettings = apiJson(root);
  const actionsPermissions = apiJson(`${root}/actions/permissions`);
  const workflowPermissions = apiJson(`${root}/actions/permissions/workflow`);
  const environmentsResponse = apiJson(`${root}/environments`);
  const deployKeys = apiJson(`${root}/keys`);
  const hooks = apiJson(`${root}/hooks`);
  const collaborators = apiJson(`${root}/collaborators`);
  const rulesets = apiJson(`${root}/rulesets`, true);
  const branchProtection = apiJson(`${root}/branches/main/protection`, true);
  const repositoryVariables = apiJson(`${root}/actions/variables`, true);

  addText("repository", repository, repositorySettings.description, repositorySettings.homepage);
  for (const hook of hooks) addText("webhook", hook.id, JSON.stringify(hook.config ?? {}));
  for (const variable of repositoryVariables?.variables ?? []) {
    addText("repository-variable", variable.name, variable.name, variable.value);
  }

  const environments = environmentsResponse.environments ?? [];
  const environmentDetails = [];
  for (const environment of environments) {
    const detail = apiJson(`${root}/environments/${encodeURIComponent(environment.name)}`);
    const secrets = apiJson(`${root}/environments/${encodeURIComponent(environment.name)}/secrets`, true);
    const variables = apiJson(`${root}/environments/${encodeURIComponent(environment.name)}/variables`, true);
    for (const variable of variables?.variables ?? []) {
      addText("environment-variable", `${environment.name}:${variable.name}`, variable.name, variable.value);
    }
    environmentDetails.push({
      name: environment.name,
      protection_rules: detail.protection_rules ?? [],
      can_admins_bypass: detail.can_admins_bypass,
      deployment_branch_policy: detail.deployment_branch_policy,
      secret_names: (secrets?.secrets ?? []).map(({ name }) => name).sort(),
      variable_names: (variables?.variables ?? []).map(({ name }) => name).sort(),
    });
  }

  const issues = apiPages(`${root}/issues?state=all&per_page=100`, "items");
  for (const issue of issues) addText(issue.pull_request ? "pull-request" : "issue", issue.number, issue.title, issue.body);
  const issueComments = apiPages(`${root}/issues/comments?per_page=100`, "items");
  for (const comment of issueComments) addText("issue-comment", comment.id, comment.body);
  const reviewComments = apiPages(`${root}/pulls/comments?per_page=100`, "items");
  for (const comment of reviewComments) {
    addText("pull-review-comment", comment.id, comment.body);
    addPath("pull-review-comment", comment.id, comment.path);
  }
  const commitComments = apiPages(`${root}/comments?per_page=100`, "items");
  for (const comment of commitComments) {
    addText("commit-comment", comment.id, comment.body);
    addPath("commit-comment", comment.id, comment.path);
  }
  const pullReviews = [];
  for (const issue of issues.filter(({ pull_request: pullRequest }) => pullRequest)) {
    pullReviews.push(...apiPages(`${root}/pulls/${issue.number}/reviews?per_page=100`, "items"));
  }
  for (const review of pullReviews) addText("pull-review", review.id, review.body);

  const releases = apiPages(`${root}/releases?per_page=100`, "items");
  let releaseAssets = 0;
  for (const release of releases) {
    addText("release", release.id, release.name, release.body, release.tag_name);
    for (const asset of release.assets ?? []) {
      releaseAssets += 1;
      addPath("release-asset", asset.id, asset.name);
      const bytes = downloadApi(`${root}/releases/assets/${asset.id}`);
      if (bytes) await scanArchive("release-asset", asset.id, bytes);
      else warnings.push(`release asset ${asset.id} is no longer downloadable`);
    }
  }

  const artifacts = apiPages(`${root}/actions/artifacts?per_page=100`, "artifacts");
  let auditedArtifacts = 0;
  for (const artifact of artifacts) {
    addPath("actions-artifact", artifact.id, artifact.name);
    if (artifact.expired) continue;
    const bytes = downloadApi(`${root}/actions/artifacts/${artifact.id}/zip`);
    if (bytes) {
      auditedArtifacts += 1;
      await scanArchive("actions-artifact", artifact.id, bytes);
    } else {
      findings.push({
        surface: "actions-artifact",
        identity: String(artifact.id),
        label: "active artifact could not be audited",
      });
    }
  }

  const runs = apiPages(`${root}/actions/runs?per_page=100`, "workflow_runs");
  let auditedLogs = 0;
  let unavailableLogs = 0;
  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index];
    addText("actions-run", run.id, run.name, run.display_title, run.head_branch);
    const bytes = downloadApi(`${root}/actions/runs/${run.id}/logs`);
    if (bytes) {
      auditedLogs += 1;
      await scanArchive("actions-log", run.id, bytes);
    } else {
      unavailableLogs += 1;
    }
    if ((index + 1) % 25 === 0) process.stdout.write(`Audited ${index + 1}/${runs.length} Actions runs.\n`);
  }
  if (unavailableLogs > 0) {
    warnings.push(`${unavailableLogs} expired or unavailable Actions log archives are no longer exposed`);
  }

  const lfs = spawnSync("git", ["lfs", "ls-files", "--all", "-n"], {
    cwd: resolve(new URL("..", import.meta.url).pathname),
    encoding: "utf8",
  });
  const lfsPaths = lfs.status === 0 ? lfs.stdout.split("\n").filter(Boolean) : [];
  for (const path of lfsPaths) addPath("git-lfs", path, path);
  if (lfsPaths.length > 0) {
    findings.push({ surface: "git-lfs", identity: "repository", label: "LFS objects require a separate content audit" });
  }
  if (repositorySettings.has_wiki) {
    findings.push({ surface: "wiki", identity: "repository", label: "wiki is enabled and requires a separate history audit" });
  }
  if (actionsPermissions.sha_pinning_required !== true) {
    findings.push({ surface: "repository-setting", identity: "actions", label: "full-SHA action pinning is not enforced" });
  }
  if (workflowPermissions.default_workflow_permissions !== "read") {
    findings.push({ surface: "repository-setting", identity: "actions", label: "default workflow permissions are not read-only" });
  }

  findings.push(...auditSurfaceText(textRecords), ...auditSurfacePaths(pathRecords));
  if (binaryArchiveEntries > 0) {
    findings.push({
      surface: "archive",
      identity: "repository",
      label: `${binaryArchiveEntries} archive payloads contained binary content requiring manual review`,
    });
  }

  const report = {
    report_version: 1,
    status: findings.length === 0 ? "pass" : "fail",
    repository,
    repository_settings: {
      visibility: repositorySettings.visibility,
      default_branch: repositorySettings.default_branch,
      issues_enabled: repositorySettings.has_issues,
      wiki_enabled: repositorySettings.has_wiki,
      discussions_enabled: repositorySettings.has_discussions,
    },
    actions_permissions: actionsPermissions,
    workflow_permissions: workflowPermissions,
    environments: environmentDetails,
    protection: {
      rulesets_available: rulesets !== null,
      ruleset_count: rulesets?.length ?? 0,
      main_branch_protection_available: branchProtection !== null,
    },
    counts: {
      collaborators: collaborators.length,
      deploy_keys: deployKeys.length,
      webhooks: hooks.length,
      issues_and_pull_requests: issues.length,
      issue_comments: issueComments.length,
      pull_review_comments: reviewComments.length,
      pull_reviews: pullReviews.length,
      commit_comments: commitComments.length,
      releases: releases.length,
      release_assets: releaseAssets,
      actions_runs: runs.length,
      audited_actions_logs: auditedLogs,
      unavailable_actions_logs: unavailableLogs,
      actions_artifacts: artifacts.length,
      audited_actions_artifacts: auditedArtifacts,
      lfs_paths: lfsPaths.length,
    },
    warnings,
    findings,
  };
  await writeFile(resolve(options.reportPath), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  if (findings.length > 0) {
    process.stderr.write(`GitHub public-surface audit failed with ${findings.length} finding(s).\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`GitHub public-surface audit passed across ${runs.length} Actions runs.\n`);
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
