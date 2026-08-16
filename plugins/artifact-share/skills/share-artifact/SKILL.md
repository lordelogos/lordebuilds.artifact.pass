---
name: share-artifact
description: Share a local Markdown, HTML, or PDF file through Artifact Share when asked to publish or create a temporary link; always return the URL and exact expiry cutoff, and describe PDF text extraction as best effort with possible layout, image, scan, or ordering loss.
---

# Share an artifact

Use the `publish_artifact` MCP tool for the file itself. Never paste the file contents into the model prompt.

Before calling the tool:

1. Resolve the exact local path the user named. Do not substitute a similarly named file.
2. Prefer Markdown for text-first work, HTML for self-contained interactive output, and PDF only when fixed layout is important.
3. Confirm the file type is Markdown, HTML, or PDF. Explain that other formats are not supported instead of implying they will work.
4. Use the user's requested expiry when it is one of the tool's supported values. When no expiry is requested, use one hour (3600 seconds). Otherwise ask them to choose a supported duration.

Call `publish_artifact` with the exact path and a deployment expiry preset. Start with the default setup presets: 900, 1800, 3600, 43200, or 86400 seconds. If the deployment rejects one, use the allowed values in its error. The bridge infers and validates the content type from the filename. On success, return both the share URL and the exact expiry cutoff reported by the tool. Say that the temporary URL is a bearer capability: anyone who has it can read the artifact until expiry.

The handoff must include the artifact format, byte size, SHA-256 checksum, exact expiry cutoff, and share URL from the tool result. Do not infer or invent any of these fields.

For PDF, describe extraction as best effort: the browser preserves the original PDF, while agent-readable text may lose layout, ordering, images, or scanned content. Do not claim perfect conversion, permanent history, public access, paid features, or support for formats outside the tool schema.

If the tool reports a path, authorization, size, or network error, report that error without trying to bypass workspace roots, redirects, access controls, or file-size limits.
