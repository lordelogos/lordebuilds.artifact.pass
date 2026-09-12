# Operations

## Health and boundaries

Check the public health route without credentials:

```sh
curl --fail --silent https://artifactpass.com/health
```

The response must identify `lordebuilds.artifacts.share` with status `ok`, `human_auth_mode` set to `artifactpass`, and `authentication_configured` set to `true`. An anonymous request to `/upload` must redirect to `/auth/sign-in`. An anonymous POST to `/api/artifacts` must return 404. There is no list endpoint.

Monitor Worker error rate, D1 failures, R2 failures, provider callback failures, rejected approval attempts, and scheduled cleanup failures. Do not enable request-body logging or record full `/a/` paths. Cleanup runs every minute in batches of 100 and retries records left in `cleanup_pending`.

## Public deployment checklist

1. Confirm the Google and GitHub OAuth applications use the exact callbacks in [deployment](deployment.md).
2. Run `pnpm dlx artifactpass doctor` and a mutation-free `deploy-public --dry-run`.
3. Expose the short-lived Cloudflare token and OAuth client secrets only to the deployment process.
4. Write and review a state-bound approval manifest, then deploy that exact manifest.
5. Confirm the contained deployer verified both provider starts and retained the matching legacy Access application.
6. Confirm `/health` reports ready public auth, the Access gate still contains `/upload`, R2 is private, all nine D1 migrations are applied, the trusted PDF public key is configured, and the R2 lifecycle is present.
7. Install without connecting, then connect fresh Codex and Claude Code workspaces through Google or GitHub approval. Provision the controlled-PDF private key separately into each trusted host's OS credential store; the service distributes only the key ID and public key.
8. Upload Markdown, hostile HTML, a human PDF, and a controlled PDF with its exact canonical source. Verify human PDFs remain human-only and controlled PDFs return only the signed canonical source to agents.
9. Run the live two-agent handoff gate below.
10. Verify exact-cutoff denial in controlled-time tests and observe scheduled cleanup on the disposable deployment.

## Distribution controls

Candidate and release workflows must use the protected `artifactpass-release` GitHub environment. Configure required reviewers for that environment and protect `v*` tags from deletion or force updates. A candidate tag must point to a reviewed commit reachable from `main`.

npm publication uses trusted publishing with an OIDC identity restricted to `.github/workflows/publish-candidate.yml`. Do not create a long-lived npm automation token. Publication explicitly requests npm provenance. The release gate verifies exact RC version agreement, the published CLI entrypoint, the native build allowlist, absence of package install lifecycle scripts, dependency audit and licenses, secret scanning, packed contents, and a clean packed installation. Verify the registry provenance and tarball integrity before running the privileged deployment command.

## Live release gate

Use a disposable 15-minute artifact token. Keep the storage-state file and agent token outside the repository and delete them when the run ends.

```sh
ARTIFACT_SHARE_E2E_BASE_URL=https://artifactpass.com \
ARTIFACT_SHARE_E2E_STORAGE_STATE=/secure/path/artifactpass-storage-state.json \
ARTIFACT_SHARE_E2E_AGENT_TOKEN="$(security find-generic-password -w -s lordebuilds.artifacts.share -a agent-token)" \
pnpm test:browser:live
```

On Linux, retrieve the token through `secret-tool` instead. The two-agent spec disables tracing so a failing request cannot persist its authorization header. Browser tests cover upload, copy, safe rendering, PDF ranges, exact download, and excluded product surfaces.

## Upgrade

Read release notes, run `pnpm dlx artifactpass@<new-version> doctor`, and run a dry-run against the current resource identifiers. Back up D1 before a migration. Deploy the pinned version, verify health and ArtifactPass authentication boundaries, reconnect one disposable host, and run the handoff gate. The deployment command is idempotent and preserves existing D1/R2 resources.

## Rollback

Keep the previous setup package and Worker build available. If the new Worker fails, redeploy the previous pinned package against the same hostname and bindings, then repeat health, authentication, upload, and read checks. Do not reverse D1 migrations in place; releases must keep the prior Worker compatible with newly added schema until the rollback window closes. If a migration is not backward compatible, restore D1 to a new database and explicitly rebind only after validating it.

Disconnect compromised hosts immediately. For a leaked share URL, there is no v1 revocation endpoint; assume the artifact is readable until expiry and rotate the source content elsewhere if necessary.

## Private deployment operations

Use the private doctor before repair or upgrade. It performs read-only Cloudflare and origin checks and does not refresh the stored grant:

```sh
pnpm dlx artifactpass deployment doctor --resume artifacts.example.com
```

`healthy` needs matching local state, active authorization, ready Cloudflare prerequisites, all recorded resources, a protected upload boundary, matching Worker deployment ID and retention policy, successful hosted verification, and a receipt. Any other result prints one next action.

Resume an incomplete or repair-required deployment with the exact pinned package version that owns its state schema. Reusing a resource requires its recorded ID and ownership marker to match. A same-name resource without that proof is a conflict, not an adoption candidate.

The admin setup grant and teammate agent credentials have separate lifecycles. Disconnecting the Cloudflare setup grant does not stop the deployed Worker. Disconnecting a teammate revokes that agent token and device key. Removing Cloudflare Access, D1, R2, or the custom domain outside ArtifactPass creates drift and must be reviewed before repair.

Release qualification for private onboarding is defined in [private deployment qualification](private-deployment-qualification.md). Current-account staging proof must never be reported as the unrelated-account, fresh-domain gate.
