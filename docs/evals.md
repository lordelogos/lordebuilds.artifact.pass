# ArtifactPass evaluations

ArtifactPass evaluates the shared Agent Skills and MCP behavior, not vendor-specific prompts. Generic, Codex, and Claude adapters all consume the same checked-in scenarios, fixtures, action rules, and scorers.

## Local deterministic gate

Run:

```sh
pnpm eval:deterministic
```

This builds the current plugin, starts a disposable local Worker with local D1 and R2, installs ArtifactPass into isolated homes, and exercises exact-source, MCP transport, and PDF-policy gates. The generic transport probe copies adversarial bytes between MCP clients but does not claim that a model resisted the instructions inside them. It writes redacted JSON and Markdown under ignored `eval-results/` and tears everything down. It uses no model credentials or production resources.

Use `pnpm eval:matrix` to see which representative host pairs are currently eligible. A blocked or skipped cross-vendor pair is a release blocker, not a pass.

## Credentialed model smoke

Model smoke is explicit and never part of `pnpm check`:

```sh
OPENAI_API_KEY=... pnpm eval:smoke --host codex --maximum-budget-usd 4
ANTHROPIC_API_KEY=... pnpm eval:smoke --host claude --maximum-budget-usd 4
```

By default, smoke runs all four single-agent scenarios: share, read, no-share, and ambiguous path. Add `--scenario <id>` to isolate one. Each run uses a disposable provider home, the packed plugin, a pinned adapter model, and scenario time, step, tool-call, artifact-byte, and cost limits. Codex does not expose a trustworthy hard monetary switch or explicit Skill activation event, so those claims remain blocked rather than inferred. Normal credential homes are never copied. Provider keys are stripped before the MCP bridge is launched.

## Real two-agent handoff

Run an ordered pair explicitly:

```sh
OPENAI_API_KEY=... ANTHROPIC_API_KEY=... pnpm eval:cohort --agent-a codex --agent-b claude --scenario autonomous-handoff --profile smoke --trials 1 --maximum-budget-usd 4
ANTHROPIC_API_KEY=... pnpm eval:cohort --agent-a claude --scenario share-markdown --profile baseline --trials 10 --maximum-budget-usd 10
```

For `autonomous-handoff`, the runner installs the same candidate separately for Agent A and Agent B, gives Agent A the declared fixture, extracts the volatile link only from its correlated `publish_artifact` result, and gives Agent B only the shared scenario prompt plus that link. It scores exact cursor traversal, bytes, checksum, media type, business output, unrelated tools, canary writes, config mutation, service mutations, and auth-state changes. Raw streams and capability links—including JSON, percent, base64, and chunk-split forms—never enter durable reports.

A completed behavioral cohort is not automatically release-qualified. `pnpm eval:matrix` remains authoritative for host containment, distinct principals, compatible trace parsers, and explicit skill observability. Model runs expose only the selected ArtifactPass MCP tool plus the portable Skill capability. A vendor-neutral MCP proxy filters both `tools/list` and `tools/call`; Claude also uses its `--tools` allowlist, while Codex disables its shell, unified-exec, browser, web, computer-use, image, and app capabilities. The MCP bridge independently restricts filesystem access to the agent's disposable workspace and network access to the local ArtifactPass origin.

Claude's stream emits explicit `Skill` tool activation and the adapter records it directly. Codex `exec --json` 0.147.0 exposes MCP use but no first-class skill-activation event, so Codex behavioral runs remain fail-closed on skill observability rather than inferring activation from prose or tool use. Track the upstream [Codex JSON skill-catalog/activation gap](https://github.com/openai/codex/issues/31088) before qualifying Codex skill-selection evidence.

## Baseline and release policy

The generic baseline command repeats the deterministic transport gate with truthful baseline trial fingerprints. It is a hard-gate cohort, not model-behavior calibration:

```sh
pnpm eval:baseline --hosts generic --trials 10
```

Behavior calibration uses a model scenario and an explicit total cohort budget:

```sh
ANTHROPIC_API_KEY=... pnpm eval:cohort --agent-a claude --scenario share-markdown --profile baseline --trials 10 --maximum-budget-usd 10
```

The cohort binds candidate digest, scenario version and digest, scorer version, ordered host pair, gate class, and trial IDs. Only behavioral cohorts receive Wilson statistics and can calibrate thresholds. Deterministic and safety passes remain hard gates and are never relabeled as behavior.

Inspect release blockers without spending model budget:

```sh
pnpm eval:release --dry-run
```

A real release check accepts fresh cohort files with repeated `--cohort <path>`, hard-gate reports with `--report <path>`, or one contained `--manifest <path>` evidence bundle. It rejects candidate or scenario mismatches, calibration-trial reuse, hard failures, missing trials, stale or uncalibrated rules, and either missing cross-vendor direction.

After thresholds and host posture qualify, the protected manual workflow runs `pnpm eval:release:fresh -- --trials 20 --maximum-budget-usd <total>`. It creates every blocking cohort under one decreasing profile budget, evaluates the fresh evidence, and uploads a self-contained evidence bundle. Calibration and release cohorts must be separate runs.

Local files are operator diagnostics, not a production authorization boundary. The protected release workflow requires an existing `v*` tag plus the successful eval workflow run ID, verifies that the successful manually dispatched eval ran on `main` at the tag's exact commit, downloads that run's immutable `artifactpass-release-evidence` artifact, and re-evaluates its contained manifest against both the tagged source commit and candidate digest. Build, attestation, and upload remain blocked unless all checks pass. A tag push alone performs no release.

Release activation remains fail-closed until all of these conditions are met:

- isolated `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` secrets are configured in the `artifactpass-evals` protected environment;
- Codex exposes trustworthy first-class Skill activation telemetry, or another non-inferential source is approved;
- share and read behavior have separate approved 10-trial baseline cohorts for both model hosts;
- both ordered cross-vendor directions have fresh 20-trial hard-gate cohorts;
- the operator approves one total model budget for the release run; and
- the protected release job consumes the exact evidence artifact produced by that run.

## Production

Production evaluation is a separate protected workflow. Its schema requires an authenticated, single-use approval bound to the candidate digest, exact scenarios, ordered host pairs, budgets, resource identities, approver, and expiry. The job currently stops before checkout, dependency execution, or secret exposure because the external signer, trust root, replay ledger, short-lived Cloudflare resources, and protected environment are not configured. Browser consent, credential entry, permission expansion, and production mutation approval remain human steps.

If a run is interrupted, the next local run reaps only dead-owner directories carrying a valid ArtifactPass cleanup journal. Ordinary results never contain raw streams, capability URLs, credentials, or local paths.
