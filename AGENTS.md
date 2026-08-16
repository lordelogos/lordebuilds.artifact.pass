# Workspace Instructions

## Product identity

- The repository and project name is exactly `lordebuilds.artifacts.share`.
- Keep paths inside the repository in kebab-case unless a platform requires another form.
- Treat package names, plugin identifiers, CLI names, and public branding as separate decisions; do not infer them from the repository name.

## Package management

- Use pnpm only for JavaScript and TypeScript package management.
- Keep the root `packageManager` field pinned to the active pnpm version.
- Do not create or keep `package-lock.json`, `yarn.lock`, or Bun lockfiles.

## Phase discipline

- Before implementation, name the phase, its user-visible behavior, and the smallest validation gate.
- Keep Cloudflare account changes, credentials, production resources, and deployments behind explicit user confirmation.
- Never ask for credentials in chat or commit them to the repository.
