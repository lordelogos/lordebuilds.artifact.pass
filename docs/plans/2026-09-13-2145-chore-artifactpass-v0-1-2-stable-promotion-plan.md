---
title: ArtifactPass v0.1.2 Stable Promotion
type: chore
date: 2026-09-13
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
---

# ArtifactPass v0.1.2 Stable Promotion

## Goal Capsule

- **Objective:** Publish the RC4-qualified ArtifactPass release as `0.1.2`, make it the npm `latest` version, and prove an unpinned install resolves to those stable bytes.
- **Scope:** Version metadata and generated artifacts, registry publication, exact-package acceptance, npm tag promotion, and repository cleanup.
- **Out of scope:** New product features, new provider support, a distributed two-PC runner, and private-deployment resource changes.
- **Stop conditions:** Stop before `latest` if the candidate bytes change after publication, any safety or functional gate fails, registry integrity cannot be verified, or the stable tag does not descend from `main`.

## Settled Decisions

- The release version is `0.1.2`. The user directed a full stable promotion ending with npm `latest`, rather than another RC-only checkpoint.
- `0.1.2` is first published under the non-default `candidate` tag. `latest` moves only after the exact published package passes acceptance.
- Published versions are immutable. Any post-publication code change burns `0.1.2` and requires a new version.
- Existing private deployments remain pinned to their deployed version until an administrator reruns the deployment update command.
- This stable cut may change only version metadata and generated artifacts. Any product or runtime correction requires a new RC before stable publication.
- Stable behavioral qualification uses a reviewed RC4-to-stable payload-equivalence proof. The expected version string may change; runtime source, packaged capabilities, and deployment behavior may not.

## Requirements

- R1. Root package, setup CLI, plugin metadata, generated plugin bundle, release note, and release policy identify `0.1.2` consistently.
- R2. The package passes secret scanning, distribution checks, lint, type checking, unit and integration tests, builds, license and dependency audits, release package inspection, and packed-install acceptance.
- R3. The stable tag is immutable, reachable from `main`, and publishes one provenance-bearing npm package under `candidate`.
- R4. Registry metadata, tarball integrity, installed receipt version, public setup, host registration, and the non-mutating private-update review path are tested from the exact `0.1.2` package.
- R5. Any release-blocking defect is fixed and requalified before publication. No test workaround may replace product behavior.
- R6. `latest` is moved to `0.1.2` only after R1-R5 pass, then a clean unpinned install proves it resolves to `0.1.2`.
- R7. The release closes on clean, synchronized `main`, with the release branch and worktree removed when safely merged.
- R8. `artifactpass@0.1.2` is confirmed absent before the release PR and immediately before tagging; the tag must equal the reviewed release commit and fetched `origin/main` tip.

## Implementation Units

### U1. Freeze and prepare the stable candidate

Confirm `0.1.2` is unused. Update every version-bearing source and generated release artifact to `0.1.2`. Add the stable release note and refresh the release-policy digest. Prove that the package payload differs from RC4 only where the exact displayed/package version must change. Run focused setup CLI tests for OAuth grant replacement, resumable private deployment, progress rendering, and exact deployed update commands.

**Gate:** Version agreement and focused release-path tests pass with no uncommitted generated drift.

### U2. Run release qualification

Run `pnpm release:check` and `pnpm test:packed-install`. Review the release diff for correctness, security, maintainability, and test coverage. Apply only release-blocking fixes and rerun the smallest affected gates before rerunning the full release gates once.

**Gate:** Both full commands pass from the same clean commit.

### U3. Publish the stable candidate

Merge the reviewed release PR to `main`, confirm `0.1.2` is still unused, freeze the merged SHA, create tag `v0.1.2` at that exact `origin/main` tip, and let the trusted-publishing workflow publish it under `candidate`. Verify npm version, dist-tag, integrity, provenance, and tarball identity.

**Gate:** `artifactpass@candidate` resolves to `0.1.2`; `latest` still resolves to the previous stable version.

### U4. Accept the exact published package

Download the registry tarball identified by `dist.tarball`, verify its `dist.integrity` and SHA-512 against the locally packed archive, and install that downloaded archive into clean temporary workspaces. Prove the version, CLI prompt, public deployment selection, supported host setup, packed Skill and MCP registration, and the private deployment `auth status`, `doctor`, and resume-to-review-then-cancel paths. Do not deploy or mutate an existing private deployment in this package-only release. Run the applicable browser smoke for the setup surface.

**Gate:** Exact-package acceptance passes. Any product failure blocks promotion.

### U5. Promote and close

Use the maintainer's already-authenticated local npm session to move `latest` to the already-published `0.1.2` package without rebuilding or storing a new automation token. Record the previous `latest` value before mutation so it can be restored if verification fails. Verify `latest`, `candidate`, and exact-version integrity match, then use isolated temporary HOME, XDG, and pnpm store paths with an online registry lookup to prove an unpinned install resolves to `0.1.2`. Record final evidence in the GitHub release or workflow summary, return the repository to synchronized, clean `main`, and remove the merged release branch/worktree.

**Gate:** The default install resolves to `0.1.2`, all registry identities agree, and the local repository is clean.

## Assumptions

- RC4 product behavior and the live public/private deployment flows already accepted by the user are the behavioral baseline.
- GitHub trusted publishing remains authorized for the `artifactpass-release` environment.
- npm trusted publishing can publish `0.1.2` under `candidate`; the authenticated maintainer session confirmed by `pnpm whoami` can promote its dist-tag.
- No 24-hour observation period was requested for this package-only promotion; the production service is already live and this run does not redeploy it.

## Release Evidence

Prepare `docs/releases/v0.1.2.md` before tagging with the planned gates. Record the final commit, tag, workflow run, npm integrity, dist-tags, commands executed, browser result, and deliberate non-mutation of the live private deployment in the GitHub release or workflow summary so the tagged source remains immutable.
