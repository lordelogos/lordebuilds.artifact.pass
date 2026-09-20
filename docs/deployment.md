# Deploy public ArtifactPass

This procedure is for the ArtifactPass release operator, not for people installing the plugin. Public users install and connect to `https://artifactpass.com`; they never need a Cloudflare account.

The production service uses one Cloudflare Worker custom domain, one managed D1 database, and one private R2 bucket. Google and GitHub authenticate people in the browser. Scoped ArtifactPass tokens authenticate agent publishing. Temporary `/a/*` URLs remain bearer capabilities.

## Provider applications

Create one Google OAuth web application and one GitHub OAuth application for ArtifactPass:

- Google authorized redirect URI: `https://artifactpass.com/auth/callback/google`
- GitHub callback URL: `https://artifactpass.com/auth/callback/github`
- GitHub homepage URL: `https://artifactpass.com`

Qualify a separate provider pair in staging before creating the production applications. The staging
registration uses `https://staging.artifactpass.com`, with callbacks at
`/auth/callback/google` and `/auth/callback/github`. Its Google branding links are the staging root,
`/privacy`, and `/terms`; all three must resolve to the deployed Worker rather than placeholder pages.
Keep the Google staging application in Testing status and limit it to the release operator's test
account. Do not reuse staging credentials or callback URLs in the production applications.

The client IDs are non-secret deployment inputs. Keep both client secrets in the operator's secret store. Never put them in a repository file, approval manifest, shell history, or chat.

## Cloudflare access

Use a short-lived Cloudflare token with Workers Scripts Write, Workers Routes Write, D1 Write, Workers R2 Storage Write, Zone Read, Access: Apps and Policies Write, and Access: Organizations, Identity Providers, and Groups Read. The Access permissions are required to bind the approval manifest to the existing containment gate. Public activation is a later, separate operation.

Load all three credentials from the operator's secret store without placing their values in shell history. On macOS, the production entries are:

```sh
export CLOUDFLARE_API_TOKEN="$(security find-generic-password -w -s artifactpass-cloudflare-api-token -a "$USER")"
export ARTIFACTPASS_GOOGLE_OAUTH_CLIENT_SECRET="$(security find-generic-password -w -s artifactpass-production-google-client-secret -a "$USER")"
export ARTIFACTPASS_GITHUB_OAUTH_CLIENT_SECRET="$(security find-generic-password -w -s artifactpass-production-github-client-secret -a "$USER")"
```

## State-bound release

Build the reviewed Worker and setup package, then write an approval manifest. The manifest contains hashes of the provider secrets, never their values.

```sh
pnpm install --frozen-lockfile
pnpm --dir packages/setup-cli build
node packages/setup-cli/dist/cli.mjs deploy-public \
  --account-id 0123456789abcdef0123456789abcdef \
  --zone-id fedcba9876543210fedcba9876543210 \
  --hostname artifactpass.com \
  --workers-subdomain artifactpass \
  --pdf-key-id artifactpass-primary \
  --pdf-public-key BASE64_ED25519_PUBLIC_KEY \
  --google-client-id GOOGLE_CLIENT_ID \
  --github-client-id GITHUB_CLIENT_ID \
  --production-existing-resources \
  --write-approval-manifest /private/path/artifactpass-public-approval.json
```

Review the manifest, then rerun the same values with `--approve-manifest` pointing to that file. The deployer stops if the Worker bundle, OAuth inputs, or Cloudflare state changed after approval.

Production existing-resource mode stops before mutation unless the reviewed Worker, D1 UUID, R2 bucket, custom domain, Access application, and migration history still match. It accepts only three reviewed production baselines: no migrations are pending, `0009-cleanup-indexes.sql` alone is pending, or `0007-public-auth.sql` through `0009-cleanup-indexes.sql` are pending. Missing production resources are never created.

The contained mutation order is deliberate:

1. Bind the state-approved configuration to the existing D1 and R2 resources.
2. Apply the pending reviewed migrations and the reviewed R2 lifecycle.
3. Deploy the reviewed Worker and both OAuth secrets in one `wrangler deploy` operation.
4. Verify health and both provider starts.
5. Verify the legacy Access application still contains `/upload`.

The deployer writes OAuth secrets to a mode-0600 temporary file used only by `wrangler deploy`, then removes the entire temporary directory on success or failure. It does not create a separate secret-only Worker deployment. Relaxing Access happens only after the contained production qualification passes.

## Reversible public activation

After the contained production matrix passes, write a separate activation manifest:

```sh
node packages/setup-cli/dist/cli.mjs activate-public \
  --account-id 0123456789abcdef0123456789abcdef \
  --hostname artifactpass.com \
  --write-approval-manifest /private/path/artifactpass-activation-approval.json
```

Review it, then repeat with `--approve-manifest`. Activation adds one narrowly scoped, identifiable Access bypass policy and verifies that anonymous `/upload` reaches ArtifactPass sign-in. If verification fails, the command deletes that policy and confirms containment through its rollback result. Keep the original Access application and policies until the observation window closes.

## Public user connection

After deployment, a user installs without authentication:

```sh
pnpm dlx artifactpass
```

They start a new agent session, where ArtifactPass is installed but disconnected. When they ask the agent to share an artifact or say **Connect ArtifactPass**, the plugin opens ArtifactPass sign-in with Google or GitHub. After the person approves the displayed device code, the running plugin stores the scoped ArtifactPass token and becomes connected without another command or restart.

## Organization-owned deployments

Private deployment is a separate guided admin path and does not change the public service. Run `pnpm dlx artifactpass deploy` to create a customer-owned Worker, D1 database, private R2 bucket, Access application, publisher policy, and retention policy. The customer owns the Cloudflare account, domain, identity configuration, logs, and bill. The setup uses Cloudflare OAuth by default, keeps the grant in the OS credential store, and requires a state-bound approval before mutation.

See [private deployment](private-deployment.md) for the exact admin and teammate procedure. Do not reuse public ArtifactPass resources or Google/GitHub OAuth credentials for a private deployment. Browser authentication belongs to that private deployment's Cloudflare Access configuration.
