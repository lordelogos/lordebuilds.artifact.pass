# Hosted activation packet

This packet is for the later hosted run. It does not deploy, push, publish, or change repository visibility.

Localhost, LAN testing, and a temporary Cloudflare Quick Tunnel need no domain or Cloudflare credentials. The permanent hosted URL waits until there is an active domain zone in the Cloudflare account. Quick Tunnel URLs are temporary and are not the production hostname.

## Decisions and values

Fill this in before the hosted run:

| Item | Decision or value |
| --- | --- |
| Cloudflare account ID | 32-character account ID: `________________` |
| Domain and zone | Buy or choose a domain, add it to Cloudflare, and wait for the zone to become active |
| Cloudflare zone ID | 32-character ID for that active zone: `________________` |
| Hosted hostname | Recommended: `artifacts.<domain>`: `________________` |
| Uploaders | One or more exact `--allow-email` or `--allow-domain` values: `________________` |
| Zero Trust organization | Must already exist in the same account with an identity provider; team domain is read from Cloudflare |
| Access team domain | Expected after deployment: `https://<team>.cloudflareaccess.com`; the deployer stores it as `ACCESS_TEAM_DOMAIN` |
| Access audience | Created or reused Access application's AUD tag; the deployer stores it as `ACCESS_AUD` |
| DNS | Use a Worker Custom Domain. Cloudflare creates its DNS record and certificate; the chosen hostname must not already have a conflicting CNAME or Worker |
| Repository | Keep `lordelogos/lordebuilds.artifacts.share` **private** until the user explicitly changes that decision |
| Git destination | On approval, push the reviewed branch to the private GitHub repository; do not push during local readiness work |
| Package/release destination | Recommended first release: private GitHub Actions artifacts from a reviewed tag. Do not publish `@artifact-share/setup` to a registry until the user explicitly chooses a registry and visibility |

The deployer uses the canonical name `lordebuilds-artifacts-share` for the Worker, D1 database, R2 bucket, and Access application. The Worker bindings are `ARTIFACT_DB` and `ARTIFACTS`. The Access allow policy is named `Artifact Share uploaders`. R2 remains private. The public surfaces are `/health` and temporary `/a/*` bearer URLs; Access protects `/upload*` and `/connect/approve*`.

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

3. Preview the exact plan with the filled values:

   ```sh
   node packages/setup-cli/dist/cli.mjs deploy \
     --account-id <account-id> \
     --zone-id <zone-id> \
     --hostname <hostname> \
     --allow-email <uploader@example.com> \
     --dry-run
   ```

   Use `--allow-domain <domain>` instead, or repeat either flag, when appropriate. Expected: seven planned actions, an empty changed-resource list, and no credentials or Cloudflare API calls.

4. Stop here. The first approval-gated hosted command is the same command **without** `--dry-run`:

   ```sh
   node packages/setup-cli/dist/cli.mjs deploy \
     --account-id <account-id> \
     --zone-id <zone-id> \
     --hostname <hostname> \
     --allow-email <uploader@example.com>
   ```

   This is the mutation boundary. Before it runs, the user must explicitly approve the values, scopes, identity rule, and hosted deployment, and authenticate Wrangler or provide the short-lived token. It may create or update the named D1, R2, Access, policy, Worker, Custom Domain, migrations, and R2 lifecycle resources.

5. Keep Git and release actions separately approval-gated. After hosted verification, the user chooses whether to push the reviewed branch, merge to private `main`, create a tag, and retain the resulting GitHub Actions artifacts. Package registry publication and public repository visibility are separate decisions and default to **no**.

## Verify

After the live deploy succeeds:

1. `curl --fail --silent https://<hostname>/health` returns service `lordebuilds.artifacts.share` with status `ok`.
2. An anonymous request to `/upload` redirects to Access or returns 401/403.
3. An anonymous `POST /api/artifacts` returns 404; there is no list endpoint.
4. Cloudflare shows one Worker, D1 database, private R2 bucket, Access application/policy, Custom Domain, all D1 migrations, and the R2 lifecycle under the canonical name.
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
