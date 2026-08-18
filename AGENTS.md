# Workspace Instructions

## Product identity

- The public product, repository target, package, executable, plugin, marketplace, MCP registration key, and skill namespace are `ArtifactPass` or `artifactpass`.
- Preserve `lordebuilds.artifacts.share` and `lordebuilds-artifacts-share` only where they are stable compatibility, Cloudflare resource, health-service, storage, or signed-protocol identifiers.
- Keep paths inside the repository in kebab-case unless a platform requires another form.
- Do not create vendor-specific product implementations; host adapters register the same portable MCP and Agent Skills bundle.

## Package management

- Use pnpm only for JavaScript and TypeScript package management.
- Keep the root `packageManager` field pinned to the active pnpm version.
- Do not create or keep `package-lock.json`, `yarn.lock`, or Bun lockfiles.

## Phase discipline

- Before implementation, name the phase, its user-visible behavior, and the smallest validation gate.
- Keep Cloudflare account changes, credentials, production resources, and deployments behind explicit user confirmation.
- Never ask for credentials in chat or commit them to the repository.

## Verification gates

- Run `pnpm test:protocol` plus the affected package's `pnpm typecheck` for a shared-contract change.
- Run `pnpm test:worker` for Worker route changes.
- Run `pnpm check` for the local release-equivalent gate: generated plugin freshness, lint, all package typechecks, the Vitest workspace, and production builds.
- Run `pnpm test:browser` for local client behavior; live Access tests skip unless their external credentials are explicitly configured.
- Run `pnpm release:check` once for a release candidate to add secret scanning, dependency/license audits, and clean-package inspection.
- Run `pnpm test:browser:live` only against an explicitly authorized disposable Cloudflare deployment.
- Run `pnpm install --frozen-lockfile` before recording clean-install build evidence.
- For the smallest local startup smoke, run `pnpm dev`, then request both `http://127.0.0.1:8787/` and `http://127.0.0.1:8787/health`.
