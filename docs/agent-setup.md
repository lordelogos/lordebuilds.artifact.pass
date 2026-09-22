# Agent setup

Public ArtifactPass is already deployed at `artifactpass.com`. People can publish in the browser, agents can publish from an approved workspace, and either a person or connected agent can receive the resulting temporary link. Its baseline agent integration is one MCP server plus Agent Skills; ecosystem plugins only register those same files.

For the exact questions, choices, flags, and success output for installation, configuration, connection, profiles, and disconnection, see [ArtifactPass CLI reference](./cli-reference.md).

## Supported handoffs

- **Person → person:** upload at `artifactpass.com`, then send the link.
- **Person → agent:** give a browser-created link to a connected agent to read supported source.
- **Agent → person:** ask an agent to publish, then open its link in a browser.
- **Agent → agent:** one agent publishes and another reads the exact supported source.

The publisher signs in. A recipient opening the temporary link in a browser does not need an ArtifactPass account. Markdown and HTML source can be read by connected agents. A PDF is agent-readable only when ArtifactPass reports it as controlled; other PDFs remain browser and download handoffs for people.

## Install

From the workspace the agent may share, run:

```sh
pnpm dlx artifactpass
```

Choose the agent used in this workspace, then choose public ArtifactPass or a private deployment. Setup installs or repairs the portable bundle, registers the selected agent, negotiates the MCP tools, verifies both skills, and writes a private install receipt. It does not open a browser or authenticate.

The agent question belongs only to workspace installation. `pnpm dlx artifactpass deploy` creates or updates Cloudflare infrastructure and never asks which agent you use.

## Connect inside the agent

Start a new agent session once after installation. ArtifactPass appears as installed but disconnected. Ask the agent to share an artifact or say **Connect ArtifactPass**. The plugin opens the public approval page. Sign in with Google or GitHub, confirm the displayed code, and approve it. The plugin becomes connected and can continue publishing in the same session. No terminal connection command or post-login restart is required.

## Change a workspace deployment

An existing installation is reconfigurable. From the workspace you want to change, run:

```sh
pnpm dlx artifactpass configure
```

Choose public ArtifactPass or enter the private deployment URL. The choice is bound to the current workspace. Other workspaces keep their own deployment, profile, and credential. Start a new agent session so its MCP process loads the changed workspace configuration. It remains disconnected until the agent invokes **Connect ArtifactPass**.

For automation, make the same change without prompts:

```sh
pnpm dlx artifactpass --base-url https://artifacts.example.com \
  --workspace-root /absolute/path/to/workspace
```

The default installer detects supported hosts. These are convenience adapters, not separate implementations. During browser approval, confirm the deployment hostname and the code shown by the agent. The agent never asks you to paste a token.

Installation writes a mode-0600 profile config at `${XDG_CONFIG_HOME:-~/.config}/artifactpass/config.json`. Connection saves the scoped token in macOS Keychain or Linux Secret Service. Tokens and publication journals are isolated by profile. A migrated v1 profile keeps its legacy config, credential, and journal state available until restart persistence is proven, so in-flight retries and an older bridge process remain safe. Set `ARTIFACTPASS_CONFIG_PATH` to choose another non-secret config path. Legacy `ARTIFACT_SHARE_*` variables remain read-compatible during migration; new state is written only under ArtifactPass names.

Local and hosted connections coexist:

```sh
pnpm dlx artifactpass --base-url http://127.0.0.1:8787 \
  --profile local --open-development \
  --workspace-root /absolute/path/to/workspace
pnpm dlx artifactpass configure --base-url https://artifactpass.com \
  --workspace-root /absolute/path/to/workspace
pnpm dlx artifactpass profile list
pnpm dlx artifactpass profile use local
pnpm dlx artifactpass profile use production
```

Workspace configuration preserves every other profile. `ARTIFACTPASS_PROFILE=<name>` remains an explicit one-process override. Restart an agent session after installing the plugin or changing that workspace's deployment.

The MCP tool descriptions include the active profile and origin, so every compatible agent host can verify its target before acting. Browser approval changes the running bridge from disconnected to connected without a restart.

### Portable MCP and Agent Skills setup

For any other compatible agent system, skip automatic host installation:

```sh
pnpm dlx artifactpass --base-url https://artifacts.example.com \
  --profile production \
  --no-host-install \
  --workspace-root /absolute/path/to/workspace
```

The result prints the portable MCP configuration and Agent Skills directory. Register those paths using the agent system's normal MCP and Agent Skills controls. Systems that support MCP but do not load Agent Skills can still discover the connection, publication, and reading tools from their MCP schemas.

## Use

- Ask the agent to share a supported absolute path with an expiry preset. Send the returned link to a teammate or another agent.
- Give the agent an ArtifactPass URL created by a person or agent and ask it to read the supported source.

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
