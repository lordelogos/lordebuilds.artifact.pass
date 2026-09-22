# ArtifactPass CLI reference

This document records every ArtifactPass CLI command and every question the CLI can ask. It is the checklist for reviewing CLI copy and flow changes.

Anything marked **Conditional** appears only when the CLI needs that information. Commands marked **No questions** run entirely from arguments or saved state.

## Command map

| Command | Purpose | Interactive questions |
| --- | --- | --- |
| `pnpm dlx artifactpass` | Install ArtifactPass in the current project | Agent, public or private deployment, private URL |
| `pnpm dlx artifactpass install` | Explicit form of the default install command | Same as the default install command |
| `pnpm dlx artifactpass configure` | Change the deployment used by the current project | Public or private deployment, private URL |
| `pnpm dlx artifactpass connect` | Sign the current project into its configured deployment | No terminal questions; browser approval may open |
| `pnpm dlx artifactpass disconnect` | Revoke the selected agent connection | No questions |
| `pnpm dlx artifactpass profile list` | List saved deployment profiles | No questions |
| `pnpm dlx artifactpass profile use <name>` | Change the active fallback profile | No questions |
| `pnpm dlx artifactpass doctor` | Check local installation requirements | No questions |
| `pnpm dlx artifactpass deploy` | Create or update a private deployment | Full guided Cloudflare flow |
| `pnpm dlx artifactpass deploy --status` | List locally recorded private deployments | No questions |
| `pnpm dlx artifactpass deploy --resume <hostname-or-id> --abandon` | Abandon local setup progress | No questions |
| `pnpm dlx artifactpass deployment doctor --resume <hostname-or-id>` | Inspect a private deployment without changing it | No questions |
| `pnpm dlx artifactpass deployment auth status --resume <hostname-or-id>` | Check saved Cloudflare authorization | No questions |
| `pnpm dlx artifactpass deployment auth disconnect --resume <hostname-or-id>` | Revoke saved Cloudflare authorization | No questions |
| `pnpm dlx artifactpass deploy-public ...` | Operator command for the public service | No questions |
| `pnpm dlx artifactpass activate-public ...` | Operator command for public DNS activation | No questions |
| `pnpm dlx artifactpass deploy --account-id ...` | Legacy non-interactive private deployment | No questions |
| `pnpm dlx artifactpass help` | Print command usage | No questions |

## Install ArtifactPass in a project

Commands:

```sh
pnpm dlx artifactpass
pnpm dlx artifactpass install
```

The two commands run the same installation flow. Setup applies to the current project unless `--workspace-root` supplies another project.

### Question 1: agent

```text
Which agent are you setting up?
1. Codex
2. Claude Code
3. Gemini CLI
4. Kimi Code
5. Cursor
6. VS Code / GitHub Copilot
7. Antigravity
8. Other MCP client
```

**Skipped when:** `--agent` is supplied.

Accepted values are:

```text
codex
claude
gemini
kimi
cursor
vscode
antigravity
other
```

Selecting `Other MCP client` installs the portable MCP and skills bundle but cannot register it in a known agent automatically. The success output prints the MCP configuration and skills directory for manual registration.

### Question 2: deployment type

```text
Public or private deployment?
1. Public
2. Private
```

Choosing `Public` uses:

```text
https://artifactpass.com
```

**Skipped when:** `--base-url` or `--profile` is supplied.

### Question 3: private deployment URL

Only appears after selecting `Private`.

```text
Private deployment URL
> https://artifacts.example.com
```

This field expects the complete deployment URL, including `https://`. This is different from the private deployment wizard's domain field, which expects only `example.com`.

### What installation changes

Installation:

1. Installs the shared ArtifactPass plugin, MCP server, and Agent Skills.
2. Registers supported agent configuration for the selected agent.
3. Binds the selected deployment to the current project.
4. Verifies the MCP handshake, tools, and skills.
5. Writes an installation receipt.

Installation does not sign the agent in. The user starts a new agent session and chooses **Connect ArtifactPass** when first publishing.

### Successful output

For a supported agent:

```text
ArtifactPass is installed for <profile> and is not connected.
Open it in your agent and choose Connect ArtifactPass when you want to publish.
Installed for <agent>.
Start a new agent session before using it.
```

For `Other MCP client`:

```text
ArtifactPass is installed for <profile> and is not connected.
Open it in your agent and choose Connect ArtifactPass when you want to publish.
Manual host registration required.
MCP: <configuration path>; skills: <skills directory>.
Start a new agent session before using it.
```

### Flags that remove questions

```sh
pnpm dlx artifactpass \
  --agent codex \
  --base-url https://artifactpass.com \
  --workspace-root /absolute/project/path
```

Relevant flags:

- `--agent <agent>` selects the agent.
- `--base-url <url>` selects the deployment directly.
- `--profile <name>` selects an existing saved profile.
- `--workspace-root <path>` changes the project being configured.
- `--no-host-install` installs the portable bundle without registering a known agent.
- `--open-development` permits an explicitly supplied local development URL.
- `--json` prints the installation receipt as JSON and disables interactive questions.

`--agent` cannot be combined with `--no-host-install`.

## Change a project's deployment

Command:

```sh
pnpm dlx artifactpass configure
```

This command changes which deployment the current project uses. It does not reinstall the plugin and does not sign in.

### Question 1: deployment type

```text
Public or private deployment?
1. Public
2. Private
```

### Question 2: private deployment URL

Only appears after selecting `Private`.

```text
Private deployment URL
> https://artifacts.example.com
```

### Successful output

```text
ArtifactPass now uses <deployment URL> for <project path>.
Start a new agent session; if this deployment is not connected,
connect from the agent when you first use it.
```

Questions are skipped when `--base-url` or `--profile` is supplied:

```sh
pnpm dlx artifactpass configure \
  --base-url https://artifacts.example.com \
  --workspace-root /absolute/project/path
```

## Connect an agent

Command:

```sh
pnpm dlx artifactpass connect
```

This command has no terminal questions. It uses, in order:

1. The deployment URL supplied as the positional argument.
2. The deployment selected by `--profile`.
3. The deployment already bound to the current project.
4. Public ArtifactPass when no saved configuration exists.

Examples:

```sh
pnpm dlx artifactpass connect https://artifacts.example.com
pnpm dlx artifactpass connect --profile production
```

If a valid saved agent credential exists, ArtifactPass reuses it. Otherwise it starts browser approval. If automatic browser opening fails, the CLI prints:

```text
Open this URL to approve ArtifactPass:
<approval URL>
```

The browser handles sign-in and approval. The terminal waits for completion but asks no additional questions.

The `connect` command has older host-registration flags limited to:

```text
codex
claude
both
```

The normal installation command should be used for Gemini CLI, Kimi Code, Cursor, VS Code / GitHub Copilot, Antigravity, and other MCP clients.

## Disconnect an agent

Commands:

```sh
pnpm dlx artifactpass disconnect
pnpm dlx artifactpass disconnect https://artifacts.example.com
pnpm dlx artifactpass disconnect --profile <name>
```

**No questions.** ArtifactPass resolves the selected profile, asks the deployment to revoke the token, and removes the credential from the operating-system credential store.

Successful output:

```text
ArtifactPass <profile> token revoked and removed from the OS credential store.
```

## Manage saved profiles

Commands:

```sh
pnpm dlx artifactpass profile list
pnpm dlx artifactpass profile use <name>
```

**No questions.** `profile list` prints saved profiles and their deployment URLs. `profile use` changes the active fallback profile and tells the user to start a new agent session.

## Check the local installation

Command:

```sh
pnpm dlx artifactpass doctor
```

**No questions.** The command checks Node.js, Wrangler, and packaged deployment assets. It exits unsuccessfully when a required component is missing.

## Create or update a private deployment

Commands:

```sh
pnpm dlx artifactpass deploy
pnpm dlx artifactpass deploy --new
pnpm dlx artifactpass deploy --resume artifacts.example.com
```

The deployment wizard stores non-secret progress for the operating-system user. Progress is not tied to the folder where the command was started.

### Conditional resume question

When one unfinished deployment exists:

```text
Resume <deployment> · <last completed step>?
1. Resume this deployment
2. Start a separate deployment
```

When several unfinished deployments exist:

```text
Which private deployment should ArtifactPass resume?
1. <deployment one>
2. <deployment two>
3. Start a separate deployment
```

`--new` skips this question. `--resume <hostname-or-id>` selects the deployment directly.

### Introduction

```text
What ArtifactPass will set up

ArtifactPass will deploy a Worker, D1 database, R2 bucket,
and Cloudflare Access application into your Cloudflare account.

Cloudflare handles your account, plan, payment method,
domain, and company login.
```

Then:

```text
Continue?
1. Yes
2. Save and exit
```

### Domain authority

```text
Do you control the domain and have permission to update its registrar nameservers?
1. Yes
2. Not yet
```

Choosing `Not yet` saves progress and stops before changing Cloudflare.

### Sign-in method

```text
How should people sign in?
1. Email verification code
2. Existing company login
```

The answer determines which Cloudflare permissions ArtifactPass requests.

### Cloudflare authorization

The authorization link is always printed before ArtifactPass tries to open a browser:

```text
Cloudflare authorization:
<authorization URL>

ArtifactPass will also try to open this link.
You can use any browser profile.
```

This is not a terminal question. The user chooses the correct Cloudflare account and approves access in the browser.

### Conditional Cloudflare account question

Only appears when the Cloudflare login can access more than one account:

```text
Which Cloudflare account should own this private ArtifactPass deployment?
1. <account one>
2. <account two>
```

One accessible account is selected automatically.

### Domain selection

When the account already contains domains:

```text
Which domain should ArtifactPass use?
1. example-one.com (active)
2. example-two.com (pending)
3. Add another domain to Cloudflare
```

When adding a domain:

```text
Domain to add to Cloudflare (example: example.com; no https://)
> example.com
```

Enter only:

```text
example.com
```

Do not enter:

```text
https://example.com
example.com/path
```

### Conditional domain handoff

Appears when the chosen domain is not already active:

```text
Add your domain to Cloudflare

Why this page is needed:
ArtifactPass needs a domain you control for the private Worker and team login.

What changes in Cloudflare:
Cloudflare adds the DNS zone and shows the nameservers.
You update those nameservers at your registrar.
ArtifactPass never receives registrar credentials.

What ArtifactPass reads afterward:
The zone ID, domain name, assigned nameservers, and activation status.

Ready when:
example.com appears in this account with status Active.

Cloudflare page:
<Cloudflare URL>
```

The title is `Activate your domain in Cloudflare` when the domain already exists in the account but is still pending.

The handoff asks:

```text
What would you like to do?
1. Open Cloudflare
2. Check again
3. Save and exit
4. Copy link
5. Cancel current action
```

After adding the domain, replace its registrar nameservers with the two nameservers Cloudflare supplies. Return to the terminal after Cloudflare shows the domain as `Active`, then choose `Check again`.

The current terminal implementation prints the URL when `Copy link` is selected. It does not place the URL on the system clipboard.

### D1 readiness

There is no question. ArtifactPass checks whether the account can use D1. A failure stops setup without creating a replacement account or accepting billing terms.

### Conditional R2 handoff

Appears only when R2 is not ready:

```text
Enable R2 in Cloudflare

Why this page is needed:
ArtifactPass stores temporary artifact bytes in a private R2 bucket
owned by your account.

What changes in Cloudflare:
Cloudflare completes first-time R2 setup and shows any plan or payment terms.
ArtifactPass does not choose or accept them.

What ArtifactPass reads afterward:
Whether R2 bucket listing is available.

Ready when:
ArtifactPass can list R2 buckets in this account.
```

The same five-option Cloudflare handoff menu appears.

### Conditional Zero Trust handoff

Appears only when Zero Trust is not ready:

```text
Set up Cloudflare Zero Trust

Why this page is needed:
Cloudflare Access protects your private upload and agent-approval pages.

What changes in Cloudflare:
Cloudflare creates your team name and shows any plan or payment terms.
ArtifactPass does not choose or accept them.

What ArtifactPass reads afterward:
The Zero Trust team domain and configured identity providers.

Ready when:
ArtifactPass can read the account's Zero Trust team domain.
```

The same five-option Cloudflare handoff menu appears.

### Conditional workers.dev name

Appears only when the Cloudflare account does not already have a `workers.dev` name:

```text
Cloudflare Worker address

Cloudflare requires one account-wide workers.dev name before it can deploy Workers.
This is a technical fallback; people will use your chosen ArtifactPass domain.
```

Then:

```text
Which workers.dev name should Cloudflare use?
1. Use <suggested-name>
2. Enter another name
```

If another name is requested:

```text
Workers subdomain name
> company-artifacts
```

### Email verification code branch

When `Email verification code` was selected:

```text
Who may publish through this private deployment?
1. People with approved company email domains
2. Specific email addresses
```

For company domains:

```text
Approved email domains, separated by commas
> example.com
```

For specific addresses:

```text
Approved email addresses, separated by commas

Include your own email address. Anyone omitted from this list,
including the administrator, will be unable to sign in.

> you@example.com
```

ArtifactPass configures the allowlist. It does not send invitation emails.

### Existing company login branch

When `Existing company login` was selected and Cloudflare has no company identity provider, the CLI shows `Add your company login to Cloudflare` followed by the same five-option Cloudflare handoff menu.

After a provider exists:

```text
Which company login providers may be used for ArtifactPass?
1. <provider one>
2. <provider two>
```

One or more providers may be selected. This branch currently allows anyone authenticated by the selected providers to publish. It does not ask for a separate email allowlist.

### Link lifetimes

```text
Which link lifetimes should this private deployment offer?
1. 15 minutes
2. 30 minutes
3. 1 hour
4. 24 hours
5. 7 days
```

One or more lifetimes must be selected.

### Deployment hostname

```text
Where should this private ArtifactPass deployment live?
1. artifacts.example.com
2. example.com
3. Another hostname on this domain
```

For another hostname:

```text
Deployment hostname
> files.example.com
```

### Final review

```text
Review this private ArtifactPass deployment

Hostname: artifacts.example.com
Cloudflare account: <account name>
Cloudflare domain: example.com
Login: Email verification code
Publisher rules: you@example.com
Link lifetimes: 1 hr, 1 day, 7 day
Storage: R2 in this Cloudflare account
Metadata: D1 in this Cloudflare account
Placement: Cloudflare Automatic
```

Then:

```text
What should ArtifactPass do?
1. Approve and deploy
2. Edit hostname
3. Edit sign-in method
4. Edit allowed people
5. Edit link lifetimes
6. Save and exit
```

An edit choice reopens that section and then returns to the final review.

### Deployment progress

After approval:

```text
Starting private deployment. This can take a few minutes
```

The progress indicator updates as ArtifactPass deploys and verifies the Cloudflare resources.

### Successful output

```text
Private ArtifactPass is ready at https://artifacts.example.com.
Stage: complete

Set up ArtifactPass for a teammate:
pnpm dlx artifactpass --base-url https://artifacts.example.com

Anyone with a live ArtifactPass link can read that artifact until it expires.

Change deployment settings later:
pnpm dlx artifactpass deploy --resume artifacts.example.com

Deployment receipt: <local receipt path>
```

### Global controls during the opening questions

The structured opening questions also expose:

```text
Back
Save and exit
Cancel current action
Abandon local deployment
Start a separate deployment
```

These controls are separate from the five-option browser handoff menu.

The current `Continue?` screen contains `Save and exit` twice because it is both a question-specific choice and a global control. This document records that duplication so it is not mistaken for intended copy.

## Inspect or stop private deployment progress

List all local deployment records:

```sh
pnpm dlx artifactpass deploy --status
```

Inspect one record:

```sh
pnpm dlx artifactpass deploy --resume artifacts.example.com --status
```

Abandon local progress without deleting Cloudflare resources:

```sh
pnpm dlx artifactpass deploy --resume artifacts.example.com --abandon
```

These commands ask no questions.

`--non-interactive` also asks no questions, but it must be combined with `--resume <hostname-or-id>` or `--new`. It only returns or creates local deployment state; it does not complete the guided Cloudflare flow.

`--no-save-authorization` keeps the Cloudflare authorization only for the current process and revokes it when the command finishes.

## Check a private deployment

Command:

```sh
pnpm dlx artifactpass deployment doctor --resume artifacts.example.com
```

**No questions and no Cloudflare changes.** The doctor reports:

- local state;
- deployment credential availability;
- Cloudflare authorization;
- D1, R2, Zero Trust, Workers, and domain readiness;
- recorded Cloudflare resources;
- Cloudflare Access protection;
- Worker health;
- retention policy;
- last hosted verification;
- deployment receipt.

It classifies the deployment and prints one next action.

## Manage private deployment authorization

Check authorization:

```sh
pnpm dlx artifactpass deployment auth status --resume artifacts.example.com
```

Disconnect authorization:

```sh
pnpm dlx artifactpass deployment auth disconnect --resume artifacts.example.com
```

Both commands ask no questions. Disconnecting removes the local grant and attempts to revoke it in Cloudflare. It does not delete the deployed Worker, D1 database, R2 bucket, DNS records, or Access application.

## Public service operator commands

These commands are release and infrastructure commands. They are not end-user setup wizards and ask no questions.

### Deploy the public service

```sh
pnpm dlx artifactpass deploy-public \
  --account-id <id> \
  --zone-id <id> \
  --hostname <host> \
  --workers-subdomain <name> \
  --pdf-key-id <id> \
  --pdf-public-key <base64> \
  --google-client-id <id> \
  --github-client-id <id> \
  --dry-run
```

Required secrets are supplied through the environment:

```text
ARTIFACTPASS_GOOGLE_OAUTH_CLIENT_SECRET
ARTIFACTPASS_GITHUB_OAUTH_CLIENT_SECRET
```

Cloudflare authentication uses `CLOUDFLARE_API_TOKEN` when present. For a non-dry-run deployment without that variable, the command attempts to use the token from `wrangler login --use-keyring`.

Exactly one release mode is required:

```text
--dry-run
--write-approval-manifest <path>
--approve-manifest <path>
```

`--production-existing-resources` is available when promoting against the known production resources.

### Activate the public hostname

```sh
pnpm dlx artifactpass activate-public \
  --account-id <id> \
  --hostname <host> \
  --write-approval-manifest <path>
```

This command requires `CLOUDFLARE_API_TOKEN` and exactly one of:

```text
--write-approval-manifest <path>
--approve-manifest <path>
```

## Legacy non-interactive private deployment

This compatibility command asks no questions:

```sh
pnpm dlx artifactpass deploy \
  --account-id <id> \
  --zone-id <id> \
  --hostname <host> \
  --workers-subdomain <name> \
  --pdf-key-id <id> \
  --pdf-public-key <base64> \
  --allow-email you@example.com \
  --dry-run
```

At least one `--allow-email` or `--allow-domain` rule is expected by the deployment contract. Exactly one deployment mode is required:

```text
--dry-run
--write-approval-manifest <path>
--approve-manifest <path>
```

Use the guided `deploy` command for normal private deployments.

## Help and machine-readable output

Print command usage:

```sh
pnpm dlx artifactpass help
pnpm dlx artifactpass --help
```

Commands that accept `--json` return machine-readable output. For installation and configuration, `--json` disables questions, so supply the missing choices as flags, such as `--agent` and `--base-url`. Private deployment status, authorization, and doctor commands already ask no questions. On the guided private deployment command, `--json` changes the final output but does not remove the setup questions.
