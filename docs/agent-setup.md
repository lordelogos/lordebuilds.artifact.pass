# Agent setup

An administrator deploys one service. Each developer connects an AI agent through the Access-protected device flow. Artifact Share's baseline integration is one MCP server plus Agent Skills; ecosystem plugins only register those same files.

## Connect

```sh
pnpm dlx @artifact-share/setup connect https://artifacts.example.com \
  --profile production \
  --workspace-root /absolute/path/to/workspace-a \
  --workspace-root /absolute/path/to/workspace-b
```

When a known installer is available, use `--host codex` or `--host claude` to install one adapter only; the default detects both. These are convenience adapters, not separate implementations. During browser approval, confirm the deployment hostname and Access identity. The terminal never asks you to paste a token.

Connection installs or refreshes `artifact-share@lordebuilds-artifacts`, saves the scoped token in macOS Keychain or Linux Secret Service, and writes a mode-0600 config file at `${XDG_CONFIG_HOME:-~/.config}/lordebuilds.artifacts.share/config.json`. Tokens and publication journals are isolated by profile. A migrated v1 profile keeps its existing journal path so in-flight retries and an older bridge process remain safe; newly added profiles use namespaced journals. Set `ARTIFACT_SHARE_CONFIG_PATH` to choose another non-secret config path.

Local and production connections coexist:

```sh
pnpm dlx @artifact-share/setup connect http://127.0.0.1:8787 \
  --profile local --open-development \
  --workspace-root /absolute/path/to/workspace
pnpm dlx @artifact-share/setup connect https://artifactpass.com \
  --profile production \
  --workspace-root /absolute/path/to/workspace
pnpm dlx @artifact-share/setup profile list
pnpm dlx @artifact-share/setup profile use local
pnpm dlx @artifact-share/setup profile use production
```

Connecting a profile makes it active but preserves every other profile. `ARTIFACT_SHARE_PROFILE=<name>` overrides the selection for one process without rewriting the saved active profile. Restart an agent session after changing the active profile.

Restart the agent after connecting so it reloads the skills and MCP bridge. Both MCP tool descriptions include the active profile, origin, and connection mode, so every compatible agent host can verify its target before acting.

### Portable MCP and Agent Skills setup

For any other compatible agent system, skip automatic host installation:

```sh
pnpm dlx @artifact-share/setup connect https://artifacts.example.com \
  --profile production \
  --no-host-install \
  --workspace-root /absolute/path/to/workspace
```

The result prints `portableIntegration.mcpConfig` and `portableIntegration.skillsDirectory`. Register those paths using the agent system's normal MCP and Agent Skills controls. Systems that support MCP but do not load Agent Skills can still discover and invoke the two tools from their MCP schemas.

## Use

- Ask the agent to share a supported absolute path with an expiry preset.
- Ask it to read an Artifact Share URL from the configured deployment.

Some ecosystems namespace installed skills, such as `$artifact-share:share-artifact`. That syntax is an adapter detail, not part of the portable product contract.

The sharing tool sends file bytes directly from the bridge to your Worker; the model receives only the resulting URL and manifest. The reading tool returns bounded chunks. Continue with `next_cursor` until it is `null`, then verify the reconstructed byte length and SHA-256 from the manifest.

For PDFs, `auto` returns signed canonical source only for a controlled PDF. Human, external, and provenance-unknown PDFs return bounded metadata and remain human-only.

## Diagnose or disconnect

```sh
pnpm dlx @artifact-share/setup doctor
pnpm dlx @artifact-share/setup disconnect --profile production
```

Disconnect first revokes that profile's server-side token, then removes only that profile's local keychain entry. It preserves every non-secret profile so a failed revocation cannot silently leave an active credential while reporting local success.

## Headless bridge use

Interactive use resolves the OS credential store. A headless process must supply its scoped credential through its own secret manager; never place it in `.mcp.json`, a repository file, command history, or model prompt. Keep workspace roots minimal and absolute.
