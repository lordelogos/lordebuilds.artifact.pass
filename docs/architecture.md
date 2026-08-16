# Architecture

Artifact Share is a customer-owned Cloudflare Worker plus a local agent bridge. There is no hosted control plane.

```text
authorized human ──Access──> /upload, /connect/approve
                                │
local AI agent ────agent token─┤ Worker ──> D1 metadata
                                │        └─> private R2 exact bytes
person or agent ─share token──> /a/<opaque-token>/*
```

## Components

| Component | Responsibility |
| --- | --- |
| `apps/artifact-service` | Worker routes, React upload/viewer assets, D1 metadata, R2 objects, Access and agent authorization, expiry cleanup |
| `packages/artifact-protocol` | Versioned manifests, limits, errors, source chunk contract |
| `packages/representation-pipeline` | Browser and Node PDF extraction with truthful quality metadata |
| `packages/agent-bridge` | MCP tools, approved-root file reads, exact upload/read, keychain credential resolution, redacted logging |
| `packages/setup-cli` | Idempotent Cloudflare deployment, device connection, plugin installation, disconnect |
| `plugins/artifact-share` | One portable MCP and Agent Skills bundle; ecosystem manifests are thin registration adapters |

## Data flow

An uploader sends multipart source bytes and an expiry choice. For PDFs, any extracted text is stored as a separate derived representation. D1 records hashes, object keys, content metadata, expiry, and hashed bearer tokens. R2 stores exact source and optional derived bytes privately.

The service returns a random URL under `/a/`. Public readers may fetch only the named artifact representations. They cannot list artifacts or create new ones. Source reads are bounded to 64 KiB and carry a stable total length and SHA-256, allowing an agent to reconstruct and verify a large artifact.

At `expires_at`, every public representation returns the same not-found response. The minute cron deletes expired R2 objects and D1 rows; a two-day R2 lifecycle is defense in depth for orphaned objects.

## Ownership boundary

The deploying organization owns the hostname, Worker, D1 database, R2 bucket, Access policy, logs, and Cloudflare bill. The local machine owns its agent integration, non-secret workspace allowlist, and scoped agent token. The open-source project does not receive artifact content or credentials.
