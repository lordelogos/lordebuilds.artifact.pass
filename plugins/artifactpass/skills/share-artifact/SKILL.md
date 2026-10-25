---
name: share-artifact
description: Publish one declared final durable artifact (Markdown, HTML, or PDF) as a temporary link for a person or agent when a compatible lifecycle event identifies a handoff or the user explicitly asks; return only tool-reported details.
---

# Share an artifact

Use the ArtifactPass MCP tools for connection and publishing. Never paste the file contents into the model prompt.

Resolve the exact absolute local path the user named before checking the connection. Do not substitute a similarly named file. Before the first publication attempt in a workspace, call `connection_status` with that exact path as `workspace_path` so ArtifactPass selects the deployment configured for the file's workspace.

- If it reports `connected` and `ready_to_publish` is true, continue to `publish_artifact`.
- If it reports `workspace_required`, call `connect_artifactpass` with the exact same `workspace_path` and `workspace_root`. This opens a local ArtifactPass page showing the canonical project folder and publishing destination. Tell the user that project access needs approval and always include the returned `approval_url`, even when the browser opened automatically, so they can choose the correct browser profile.
- If it reports `disconnected`, call `connect_artifactpass` with the same path and root. That tool opens the configured ArtifactPass sign-in in the user's browser. Tell the user which deployment is requesting access and always include any returned `approval_url` for manual opening or browser-profile selection.
- If it reports `connecting`, distinguish the returned `phase`. For `workspace_approval`, wait for the project approval page. For `authentication`, wait for deployment sign-in. Check `connection_status` again with the exact same path and root. Do not run a terminal command, reinstall the plugin, register another MCP server, or ask for an agent restart.
- If project approval completes but authentication is `disconnected`, call `connect_artifactpass` again with the same path and root to start the existing sign-in flow.
- If it reports `failed`, stop and report the tool's message and error code. A cancelled or expired project approval must not be retried without the user's direction. Never claim that ArtifactPass is connected.

After project approval and any required sign-in, confirm `workspace_status` is `approved`, `authentication_status` is `connected`, and `ready_to_publish` is true. Then continue the original publication request in the same agent session using the original file path, workspace root, expiry, and canonical PDF source. The user should not have to repeat the request.

Apply this portable lifecycle policy once per session. A final candidate exists only when the agent has produced one durable Markdown, HTML, or PDF artifact as the completed work product and can name its exact path. Ordinary chat, code changes, logs, tests, configuration, scratch files, and intermediate output are not final candidates. If there is no declared artifact, remain quiet: do not call the tool and produce no visible sharing message. An explicit opt-out remains quiet and prevents tool calls for the rest of that task unless the user explicitly opts back in.

When the environment exposes a trusted completion event, it may use that event to apply this same policy automatically. If no such capability exists, automatic triggering is unavailable but sharing is not: use this skill manually when the user asks to publish the final artifact. Do not require ecosystem-specific commands or syntax.

Before calling the publishing tool:

1. Prefer Markdown for text-first work, HTML for self-contained interactive output, and PDF only when fixed layout is important.
2. Confirm the file type is Markdown, HTML, or PDF. Explain that other formats are not supported instead of implying they will work.
3. Use the user's requested expiry when it is one of the tool's supported values. When no expiry is requested, use one hour (3600 seconds). Otherwise ask them to choose a supported duration.

Call `publish_artifact` with the exact path and a deployment expiry preset. Public ArtifactPass supports 900, 1800, 3600, 86400, or 604800 seconds. The public website recommends one hour, one day, or seven days to people while keeping the shorter values available to agents. If another deployment rejects a requested value, use the allowed values in its error. The bridge infers and validates the content type from the filename.

For a PDF, pass `canonical_source_path` only when it names the exact UTF-8 source used to produce that PDF. The bridge verifies that source against the visible PDF content and signs a receipt; the service independently verifies the hashes, signature, key, and pipeline version. Never reconstruct, extract, or invent a canonical source merely to obtain controlled trust. If no exact source exists, omit the field: the PDF still shares for people but remains human-only for agents.

On success, return the share URL, exact expiry cutoff, and `pdf_trust` state reported by the tool. Say that the same link can be opened by a person in a browser or read by a connected agent when supported. The temporary URL is a bearer capability: anyone who has it can read the artifact until expiry.

The handoff must include the artifact format, byte size, SHA-256 checksum, exact expiry cutoff, and share URL from the tool result. Do not infer or invent any of these fields.

For PDF, distinguish `controlled` from `human_only`. A controlled PDF exposes the signed canonical source to agents; a human-only PDF exposes only bounded metadata and its browser/download link. A controlled request fails when visible-content verification is incomplete or the source differs from the PDF. Do not claim perfect visual equivalence, permanent history, public access, paid features, or support for formats outside the tool schema.

If `publish_artifact` reports `workspace_not_approved`, follow the project approval flow above once and retry the unchanged publication only after readiness becomes true. If it reports that ArtifactPass is disconnected, follow the sign-in flow once and retry the unchanged publication only after readiness becomes true. For any other path, authorization, cancellation, expiry, size, or network error, report that error without trying to bypass workspace roots, redirects, access controls, or file-size limits.
Never invent a URL or imply publication succeeded after an error. Keep the local artifact available as the truthful fallback.
