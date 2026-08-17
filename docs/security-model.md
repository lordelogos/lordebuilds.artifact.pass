# Security model

Artifact Share protects upload authority and artifact confidentiality differently.

## Trust boundaries

- `/upload*` and `/connect/approve*` require the deployment's path-scoped Cloudflare Access application.
- `/api/artifacts` accepts either an Access identity from the same origin or a scoped, revocable agent token.
- `/a/<token>*` is intentionally public. Its high-entropy token is the only read credential and expires with the artifact.
- D1 and R2 are private Worker bindings. Only token hashes are stored in D1.
- Agent tokens live in separate per-profile accounts in macOS Keychain or Linux Secret Service. The local JSON file contains only profile names, origins, absolute approved workspace roots, and non-secret PDF key IDs.

Treat every share URL like a temporary secret. Do not post it in public logs, issues, analytics, or durable chat transcripts.

## Content isolation

Markdown is parsed and sanitized before rendering. HTML is sanitized, placed in a sandboxed iframe with no permissions, and cannot run scripts or make external subresource requests. PDF preview is distinct from the agent-readable representation: controlled PDFs expose their signed canonical source, while human and unknown PDFs expose no extracted content to agents. User filenames become metadata only and may not contain path separators or NUL bytes.

The agent bridge resolves real paths and only opens regular files inside explicitly configured workspace roots. It rejects symlink escapes, unsupported extensions, invalid UTF-8, mismatched PDFs, changed-during-read files, oversized files, redirects, foreign origins, malformed cursors, and inconsistent source metadata. Automatic PDF publication also fails closed when images, vector rendering, custom or Type3 fonts, attachments, scripts, or extraction failures prevent the scanner from covering the rendered content; deliberate browser uploads retain broader PDF support.

## Tokens and logging

Share tokens and agent tokens are generated from cryptographically secure random bytes. Agent tokens are hashed at rest, scoped to artifact creation, expire, and can be revoked. Share tokens are accepted only in the requested share URL and are redacted from bridge and setup errors. Cloudflare OAuth or API tokens are read for deployment only and are never written to generated configuration.

Production logs must exclude authorization headers, URL paths containing share tokens, form bodies, artifact bytes, extracted text, and credential-store output. Run `pnpm security:secrets` before every release.

## Expiry and deletion

Authorization checks use `now < expires_at`; at the exact cutoff every representation is unreachable and non-cacheable. Cleanup records a retryable state, removes source and derived R2 objects, then deletes metadata. An R2 lifecycle removes orphaned `artifacts/` objects after two days.

## Known limits

- Anyone who obtains a live share URL can read and redistribute its artifact.
- Revoking an agent token stops future uploads but cannot retract already shared bytes before their selected expiry.
- Human and unknown PDFs are intentionally human-only in this release; there is no click-through agent trust override.
- macOS and Linux credential stores are supported in v1. Windows connection is not yet supported.
- Cloudflare account administrators remain able to access the deployment's resources.

Report vulnerabilities as described in [SECURITY.md](../SECURITY.md).
