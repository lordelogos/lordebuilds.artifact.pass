# Deploy ArtifactPass

ArtifactPass runs in your Cloudflare account on one custom hostname. D1 metadata and private R2 objects stay in that account. `/upload` and `/connect/approve` are protected by one Cloudflare Access application; `/api/*` uses a scoped ArtifactPass bearer token; `/a/*` is a temporary capability URL.

## Prerequisites

- Node.js 24 or newer and pnpm.
- An active Cloudflare zone and a configured Zero Trust organization.
- A Cloudflare OAuth login or short-lived API token with: Workers Scripts Write, Workers Routes Write, D1 Write, Workers R2 Storage Write, Zone Read, Access: Apps and Policies Write, and Access: Organizations, Identity Providers, and Groups Read.

For an interactive deployment, keep Wrangler's OAuth credential encrypted with its key in the operating-system keychain:

```sh
pnpm --dir packages/setup-cli exec wrangler login --use-keyring
```

For automation, export a short-lived token only for the deployment shell:

```sh
export CLOUDFLARE_API_TOKEN="your-short-lived-token"
```

The setup CLI retrieves the current OAuth or API token through Wrangler. It does not write it to repository files, generated Worker config, logs, or the local agent configuration.

## Preview the deployment

Dry-run planning performs no Cloudflare mutations and does not require a token:

```sh
pnpm --dir packages/setup-cli build
node packages/setup-cli/dist/cli.mjs deploy \
  --account-id 0123456789abcdef0123456789abcdef \
  --zone-id fedcba9876543210fedcba9876543210 \
  --hostname artifacts.example.com \
  --allow-domain example.com \
  --dry-run
```

Remove `--dry-run` only after approving the hosted run. That is the mutation boundary: the deployer verifies permissions, reuses or creates D1/R2/Access resources, deploys the Worker and custom domain, applies migrations and lifecycle defense-in-depth, and verifies `/health`. Reruns reuse resources with the canonical names and refuse hostname or Access-path collisions.

The complete values, command order, verification, and rollback checklist is in the [hosted activation packet](hosted-activation.md).

## Connect a developer

Run the team command printed by deployment:

```sh
pnpm dlx artifactpass connect https://artifacts.example.com --profile production
```

The command detects Claude Code and Codex, installs the same plugin, opens the Access-protected device approval page, stores the scoped agent token in the production profile's operating-system credential account, and writes only non-secret profile settings locally. The existing local development profile is preserved. A trusted host that creates controlled PDFs must also receive the matching private key through the team's secret manager; it is never downloaded from the service.

To revoke the current agent token and remove it from the credential store:

```sh
pnpm dlx artifactpass disconnect --profile production
```

## Manual fallback

If Access API automation is unavailable, create one self-hosted Access application with destinations `artifacts.example.com/upload*` and `artifacts.example.com/connect/approve*`, add an Allow policy for your uploader identities, and set the Worker variables `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` to that application's issuer and audience. Keep R2 private. Attach the Worker using a Custom Domain, then apply every D1 migration and the bundled R2 lifecycle file.
