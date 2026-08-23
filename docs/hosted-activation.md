# Hosted activation packet

This packet records the completed first hosted run and remains the replay procedure for a future approved deployment. The deployment is live; no Git push, package publication, or repository visibility change was performed.

Localhost, LAN testing, and a temporary Cloudflare Quick Tunnel still need no domain or Cloudflare credentials. The permanent hosted URL is `https://artifactpass.com`; Quick Tunnel URLs remain temporary and are not the production hostname.

## Decisions and values

Approved values for the first private hosted run:

| Item | Decision or value |
| --- | --- |
| Cloudflare account ID | `f6fe4d3cfdb44e35b801c8f62b1bc14c` |
| Domain and zone | `artifactpass.com` — active on Cloudflare |
| Cloudflare zone ID | `cd12a03a0c7d5e311c4d878ef551dbcb` |
| Hosted hostname | `artifactpass.com` |
| Uploaders | `paulehiks@gmail.com` |
| Zero Trust organization | Active in the selected account |
| Access team domain | `https://artifactpass.cloudflareaccess.com` |
| Workers account subdomain | `artifactpass`; initialized only because Cloudflare requires an account subdomain for cron schedules, while this Worker keeps `workers_dev` and preview URLs disabled |
| Access audience | Created or reused Access application's AUD tag; the deployer stores it as `ACCESS_AUD` |
| DNS | Use a Worker Custom Domain. Cloudflare creates its DNS record and certificate; the chosen hostname must not already have a conflicting CNAME or Worker |
| PDF provenance | Key ID `artifactpass-primary`; the deployment copy of the private Ed25519 key is in macOS Keychain service `artifactpass-pdf-signing-key`, the bridge copy is in service `artifactpass` account `pdf-signing-key:artifactpass-primary`, and the public half is in `artifactpass-pdf-public-key` |
| Repository | Keep `lordelogos/artifactpass` **private** until the user explicitly changes that decision |
| Git destination | On approval, push the reviewed branch to the private GitHub repository; do not push during local readiness work |
| Package/release destination | The reviewed package is `artifactpass`. Registry publication remains a separate explicit approval after the local release candidate passes. |

The deployer uses the compatibility name `lordebuilds-artifacts-share` for the Worker, D1 database, R2 bucket, and Access application. The Worker bindings are `ARTIFACT_DB` and `ARTIFACTS`. The existing Access allow policy remains named `Artifact Share uploaders`. These identifiers are deliberately not renamed as a branding side effect. R2 remains private. The public surfaces are `/health` and temporary `/a/*` bearer URLs; Access protects `/upload*` and `/connect/approve*`.

Cloudflare requires an [active zone for a Worker Custom Domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/). A Custom Domain is the right DNS choice because the Worker is the origin. No manual placeholder DNS record is needed.

## API token

Prefer a short-lived token restricted to the selected account and zone. It needs:

- Account: Workers Scripts Write
- Account: D1 Write
- Account: Workers R2 Storage Write
- Account: Access: Apps and Policies Write
- Account: Access: Organizations, Identity Providers, and Groups Read
- Zone: Workers Routes Write
- Zone: Zone Read

Cloudflare's [permission catalog](https://developers.cloudflare.com/fundamentals/api/reference/permissions/) lists these scopes. The organization read scope is required because the deployer reads the Zero Trust team domain from the [Access organization endpoint](https://developers.cloudflare.com/api/resources/zero_trust/subresources/organizations/methods/list/).

Do not paste the token into chat, commit it, or put it in a repository file. Use Wrangler OAuth with the operating-system keychain, or expose a short-lived `CLOUDFLARE_API_TOKEN` only to the deployment shell.

## Command order

Run from the repository root.

1. Local-only build and release checks:

   ```sh
   pnpm install --frozen-lockfile
   pnpm plugin:build
   pnpm release:check
   pnpm test:browser
   pnpm test:local-demo
   pnpm test:agent-hosts
   pnpm release:build
   ```

   Expected: all local gates pass and release archives plus `release/checksums.txt` are created locally. No Cloudflare or Git mutation occurs.

2. Build the deployment CLI:

   ```sh
   pnpm --dir packages/setup-cli build
   ```

   Expected: local files under `packages/setup-cli/dist`; no Cloudflare mutation.

3. Preview the exact plan without credentials or network access:

   ```sh
   node packages/setup-cli/dist/cli.mjs deploy \
     --account-id f6fe4d3cfdb44e35b801c8f62b1bc14c \
     --zone-id cd12a03a0c7d5e311c4d878ef551dbcb \
     --hostname artifactpass.com \
     --workers-subdomain artifactpass \
     --allow-email paulehiks@gmail.com \
     --pdf-key-id artifactpass-primary \
     --pdf-public-key "$(security find-generic-password -w -s artifactpass-pdf-public-key -a "$USER")" \
     --dry-run
   ```

   Use `--allow-domain <domain>` instead, or repeat either flag, when appropriate. Expected: seven planned actions, an empty changed-resource list, and no credentials or Cloudflare API calls.

   For an isolated staging deployment, use `--hostname staging.artifactpass.com --service-name artifactpass-staging --pdf-key-id artifactpass-staging` in every preview, manifest, and approval command. The explicit service name keeps its Worker, D1 database, R2 bucket, and Access application separate from the compatibility-named production resources.

4. Create an authenticated read-only, state-bound approval manifest. This performs API reads only:

   ```sh
   CLOUDFLARE_API_TOKEN="$(security find-generic-password -w -s artifactpass-cloudflare-api-token -a "$USER")" \
   node packages/setup-cli/dist/cli.mjs deploy \
     --account-id f6fe4d3cfdb44e35b801c8f62b1bc14c \
     --zone-id cd12a03a0c7d5e311c4d878ef551dbcb \
     --hostname artifactpass.com \
     --workers-subdomain artifactpass \
     --allow-email paulehiks@gmail.com \
     --pdf-key-id artifactpass-primary \
     --pdf-public-key "$(security find-generic-password -w -s artifactpass-pdf-public-key -a "$USER")" \
     --write-approval-manifest /tmp/artifactpass-hosted-approval.json
   ```

5. The mutation boundary uses that exact manifest. It aborts if the bundle or remote resource state changed:

   ```sh
   CLOUDFLARE_API_TOKEN="$(security find-generic-password -w -s artifactpass-cloudflare-api-token -a "$USER")" \
   node packages/setup-cli/dist/cli.mjs deploy \
     --account-id f6fe4d3cfdb44e35b801c8f62b1bc14c \
     --zone-id cd12a03a0c7d5e311c4d878ef551dbcb \
     --hostname artifactpass.com \
     --workers-subdomain artifactpass \
     --allow-email paulehiks@gmail.com \
     --pdf-key-id artifactpass-primary \
     --pdf-public-key "$(security find-generic-password -w -s artifactpass-pdf-public-key -a "$USER")" \
     --approve-manifest /tmp/artifactpass-hosted-approval.json
   ```

   The user approved these named resources and the private hosted run in this roadmap session. The manifest makes that approval state-specific; any drift stops before mutation.

6. Keep Git and release actions separately approval-gated. After hosted verification, the user chooses whether to push the reviewed branch, merge to private `main`, create a tag, and retain the resulting GitHub Actions artifacts. Package registry publication and public repository visibility are separate decisions and default to **no**.

7. On a trusted agent host, install the controlled-PDF signing key in the bridge's OS credential store before connecting. For this first macOS host, copy the already-created deployment key without printing it:

   ```sh
   security add-generic-password -U \
     -s artifactpass \
     -a pdf-signing-key:artifactpass-primary \
     -w "$(security find-generic-password -w -s artifactpass-pdf-signing-key -a "$USER")"
   ```

   The hosted `/health` response supplies only the non-secret key ID. `connect` records that ID in the local bridge config; the private key stays in Keychain. Other trusted hosts need the same private key transferred through an approved secret manager. Hosts without it can still publish Markdown, HTML, and human-only PDFs, but cannot claim controlled PDF provenance.

## Verify

After the live deploy succeeds:

1. `curl --fail --silent https://<hostname>/health` returns service `lordebuilds.artifacts.share` with status `ok`.
2. An anonymous request to `/upload` redirects to Access or returns 401/403.
3. An anonymous `POST /api/artifacts` returns 404; there is no list endpoint.
4. Cloudflare shows one Worker, D1 database, private R2 bucket, and Access application/policy under the requested service name, plus the requested Custom Domain, all six D1 migrations, and the R2 lifecycle. Production uses the canonical compatibility name; staging uses `artifactpass-staging`.
5. Rerun the identical deployment command. It reuses resources and creates no duplicates.
6. Connect one clean compatible agent using the shared MCP and Agent Skills package, then test Markdown, self-contained HTML, and PDF publish/read handoffs. Codex and Claude Code are representative examples, not separate implementations.
7. Run the live browser gate from [operations](operations.md), then verify expiry denial and scheduled cleanup on the disposable deployment.

## Roll back

If verification fails:

1. Stop new uploads and keep the repository private.
2. Redeploy the previous pinned setup package against the same hostname and bindings.
3. Repeat health, Access, upload, and read checks.
4. Do not reverse D1 migrations in place. If schema recovery is required, restore D1 to a new database, verify it, then rebind deliberately.
5. If this was the first disposable deployment and no artifact must be retained, remove only the resources named in the deploy output after recording what was created. Custom Domain deletion does not automatically remove its generated certificate, so audit the certificate separately.

No hosted rollback action should be automated without a fresh explicit approval and an exact resource inventory.
