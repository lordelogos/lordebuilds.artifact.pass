# ArtifactPass evaluations

ArtifactPass evaluates the shared Agent Skills and MCP behavior, not vendor-specific prompts. Generic, Codex, and Claude adapters all consume the same checked-in scenarios, fixtures, action rules, and scorers.

## Local deterministic gate

Run:

```sh
pnpm eval:deterministic
```

This builds the current plugin, starts a disposable local Worker with local D1 and R2, installs ArtifactPass into isolated homes, exercises exact-source and two-agent handoff gates, writes redacted JSON and Markdown under ignored `eval-results/`, and tears everything down. It uses no model credentials or production resources.

Use `pnpm eval:matrix` to see which representative host pairs are currently eligible. A blocked or skipped cross-vendor pair is a release blocker, not a pass.

## Credentialed model smoke

Model smoke is explicit and never part of `pnpm check`:

```sh
OPENAI_API_KEY=... pnpm eval:smoke --host codex
ANTHROPIC_API_KEY=... pnpm eval:smoke --host claude
```

Each smoke uses a disposable provider home, the real installed plugin, a pinned adapter model, a hard process timeout, and one scenario trial. Claude receives a hard one-dollar CLI budget. Codex cost is reported after execution because its CLI exposes no equivalent hard monetary switch; time and trial limits remain hard. Normal credential homes are never copied. Provider keys are stripped before the MCP bridge is launched.

## Baseline and release policy

Calibrate a feasible cohort with trials that will never be reused as release evidence:

```sh
pnpm eval:baseline --hosts generic --trials 10
```

The cohort report includes observed success and its 95% Wilson interval. Infrastructure, skipped, safety, and teardown outcomes remain separate. Only eligible baseline evidence may calibrate a checked-in threshold.

Inspect release blockers without spending model budget:

```sh
pnpm eval:release --dry-run
```

A real release check accepts fresh cohort files with repeated `--cohort <path>` arguments. It rejects candidate mismatches, calibration-trial reuse, hard failures, missing trials, stale or uncalibrated rules, and either missing cross-vendor direction.

## Production

Production evaluation is a separate protected workflow. It requires an authenticated, single-use approval bound to the candidate digest, exact scenarios, ordered host pairs, budgets, resource identities, approver, and expiry. Browser consent, credential entry, permission expansion, and production mutation approval remain human steps. Pull-request code never receives production credentials.

If a run is interrupted, the next local run reaps only dead-owner directories carrying a valid ArtifactPass cleanup journal. Ordinary results never contain raw streams, capability URLs, credentials, or local paths.
