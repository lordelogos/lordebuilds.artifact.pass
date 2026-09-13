# Contributing to ArtifactPass

Contributions are welcome. Please search existing issues before opening a new one and keep pull requests focused.

## Repository

ArtifactPass is a pnpm monorepo and requires Node.js 24 or newer. Use the pnpm version pinned in `package.json`.

## Getting started

```sh
git clone https://github.com/lordelogos/lordebuilds.artifact.pass.git artifactpass
cd artifactpass
pnpm install --frozen-lockfile
pnpm plugin:build
pnpm check
```

## Before committing

1. Follow the existing code style and use kebab-case for new paths.
2. Add or update the smallest test that proves your change.
3. Run `pnpm check`.
4. Run `pnpm release:check` for release, security, deployment, or dependency changes.
5. Never commit credentials, private documents, tokens, share URLs, `.env`, or `.dev.vars` files.

## Pull requests

Explain what changed, why it matters, and how you tested it. Include migration or rollback notes when relevant. Keep unrelated cleanup in a separate pull request.

By contributing, you agree that your contribution is licensed under Apache-2.0.
