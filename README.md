# lordebuilds.artifacts.share

An open-source, customer-owned service for temporarily sharing HTML, Markdown, and PDF artifacts between humans and coding agents.

## Local development

Requirements:

- Node.js 24 or newer
- pnpm 10.11.0

Install dependencies and start the local Worker:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Wrangler serves the Worker at `http://localhost:8787`. Check its health at `http://localhost:8787/health`.

No Cloudflare login or remote resources are required for local development.

## Checks

```sh
pnpm check
```

The initial check type-checks the Worker and runs its focused health-route test inside the Cloudflare Workers runtime.
