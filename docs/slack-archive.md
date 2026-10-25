# Archive ArtifactPass links in Slack

The optional ArtifactPass Archive app copies a file from a live ArtifactPass link into the Slack thread where someone posted it. The Slack copy remains under your workspace's file-retention policy after the original link expires. This is a separate, customer-owned add-on: it does not change your ArtifactPass deployment or install an agent.

This integration is being built and is **not yet released or qualified for production**. The steps below describe the current CLI for a pilot. Do not treat one live pilot as proof that a Cloudflare Free account will sustain your traffic. The [Cloudflare capacity notes](slack-archive-free-tier.md) separate measured automatic-bot behavior from the quota-derived planning budget.

## Decide where it runs

You need a Cloudflare account with a `workers.dev` subdomain, even if your team only uses public `https://artifactpass.com` links. Set up that subdomain in Cloudflare Workers & Pages first if the account has never used Workers. The CLI provisions one Worker, one Queue, and one D1 database there. It does not provision or alter an ArtifactPass deployment. You also need permission to create and install one Slack app in the workspace you want to archive into, and permission to add that app to each selected channel.

The app asks Slack for `links:read` to receive events for its registered domains and `files:write` to upload the copy. It does not ask for message-history scopes. The Worker accepts only signed events for your selected Slack workspace and app. You opt channels in one by one. It ignores links still in a message composer; archiving begins only after the message is posted.

Public ArtifactPass is included by default. Add a private deployment as an additional HTTPS **origin**, for example `https://artifacts.example.com`. Do not enter a share URL or just `example.com`. One Slack app can register at most five source domains total, including `artifactpass.com`. A private deployment still has its own [deployment setup](../packages/setup-cli/README.md#private-deployments); this bot does not create it.

## Pilot setup

Use Node.js 24 or newer and pnpm. These commands describe the build in this repository until the package containing the Slack commands is released.

1. Run `pnpm dlx artifactpass slack setup`. The CLI prints the Cloudflare authorization link, so you can open it in the browser profile you choose. Select the Cloudflare account and approve creating this add-on's Worker, Queue, and D1 database. The command saves a non-secret local state file and a bootstrap Slack app manifest, then prints both the manifest path and Slack's app-dashboard link. If you leave, run the same command to resume.
2. In the Slack app dashboard, create an app **from the printed bootstrap manifest**, choose your workspace, and install it. Do not add message-reading scopes. Find the workspace/team ID and app ID in Slack. Keep the signing secret and bot token out of terminal arguments, source files, and chat.
3. In the printed Cloudflare Worker dashboard, set Worker secrets `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` using Slack's values. The local configuration and manifest never contain those values. Run `pnpm dlx artifactpass slack activate --team-id T1234567890 --app-id A1234567890` with your actual IDs. This checks the **names** of the Worker secrets, redeploys the app identity, and writes an active signed-event manifest. Apply that manifest to the same Slack app. Slack must accept its request URL before continuing.
4. If you also archive a private deployment, run `pnpm dlx artifactpass slack sources add https://artifacts.example.com`, then apply the newly written manifest to the same Slack app. You can do this before enabling a channel. Adding the source to the Worker alone does not register its domain with Slack.
5. Copy a channel link such as `https://example.slack.com/archives/C1234567890`. Run `pnpm dlx artifactpass slack channels add <channel-link-or-id>`. Invite **ArtifactPass Archive** to that channel. A channel is not active merely because the app is installed in the workspace. Post a fresh, unexpired ArtifactPass link in the channel and run `pnpm dlx artifactpass slack status`. Look for a file reply in the message's thread and a successful delivery in status. Check that the Slack download matches the source before inviting a wider team.

The app starts with **zero enabled channels**. The Cloudflare Worker and Slack manifest can exist while archiving is still off. You can use the same sequence for public-only teams by skipping step 4.

## Operate and recover

| Need | Command or action |
| --- | --- |
| Inspect progress and failures | `pnpm dlx artifactpass slack status` |
| Stop new and queued transfers | `pnpm dlx artifactpass slack pause` |
| Resume enabled channels | `pnpm dlx artifactpass slack resume` |
| Update only the archive Worker | `pnpm dlx artifactpass slack update` |
| Add or remove an approved origin | `pnpm dlx artifactpass slack sources add` or `remove`, then apply the new Slack manifest |
| Add or remove a channel | `pnpm dlx artifactpass slack channels add` or `remove` |
| Rotate a token or signing secret | `pnpm dlx artifactpass slack rotate` prints the Worker secret location; rotate in Cloudflare and Slack |
| Remove this add-on | `pnpm dlx artifactpass slack uninstall`, then uninstall the Slack app separately |

If a link appears to do nothing, check the posted message is in an enabled channel, the bot is a member, the source origin is on the allowlist **and** in the applied Slack manifest, the link is live, and `slack status` shows no failure. `needs-review` means Slack upload completion was uncertain. Inspect the source thread and Slack files before any manual retry; the bot deliberately will not create a second copy blindly. An expired or unavailable link cannot be rescued by the bot.

The local setup state stores resource names, IDs, channel IDs, and approved origins, not credentials or share URLs. The customer-owned D1 database stores delivery metadata and error codes, not file bytes or bearer share URLs. Queue jobs briefly carry live share URLs while processing. Cloudflare account operators can access their infrastructure. Slack workspace operators control the retained copies. Removing the bot or expiring an ArtifactPass link does **not** erase a file already uploaded to Slack.
