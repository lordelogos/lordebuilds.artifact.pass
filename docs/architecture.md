# Architecture

ArtifactPass is a Cloudflare Worker plus a local agent bridge. The public deployment runs at `artifactpass.com`; a private deployment runs the same application in a customer-owned Cloudflare account and domain. Both use the same portable MCP tools, Agent Skills, viewer, and bearer-link protocol.

```text
authorized human ──Google/GitHub session──> /upload, /connect/approve
                                │
local AI agent ────agent token─┤ Worker ──> D1 metadata
                                │        └─> private R2 exact bytes
person or agent ─share token──> /a/<opaque-token>/*
```

## Components

| Component | Responsibility |
| --- | --- |
| `apps/artifact-service` | Worker routes, React upload/viewer assets, D1 metadata, R2 objects, human sessions and agent authorization, expiry cleanup |
| `packages/artifact-protocol` | Versioned manifests, limits, errors, source chunk contract |
| `packages/representation-pipeline` | Browser and Node PDF extraction with truthful quality metadata |
| `packages/agent-bridge` | MCP tools, named local/production profiles, approved-root file reads, exact upload/read, per-profile keychain credential resolution, redacted logging |
| `packages/setup-cli` | Transactional one-command installation, idempotent Cloudflare deployment, device connection, host registration, receipt, and disconnect |
| `plugins/artifactpass` | One portable MCP and Agent Skills bundle; ecosystem manifests are thin registration adapters |

## Data flow

An uploader sends multipart source bytes and an expiry choice. D1 records hashes, object keys, content metadata, expiry, hashed bearer tokens, and verified PDF provenance state. R2 stores exact source bytes and, only for controlled PDFs, the signed canonical source privately.

## Environment and storage map

| Environment | Runtime | D1 | R2 | Authentication |
| --- | --- | --- | --- | --- |
| `local` | Wrangler/workerd at `127.0.0.1:8787` | Local SQLite-compatible D1 state under `apps/artifact-service/.wrangler/demo-state` | Local R2 object state under `apps/artifact-service/.wrangler/demo-state` | Explicit open-development mode; no production token |
| `production` | Cloudflare Worker Custom Domain at `artifactpass.com` | Managed Cloudflare D1 database `lordebuilds-artifacts-share` | Private managed Cloudflare R2 bucket `lordebuilds-artifacts-share` | ArtifactPass Google/GitHub session for people; scoped per-profile agent token for MCP |
| `private` | Customer-owned Cloudflare Worker Custom Domain | Customer-owned managed D1 database | Customer-owned private R2 bucket | Customer Cloudflare Access session for people; scoped origin-bound agent token and device key for MCP |

Local storage never reads or writes production D1 or R2. Deployment sends the built Worker to Cloudflare and binds the managed production D1/R2 resources; it does not replace the local environment.

The bridge selects one profile at startup. Credentials and journals are isolated per profile. A profile migrated from config v1 retains the original journal path so its SQLite publisher and retry identity survive a live upgrade; profiles created under config v2 use namespaced journal paths.

The public package, executable, plugin, marketplace, MCP registration key, and skill namespace are `artifactpass`. Compatibility reads retain the legacy `lordebuilds.artifacts.share` config, credential, and health identifiers until cleanup is safe. The MCP surface exposes `connection_status`, `connect_artifactpass`, `publish_artifact`, and `read_artifact`. Signed PDF qualifiers, publication commitments, Cloudflare resource names, and storage bindings remain stable protocol or infrastructure identifiers.

The service returns a random URL under `/a/`. Public readers may fetch only the named artifact representations. They cannot list artifacts or create new ones. Source reads are bounded to 64 KiB and carry a stable total length and SHA-256, allowing an agent to reconstruct and verify a large artifact.

At `expires_at`, every public representation returns the same not-found response. The minute cron deletes expired R2 objects and D1 rows; a two-day R2 lifecycle is defense in depth for orphaned objects.

## Ownership boundary

Lorde Builds owns the public hostname, Worker, D1 database, private R2 bucket, OAuth applications, logs, and Cloudflare bill. The local machine owns its agent integration, non-secret workspace allowlist, and scoped agent token. Google and GitHub authenticate the human in the browser; the local CLI receives only an ArtifactPass agent token after approval.

Private mode moves the hostname, Worker, D1, R2, Access application, login providers, logs, and Cloudflare bill to the customer. The admin setup grant is stored in the admin's OS credential store and is separate from teammate agent credentials. Each teammate generates a device key locally; only its public key and metadata are registered. The customer still cannot list or recover expired artifacts through ArtifactPass.
