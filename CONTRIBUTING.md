# Contributing

ArtifactPass v1 stays deliberately small: one customer-owned Cloudflare deployment, one temporary URL, and the same artifact for humans, Claude Code, and Codex. Proposals for billing, hosted multi-tenancy, entitlements, dashboards, or artifact history are outside this repository's v1 scope.

## Development

Use Node.js 24 or newer and the pnpm version pinned in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm plugin:build
pnpm check
```

Keep new paths in kebab-case. Preserve protocol compatibility, exact source bytes, truthful PDF labels, token redaction, the workspace-root boundary, and the absence of artifact enumeration. Add the smallest test that proves changed behavior.

Before proposing a release-affecting change, run:

```sh
pnpm release:check
```

Do not use production credentials or real private documents in tests. Never commit `.env`, `.dev.vars`, Access storage state, Cloudflare credentials, agent tokens, share URLs, or generated logs. Use synthetic fixtures and controlled time.

## Pull requests

Explain the user-visible behavior, security-boundary impact, targeted verification, and any migration or rollback requirement. Keep unrelated cleanup separate. If a change touches deployment behavior, attach dry-run evidence; only maintainers with explicit account authorization run live Cloudflare gates.

By contributing, you agree that your contribution is licensed under Apache-2.0.
