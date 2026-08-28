---
name: share-artifact
description: Publish one declared final durable artifact when a compatible lifecycle event identifies a Markdown, HTML, or PDF handoff, or when explicitly asked to create a temporary link; return only tool-reported handoff details.
---

# Share an artifact

Use the ArtifactPass MCP tools for connection and publishing. Never paste the file contents into the model prompt.

Before the first publication attempt in a workspace, call `connection_status`.

- If it reports `connected`, continue to `publish_artifact`.
- If it reports `disconnected`, call `connect_artifactpass`. That tool opens the configured ArtifactPass deployment in the user's browser. Tell the user which deployment is requesting access and show the returned approval URL only when `browser_opened` is false.
- If it reports `connecting`, wait for browser approval and check `connection_status` again. Do not run a terminal command, reinstall the plugin, register another MCP server, or ask for an agent restart.
- If it reports `failed`, report the tool's message. Never claim that ArtifactPass is connected.

After approval, confirm `connection_status` is `connected`, then continue the original publication request in the same agent session. The user should not have to repeat the request.

Apply this portable lifecycle policy once per session. A final candidate exists only when the agent has produced one durable Markdown, HTML, or PDF artifact as the completed work product and can name its exact path. Ordinary chat, code changes, logs, tests, configuration, scratch files, and intermediate output are not final candidates. If there is no declared artifact, remain quiet: do not call the tool and produce no visible sharing message. An explicit opt-out remains quiet and prevents tool calls for the rest of that task unless the user explicitly opts back in.

When the environment exposes a trusted completion event, it may use that event to apply this same policy automatically. If no such capability exists, automatic triggering is unavailable but sharing is not: use this skill manually when the user asks to publish the final artifact. Do not require ecosystem-specific commands or syntax.

Before calling the tool:

1. Resolve the exact local path the user named. Do not substitute a similarly named file.
2. Prefer Markdown for text-first work, HTML for self-contained interactive output, and PDF only when fixed layout is important.
3. Confirm the file type is Markdown, HTML, or PDF. Explain that other formats are not supported instead of implying they will work.
4. Use the user's requested expiry when it is one of the tool's supported values. When no expiry is requested, use one hour (3600 seconds). Otherwise ask them to choose a supported duration.

Call `publish_artifact` with the exact path and a deployment expiry preset. Public ArtifactPass supports 900, 1800, or 3600 seconds. If another deployment rejects a requested value, use the allowed values in its error. The bridge infers and validates the content type from the filename.

For a PDF, pass `canonical_source_path` only when it names the exact UTF-8 source used to produce that PDF. The bridge verifies that source against the visible PDF content and signs a receipt; the service independently verifies the hashes, signature, key, and pipeline version. Never reconstruct, extract, or invent a canonical source merely to obtain controlled trust. If no exact source exists, omit the field: the PDF still shares for people but remains human-only for agents.

On success, return the share URL, exact expiry cutoff, and `pdf_trust` state reported by the tool. Say that the temporary URL is a bearer capability: anyone who has it can read the artifact until expiry.

The handoff must include the artifact format, byte size, SHA-256 checksum, exact expiry cutoff, and share URL from the tool result. Do not infer or invent any of these fields.

For PDF, distinguish `controlled` from `human_only`. A controlled PDF exposes the signed canonical source to agents; a human-only PDF exposes only bounded metadata and its browser/download link. A controlled request fails when visible-content verification is incomplete or the source differs from the PDF. Do not claim perfect visual equivalence, permanent history, public access, paid features, or support for formats outside the tool schema.

If `publish_artifact` reports that ArtifactPass is disconnected, follow the connection flow above once, then retry the same publication once after the status becomes `connected`. For any other path, authorization, size, or network error, report that error without trying to bypass workspace roots, redirects, access controls, or file-size limits.
Never invent a URL or imply publication succeeded after an error. Keep the local artifact available as the truthful fallback.
