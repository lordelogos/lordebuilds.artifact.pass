# ArtifactPass

Share a local Markdown, HTML, or PDF artifact once, then hand the same temporary HTTPS URL to a person or any compatible AI agent.

Public ArtifactPass runs at `artifactpass.com`. Sign in with Google or GitHub, connect an agent workspace, and create short-lived links without owning a Cloudflare account. Exact source stays in private R2 storage and metadata stays in D1. A share URL is a bearer capability: anyone holding it can read that artifact until its exact expiry time.

## What v1 does

- Uploads one `.md`, `.markdown`, `.html`, `.htm`, or `.pdf` file up to 25 MiB.
- Offers public expiry presets of 15, 30, or 60 minutes.
- Preserves exact source bytes and SHA-256 metadata.
- Renders sanitized Markdown, sandboxes sanitized HTML without permissions, and previews PDFs.
- Gives agents deterministic 64 KiB source chunks so large files can be reconstructed exactly.
- Keeps human and externally sourced PDFs human-only for agents. Controlled PDFs expose only the signed canonical source used to render them.
- Ships one MCP server and one Agent Skills bundle for every compatible agent system. Ecosystem plugins only register that shared package.

There is no dashboard, history, billing, entitlement layer, or artifact listing. Identity exists only to authorize browser uploads and workspace connections.

## Install, then connect

Install from the workspace the agent may share:

```sh
pnpm dlx artifactpass
```

This installs the ArtifactPass plugin, MCP server, and both Agent Skills. It does not open a browser or create a connection.

Connect only when you want that workspace to publish:

```sh
pnpm dlx artifactpass connect
```

The browser opens `artifactpass.com`. Sign in with Google or GitHub and approve the agent code you just requested. The CLI stores only the resulting scoped agent token in the operating-system credential store. Restart the agent session, then ask it to share or read an artifact.

An explicit deployment URL remains available for development and future organization-owned deployments:

```sh
pnpm dlx artifactpass connect https://artifacts.example.com \
  --profile production \
  --workspace-root /absolute/path/to/approved/workspace
```

For any other MCP and Agent Skills compatible system, configure the same package without running a vendor installer:

```sh
pnpm dlx artifactpass connect https://artifacts.example.com \
  --profile production \
  --no-host-install \
  --workspace-root /absolute/path/to/approved/workspace
```

The command prints the MCP configuration and Agent Skills directory to register. This path uses the same bridge and skills as every ecosystem plugin; there is no separate implementation. Organization-owned deployment setup is a later phase and is not part of the public v1 release.

See [agent setup](docs/agent-setup.md) for portable setup, optional ecosystem installers, and revocation.

## Develop and verify

Launch an open development demo with the production upload UI, Worker routes,
and persistent local D1/R2 emulation:

```sh
pnpm demo
```

The command applies local migrations, opens `http://127.0.0.1:8787/upload`, and
prints a second URL for other devices on the same network. Demo artifacts stay
under the ignored `apps/artifact-service/.wrangler/demo-state` directory. Upload and agent routes are
open in this separate development Worker so the complete share/read behavior can
be tested before authentication is configured; the production Worker and its
ArtifactPass authentication boundary are unchanged.

Build the setup CLI, then connect the installed plugin to the open demo without
device authorization or a token:

```sh
pnpm --dir packages/setup-cli build
node packages/setup-cli/dist/cli.mjs connect http://127.0.0.1:8787 \
  --profile local \
  --open-development \
  --workspace-root /absolute/path/to/approved/workspace
```

The explicit flag permits the local HTTP/private origin and stores it as the
`local` profile. Production is stored separately as `production`; connecting or
selecting either profile never deletes the other. Switch the bridge explicitly,
then restart the agent session so it reloads the selected profile:

```sh
node packages/setup-cli/dist/cli.mjs profile list
node packages/setup-cli/dist/cli.mjs profile use local
node packages/setup-cli/dist/cli.mjs profile use production
```

`ARTIFACTPASS_PROFILE=production` selects a profile for one bridge process
without changing the saved active profile. Production continues to require HTTPS
and device authorization.

Use the printed network URL as the `connect` base URL to test from another
machine; ordinary loopback and LAN demo uploads stay open. To expose the running
demo temporarily, install `cloudflared` and explicitly start the guarded Quick
Tunnel in a second terminal:

```sh
pnpm tunnel
```

The helper prints a browser upload-entry URL and one random process-lifetime
upload token. Public artifact reads need no token. Paste the token into the
browser entry page, or pass it to an agent bridge only through its environment:

```sh
export ARTIFACTPASS_BASE_URL=https://generated-name.trycloudflare.com
export ARTIFACTPASS_WORKSPACE_ROOTS=/absolute/path/to/approved/workspace
read -rs ARTIFACTPASS_TOKEN && export ARTIFACTPASS_TOKEN
# Start the compatible agent host from this shell.
```

Do not set `ARTIFACTPASS_OPEN_DEVELOPMENT` for the public HTTPS tunnel and do
not save its token in shared configuration. Ctrl+C stops cloudflared and the
token-validating gateway together. The helper uses a private empty Cloudflare
configuration, so it requires no domain, account, or credentials and does not
read a named-tunnel configuration from your home directory.

For automated verification:

```sh
pnpm install --frozen-lockfile
pnpm plugin:build
pnpm test:network
pnpm test:network:live
pnpm check
pnpm release:check
```

`pnpm test:network` checks the guarded gateway without external services.
`pnpm test:network:live` starts an isolated real local Worker/D1/R2 demo, proves
LAN browser and agent flows, then runs one account-free Quick Tunnel cycle; it
requires `cloudflared` and an active network connection. `pnpm plugin:build`
regenerates the canonical plugin after bridge or skill edits. `pnpm check` then
verifies those generated bytes without repairing them, lints, typechecks, runs
the Worker and package tests, and builds production assets. `pnpm release:check`
adds secret scanning, production dependency vulnerability and license audits,
and clean-package inspection. Live authentication tests require an explicitly configured
disposable deployment; see [operations](docs/operations.md).

## Documentation

- [Architecture](docs/architecture.md)
- [Security model](docs/security-model.md)
- [Deployment](docs/deployment.md)
- [Hosted activation packet](docs/hosted-activation.md)
- [Agent setup](docs/agent-setup.md)
- [Operations, upgrade, and rollback](docs/operations.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

Licensed under Apache-2.0.
