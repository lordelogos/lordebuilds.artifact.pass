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

Use a short-lived Cloudflare token with Workers Scripts Write, Workers Routes Write, D1 Write, Workers R2 Storage Write, Zone Read, Access: Apps and Policies Write, and Access: Organizations, Identity Providers, and Groups Read. The Access permissions are temporarily required to identify and remove the old path-scoped Access application after ArtifactPass login is proven healthy.

Load the token and provider secrets without placing their values in shell history. On macOS, the Cloudflare token can come from the Keychain entry created during the earlier setup; the provider prompts remain silent:

```sh
export CLOUDFLARE_API_TOKEN="$(security find-generic-password -w -s artifactpass-cloudflare-api-token -a "$USER")"
read -rs "ARTIFACTPASS_GOOGLE_OAUTH_CLIENT_SECRET?Google OAuth client secret: " && export ARTIFACTPASS_GOOGLE_OAUTH_CLIENT_SECRET && printf '\n'
read -rs "ARTIFACTPASS_GITHUB_OAUTH_CLIENT_SECRET?GitHub OAuth client secret: " && export ARTIFACTPASS_GITHUB_OAUTH_CLIENT_SECRET && printf '\n'
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
  --write-approval-manifest /private/path/artifactpass-public-approval.json
```

Review the manifest, then rerun the same values with `--approve-manifest` pointing to that file. The deployer stops if the Worker bundle, OAuth inputs, or Cloudflare state changed after approval.

The mutation order is deliberate:

1. Reuse or create D1 and R2, then apply migrations and lifecycle policy.
2. Store Google and GitHub client secrets as Cloudflare Worker secrets.
3. Deploy with public expiry limited to 15, 30, or 60 minutes.
4. Verify health says ArtifactPass authentication is fully configured.
5. Verify the sign-in page and both provider redirects.
6. Remove only the matching legacy Cloudflare Access application.
7. Verify anonymous `/upload` now redirects to ArtifactPass sign-in.

If the final upload check fails after removal, the running deploy process recreates the managed legacy Access application and its policies as a containment gate before returning the error. An operator interruption after deletion can still require manual restoration, so watch the command through this final check.

## Public user connection

After deployment, a user installs without authentication:

```sh
pnpm dlx artifactpass
```

They start a new agent session, where ArtifactPass is installed but disconnected. When they ask the agent to share an artifact or say **Connect ArtifactPass**, the plugin opens ArtifactPass sign-in with Google or GitHub. After the person approves the displayed device code, the running plugin stores the scoped ArtifactPass token and becomes connected without another command or restart.

## Organization-owned deployments

Private deployment is a separate guided admin path and does not change the public service. Run `pnpm dlx artifactpass deploy` to create a customer-owned Worker, D1 database, private R2 bucket, Access application, publisher policy, and retention policy. The customer owns the Cloudflare account, domain, identity configuration, logs, and bill. The setup uses Cloudflare OAuth by default, keeps the grant in the OS credential store, and requires a state-bound approval before mutation.

See [private deployment](private-deployment.md) for the exact admin and teammate procedure. Do not reuse public ArtifactPass resources or Google/GitHub OAuth credentials for a private deployment. Browser authentication belongs to that private deployment's Cloudflare Access configuration.
