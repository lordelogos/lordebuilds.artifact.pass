# Operations

## Health and boundaries

Check the public health route without credentials:

```sh
curl --fail --silent https://artifacts.example.com/health
```

The response must identify `lordebuilds.artifacts.share` with status `ok`. An anonymous request to `/upload` must redirect to Access or return 401/403. An anonymous POST to `/api/artifacts` must return 404. There is no list endpoint.

Monitor Worker error rate, D1 failures, R2 failures, Access denials, and scheduled cleanup failures. Do not enable request-body logging or record full `/a/` paths. Cleanup runs every minute in batches of 100 and retries records left in `cleanup_pending`.

## Clean-account deployment checklist

1. Create or select an active zone and Zero Trust organization.
2. Run `artifact-share doctor` and a mutation-free `deploy --dry-run`.
3. Authenticate Wrangler using its OS-keychain option or expose a short-lived API token only to the deployment process.
4. Deploy with one or more explicit `--allow-email` or `--allow-domain` rules.
5. Rerun the identical deploy and confirm it reuses resources without duplicates.
6. Confirm `/health` is public, `/upload` is Access-protected, R2 is private, all five D1 migrations are applied, and the R2 lifecycle is present.
7. Connect a fresh Codex host and a fresh Claude Code host through the printed team command.
8. Upload Markdown, hostile HTML, a born-digital PDF, and an image-only PDF; verify safe browser reads and exact downloads.
9. Run the live two-agent handoff gate below.
10. Verify exact-cutoff denial in controlled-time tests and observe scheduled cleanup on the disposable deployment.

## Live release gate

Use a disposable 15-minute artifact token. Keep the storage-state file and agent token outside the repository and delete them when the run ends.

```sh
ARTIFACT_SHARE_E2E_BASE_URL=https://artifacts.example.com \
ARTIFACT_SHARE_E2E_STORAGE_STATE=/secure/path/access-storage-state.json \
ARTIFACT_SHARE_E2E_AGENT_TOKEN="$(security find-generic-password -w -s lordebuilds.artifacts.share -a agent-token)" \
pnpm test:browser:live
```

On Linux, retrieve the token through `secret-tool` instead. The two-agent spec disables tracing so a failing request cannot persist its authorization header. Browser tests cover upload, copy, safe rendering, PDF ranges, exact download, and excluded product surfaces.

## Upgrade

Read release notes, run `pnpm dlx @artifact-share/setup@<new-version> doctor`, and run a dry-run against the current resource identifiers. Back up D1 before a migration. Deploy the pinned version, verify health and Access boundaries, reconnect one disposable host, and run the handoff gate. The deployment command is idempotent and preserves existing D1/R2 resources.

## Rollback

Keep the previous setup package and Worker build available. If the new Worker fails, redeploy the previous pinned package against the same hostname and bindings, then repeat health, Access, upload, and read checks. Do not reverse D1 migrations in place; releases must keep the prior Worker compatible with newly added schema until the rollback window closes. If a migration is not backward compatible, restore D1 to a new database and explicitly rebind only after validating it.

Disconnect compromised hosts immediately. For a leaked share URL, there is no v1 revocation endpoint; assume the artifact is readable until expiry and rotate the source content elsewhere if necessary.
