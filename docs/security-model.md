# Security model

ArtifactPass protects upload authority and artifact confidentiality differently.

## Trust boundaries

- On public ArtifactPass, `/upload*` and `/connect/approve*` require an ArtifactPass browser session created after Google or GitHub sign-in. On a private deployment, Cloudflare Access authenticates the person and the Worker accepts only the asserted Access identity at those routes. Human uploads also require a matching same-origin request.
- `/api/artifacts` accepts a scoped, revocable agent token. The browser upload route accepts the signed-in human session.
- `/a/<token>*` is intentionally public. Its high-entropy token is the only read credential and expires with the artifact.
- D1 and R2 are private Worker bindings. Only token hashes are stored in D1.
- Browser session tokens and OAuth state are stored only as hashes in D1 and expire automatically. A short-lived HttpOnly cookie binds each OAuth callback to the browser that started it. Google and GitHub access tokens are used only to fetch the verified identity during callback and are not stored.
- Agent tokens and private device keys live in separate per-profile accounts in macOS Keychain or Linux Secret Service. The local JSON file contains only profile names, origins, absolute approved workspace roots, and non-secret key IDs. Private deployments bind each token and public key to one origin, agent, and workspace approval.

Treat every share URL like a temporary secret. Do not post it in public logs, issues, analytics, or durable chat transcripts.

## Content isolation

Markdown is parsed and sanitized before rendering. HTML previewing uses a separate neutralized copy: scripts and executable embeds are removed, navigation and external-resource attributes are stripped, refresh metadata is removed, forms and controls are disabled, and external CSS resources are removed. That copy is served inside a sandboxed iframe with no permissions and a deny-by-default Content Security Policy. The Source view and exact-file download retain the original bytes rather than rewriting the durable artifact. PDF preview is distinct from the agent-readable representation: controlled PDFs expose their signed canonical source, while human and unknown PDFs expose no extracted content to agents. User filenames become metadata only and may not contain path separators or NUL bytes.

The agent bridge resolves real paths and only opens regular files inside explicitly configured workspace roots. It rejects symlink escapes, unsupported extensions, invalid UTF-8, mismatched PDFs, changed-during-read files, oversized files, redirects, foreign origins, malformed cursors, and inconsistent source metadata. Automatic PDF publication also fails closed when images, vector rendering, custom or Type3 fonts, attachments, scripts, or extraction failures prevent the scanner from covering the rendered content; deliberate browser uploads retain broader PDF support.

## Tokens and logging

Share tokens, browser session tokens, OAuth state, device codes, and agent tokens are generated from cryptographically secure random bytes. Agent tokens are hashed at rest, scoped to artifact creation, expire, and can be revoked. Share tokens are accepted only in the requested share URL and are redacted from bridge and setup errors. Cloudflare deployment credentials and Google/GitHub client secrets are read only by the release operator, passed to Cloudflare as Worker secrets, and never written to generated configuration.

Production logs must exclude authorization headers, URL paths containing share tokens, form bodies, artifact bytes, extracted text, and credential-store output. Run `pnpm security:secrets` before every release.

## Expiry and deletion

Authorization checks use `now < expires_at`; at the exact cutoff every representation is unreachable and non-cacheable. Cleanup records a retryable state, removes source and derived R2 objects, then deletes metadata. An R2 lifecycle removes orphaned `artifacts/` objects after two days.

## Known limits

- Anyone who obtains a live share URL can read and redistribute its artifact.
- Revoking an agent token stops future uploads but cannot retract already shared bytes before their selected expiry.
- Human and unknown PDFs are intentionally human-only in this release; there is no click-through agent trust override.
- macOS and Linux credential stores are supported in v1. Windows connection is not yet supported.
- Lorde Builds Cloudflare administrators remain able to access the public deployment's infrastructure. In private mode, the customer owns and administers the Cloudflare account and can access its infrastructure. ArtifactPass does not claim protection from that account's administrators.
- HTML preview isolation ultimately depends on the browser engine correctly enforcing its sandbox and Content Security Policy. ArtifactPass removes active content first and tests the browser boundary, but cannot eliminate browser-engine vulnerabilities.

Report vulnerabilities as described in [SECURITY.md](../SECURITY.md).
