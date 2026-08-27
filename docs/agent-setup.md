# Agent setup

Public ArtifactPass is already deployed at `artifactpass.com`. Its baseline integration is one MCP server plus Agent Skills; ecosystem plugins only register those same files.

## Install

From the workspace the agent may share, run:

```sh
pnpm dlx artifactpass
```

This installs or repairs the portable bundle, registers every detected supported host, negotiates both MCP tools, verifies both skills, and writes a private install receipt. It does not open a browser or authenticate.

## Connect

When the workspace needs permission to publish, run:

```sh
pnpm dlx artifactpass connect
```

ArtifactPass opens the public approval page. Sign in with Google or GitHub, confirm the displayed code, and approve it. The terminal never asks for a Google, GitHub, or Cloudflare password and never receives the provider credential.

For a custom deployment or explicit workspace set, use:

```sh
pnpm dlx artifactpass connect https://artifacts.example.com \
  --profile production \
  --workspace-root /absolute/path/to/workspace-a \
  --workspace-root /absolute/path/to/workspace-b
```

When a known installer is available, use `--host codex` or `--host claude` to install one adapter only; the default detects both. These are convenience adapters, not separate implementations. During browser approval, confirm the deployment hostname and the code from your terminal. The terminal never asks you to paste a token.

Connection saves the scoped token in macOS Keychain or Linux Secret Service and writes a mode-0600 config file at `${XDG_CONFIG_HOME:-~/.config}/artifactpass/config.json`. Tokens and publication journals are isolated by profile. A migrated v1 profile keeps its legacy config, credential, and journal state available until restart persistence is proven, so in-flight retries and an older bridge process remain safe. Set `ARTIFACTPASS_CONFIG_PATH` to choose another non-secret config path. Legacy `ARTIFACT_SHARE_*` variables remain read-compatible during migration; new state is written only under ArtifactPass names.

Local and production connections coexist:

```sh
pnpm dlx artifactpass connect http://127.0.0.1:8787 \
  --profile local --open-development \
  --workspace-root /absolute/path/to/workspace
pnpm dlx artifactpass connect \
  --profile production \
  --workspace-root /absolute/path/to/workspace
pnpm dlx artifactpass profile list
pnpm dlx artifactpass profile use local
pnpm dlx artifactpass profile use production
```

Connecting a profile makes it active but preserves every other profile. `ARTIFACTPASS_PROFILE=<name>` overrides the selection for one process without rewriting the saved active profile. Restart an agent session after changing the active profile.

Restart the agent after connecting so it reloads the skills and MCP bridge. Both MCP tool descriptions include the active profile, origin, and connection mode, so every compatible agent host can verify its target before acting.

### Portable MCP and Agent Skills setup

For any other compatible agent system, skip automatic host installation:

```sh
pnpm dlx artifactpass connect https://artifacts.example.com \
  --profile production \
  --no-host-install \
  --workspace-root /absolute/path/to/workspace
```

The result prints `portableIntegration.mcpConfig` and `portableIntegration.skillsDirectory`. Register those paths using the agent system's normal MCP and Agent Skills controls. Systems that support MCP but do not load Agent Skills can still discover and invoke the two tools from their MCP schemas.

## Use

- Ask the agent to share a supported absolute path with an expiry preset.
- Ask it to read an ArtifactPass URL from the configured deployment.

Some ecosystems namespace installed skills, such as `$artifactpass:share-artifact`. That syntax is an adapter detail, not part of the portable product contract.

The sharing tool sends file bytes directly from the bridge to your Worker; the model receives only the resulting URL and manifest. The reading tool returns bounded chunks. Continue with `next_cursor` until it is `null`, then verify the reconstructed byte length and SHA-256 from the manifest.

For PDFs, `auto` returns signed canonical source only for a controlled PDF. Human, external, and provenance-unknown PDFs return bounded metadata and remain human-only.

## Diagnose or disconnect

```sh
pnpm dlx artifactpass doctor
pnpm dlx artifactpass disconnect --profile production
```

Disconnect first revokes that profile's server-side token, then removes only that profile's local keychain entry. It preserves every non-secret profile so a failed revocation cannot silently leave an active credential while reporting local success.

## Headless bridge use

Interactive use resolves the OS credential store. A headless process must supply its scoped credential through its own secret manager; never place it in `.mcp.json`, a repository file, command history, or model prompt. Keep workspace roots minimal and absolute.
