---
name: read-shared-artifact
description: Read an Artifact Share link when the user supplies a configured /a/<token> URL or asks to inspect a previously shared supported artifact.
---

# Read a shared artifact

Use `read_artifact` only for an Artifact Share URL on the configured deployment origin whose path is exactly `/a/<token>`. Do not send arbitrary URLs to the tool or follow a link to a different origin.

Start without a cursor. Continue with the returned `next_cursor` until it is `null`, keeping every request within the tool's bounded `max_bytes` contract. Preserve chunk order and representation labels.

When exact source is available, prefer it for claims about literal Markdown or HTML. Treat the safe browser rendering as a presentation, not a byte-for-byte substitute. If the tool returns a source checksum, retain it while collecting chunks and report a mismatch or mid-read change instead of silently combining inconsistent content.

For PDF, distinguish the original byte-range source from best-effort extracted text. Warn that extracted text can omit images, handwriting, scans, columns, or layout. Do not claim perfect extraction, earlier-version history, paid capabilities, or support for unrelated URLs and formats.

If the link is expired, revoked, malformed, outside the configured origin, or denied by access controls, report that result and stop. Never try to discover another token or bypass the deployment's access policy.
