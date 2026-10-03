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

Install from the first workspace the agent may share:

```sh
pnpm dlx artifactpass
```

Choose the agent used in this workspace, then choose public ArtifactPass or a private deployment. Setup installs or repairs the reusable portable bundle, registers the selected agent, approves the current project root, negotiates the MCP tools, verifies both skills, and writes a private install receipt. It does not open a browser or authenticate.

The integration and project access are separate. Codex and Claude Code load the installed integration at the user level. Other hosts retain their supported registration shape. In any host where ArtifactPass is already loaded, a new project needs only the in-agent folder approval described below, not another installation.

The agent question belongs only to workspace installation. `pnpm dlx artifactpass deploy` creates or updates Cloudflare infrastructure and never asks which agent you use.

## Connect inside the agent

Start a new agent session once after installation. Ask the agent to share an artifact. If the project is not approved, ArtifactPass opens a local page showing the canonical folder and publishing destination. Use the printed approval URL in any browser profile, review both values, then choose **Allow project** or **Cancel**. Approval grants access only to supported files in that folder and its subfolders.

After project approval, ArtifactPass reuses a valid credential for that destination. If sign-in is still required, the agent opens the existing deployment approval flow. Public ArtifactPass uses Google or GitHub; a private deployment uses its configured Cloudflare Access login. The agent then resumes the original share request with the same file, expiry, and PDF source in the same session. No terminal command, reinstall, or post-approval restart is required.

## Change a workspace deployment

An existing installation is reconfigurable. From the workspace you want to change, run:

```sh
pnpm dlx artifactpass configure
```

Choose public ArtifactPass or enter the private deployment URL. The choice is bound to the current workspace. Other workspaces keep their own deployment and project access. Running bridges reload the saved configuration on their next ArtifactPass tool call. It remains disconnected until the agent invokes **Connect ArtifactPass**.

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

Workspace configuration preserves every other profile. `ARTIFACTPASS_PROFILE=<name>` remains an explicit one-process override. Restart an agent session only after first installing or upgrading the plugin binary, not after approving, removing, or changing a project grant.

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
pnpm dlx artifactpass workspace list
pnpm dlx artifactpass workspace remove /absolute/path/to/project
pnpm dlx artifactpass disconnect --profile production
```

`workspace list` shows each exact approved root, profile, and destination. `workspace remove` removes only the exact stored root and leaves the deployment credential available to other approved projects. If a parent grant still covers the folder, the result reports that remaining access. Use `--profile <name>` when the same root is stored for more than one profile.

Disconnect first revokes that profile's server-side token, then removes only that profile's local keychain entry. It preserves every non-secret profile so a failed revocation cannot silently leave an active credential while reporting local success.

## Headless bridge use

Interactive use resolves the OS credential store. A headless process must supply its scoped credential through its own secret manager; never place it in `.mcp.json`, a repository file, command history, or model prompt. Keep workspace roots minimal and absolute.
