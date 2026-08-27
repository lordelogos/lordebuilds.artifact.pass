# Architecture

ArtifactPass v1 is a public Cloudflare Worker at `artifactpass.com` plus a local agent bridge. The same Worker application runs locally through Wrangler and in production on Cloudflare. Organization-owned deployments are planned separately and do not change the portable MCP or Agent Skills contract.

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

Local storage never reads or writes production D1 or R2. Deployment sends the built Worker to Cloudflare and binds the managed production D1/R2 resources; it does not replace the local environment.

The bridge selects one profile at startup. Credentials and journals are isolated per profile. A profile migrated from config v1 retains the original journal path so its SQLite publisher and retry identity survive a live upgrade; profiles created under config v2 use namespaced journal paths.

The public package, executable, plugin, marketplace, MCP registration key, and skill namespace are `artifactpass`. Compatibility reads retain the legacy `lordebuilds.artifacts.share` config, credential, and health identifiers until cleanup is safe. The MCP tool names `publish_artifact` and `read_artifact`, signed PDF qualifiers, publication commitments, Cloudflare resource names, and storage bindings remain stable protocol or infrastructure identifiers.

The service returns a random URL under `/a/`. Public readers may fetch only the named artifact representations. They cannot list artifacts or create new ones. Source reads are bounded to 64 KiB and carry a stable total length and SHA-256, allowing an agent to reconstruct and verify a large artifact.

At `expires_at`, every public representation returns the same not-found response. The minute cron deletes expired R2 objects and D1 rows; a two-day R2 lifecycle is defense in depth for orphaned objects.

## Ownership boundary

Lorde Builds owns the public hostname, Worker, D1 database, private R2 bucket, OAuth applications, logs, and Cloudflare bill. The local machine owns its agent integration, non-secret workspace allowlist, and scoped agent token. Google and GitHub authenticate the human in the browser; the local CLI receives only an ArtifactPass agent token after approval.

The planned organization-owned mode moves the deployment resources and identity configuration to the customer while retaining the same MCP tools, skills, share-link protocol, and browser flow. That admin experience is outside public v1.
