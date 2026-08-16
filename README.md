# lordebuilds.artifacts.share

An open-source, customer-owned service for temporarily sharing HTML, Markdown, and PDF artifacts between humans and coding agents.

The workspace currently contains one full-stack Cloudflare Worker, a React/Vite web shell, shared protocol schemas, and browser/Node PDF representation adapter boundaries. Storage, upload, and connection behavior are implemented in later product slices.

## Workspace

- `apps/artifact-service`: the single Hono Worker and React client.
- `packages/artifact-protocol`: versioned Zod schemas shared by the Worker, browser, and agent bridge.
- `packages/representation-pipeline`: runtime-neutral PDF representation contracts with injectable browser and Node adapters.
- `tests/fixtures`: exact-source and protocol fixtures shared by later integration suites.

The v1 protocol accepts only `text/html`, `text/markdown`, and `application/pdf`. It caps an artifact at 25 MiB and an exact-source response chunk at 64 KiB. The default expiry policy offers 15 minutes, 30 minutes, 1 hour, 12 hours, and 24 hours with a 24-hour maximum. PDF text is always labeled best-effort or unavailable; uploaded PDF bytes remain authoritative.

## Local development

Requirements:

- Node.js 24 or newer
- pnpm 10.11.0

Install dependencies and start the local Worker:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

The Cloudflare Vite plugin serves the React application and Worker together at `http://127.0.0.1:8787`. Check the Worker at `http://127.0.0.1:8787/health`.

No Cloudflare login or remote resources are required for local development.

## Checks

```sh
pnpm check
```

This runs Oxlint, TypeScript checks for every package, the Vitest workspace (including the local Cloudflare runtime), and both the Worker and web production bundles.

For a focused contract or Worker route change:

```sh
pnpm test:protocol
pnpm test:worker
```

To verify the lockfile and build path used by a clean checkout:

```sh
pnpm install --frozen-lockfile
pnpm check
```
