# Archive ArtifactPass links in Slack

The optional ArtifactPass Archive app copies a file from a live ArtifactPass link into the Slack thread where someone posted it. The Slack copy remains under your workspace's file-retention policy after the original link expires. This is a separate, customer-owned add-on: it does not change your ArtifactPass deployment or install an agent.

This integration is being built and is **not yet released or qualified for production**. The steps below describe the current CLI for a pilot. Do not treat one live pilot as proof that a Cloudflare Free account will sustain your traffic. The [Cloudflare capacity notes](slack-archive-free-tier.md) separate measured automatic-bot behavior from the quota-derived planning budget.

## Decide where it runs

You need a Cloudflare account with a `workers.dev` subdomain, even if your team only uses public `https://artifactpass.com` links. Set up that subdomain in Cloudflare Workers & Pages first if the account has never used Workers. The CLI provisions one Worker, one Queue, and one D1 database there. It does not provision or alter an ArtifactPass deployment. You also need permission to create and install one Slack app in the workspace you want to archive into, and permission to add that app to each selected channel.

The app asks Slack for `links:read` to receive events for its registered domains, `files:write` to upload the copy, and `links:write` to show a warning when a posted link has already expired or become unavailable. It does not ask for message-history scopes. The Worker accepts only signed events for your selected Slack workspace and app. You can enable several channels in one command. It ignores links still in a message composer; archiving begins only after the message is posted. The warning appears after the message is posted, not while someone is typing it.

Public ArtifactPass is included by default. Add a private deployment as an additional HTTPS **origin**, for example `https://artifacts.example.com`. Do not enter a share URL or just `example.com`. One Slack app can register at most five source domains total, including `artifactpass.com`. A private deployment still has its own [deployment setup](../packages/setup-cli/README.md#private-deployments); this bot does not create it.

## Pilot setup

Use pnpm and have Node.js 22 or newer installed for the Cloudflare steps, which run Wrangler. ArtifactPass can open the Slack wizard even if pnpm itself starts under Node 20; it selects the newer installed Node for Wrangler. The guided wizard runs on `127.0.0.1` on your computer; ArtifactPass does not host it or receive your Slack credentials. Use `pnpm dlx artifactpass slack setup --terminal` if you prefer the terminal-only setup.

1. Run `pnpm dlx artifactpass slack setup`. The CLI prints a local wizard link and does **not** choose a browser profile for you. Open the link in the profile you want. On the Cloudflare step, choose **Check connected accounts**. If no account is connected, choose **Connect Cloudflare**, open the authorization link shown in the wizard in the right browser profile, and complete approval. The wizard and terminal commands share the same non-secret local setup file. Choose **Save and exit**, or stop the CLI, then run the command again to resume.
2. Choose link sources before creating the Slack app. Public `https://artifactpass.com` links are included; add private deployment origins such as `https://artifacts.example.com` here if needed. Choose your Cloudflare account and approve creating one Worker, one Queue, and one D1 database.
3. Copy the **complete** manifest from the wizard. It already contains the link domains and event URL. In Slack's app dashboard, create **ArtifactPass Archive** from that manifest in the intended workspace. Open **Event Subscriptions** in the new app. The request URL must show **Verified**; if it does not, click **Retry**, wait for Verified, then click **Save Changes**. Install the app in your workspace. You do not need to replace the manifest after installation. Do not add message-reading scopes or use an older POC app.
4. Enter that app's **App ID** (the `A…` ID on Slack's app list), **Bot User OAuth Token** (OAuth & Permissions), and **Signing Secret** (Basic Information → App Credentials). The wizard checks the bot token with Slack, saves both values as encrypted Cloudflare Worker secrets, and does not store them in its local setup file. Do not put them in terminal arguments, source files, or chat. For terminal-only setup, set both Worker secrets in Cloudflare and run `pnpm dlx artifactpass slack activate --team-id T1234567890 --app-id A1234567890` with your actual IDs. Find the `T…` workspace ID in Slack's web URL, such as `https://app.slack.com/client/T1234567890/C1234567890`.
5. Paste every desired channel link into the wizard, such as `https://example.slack.com/archives/C1234567890` and `https://example.slack.com/archives/G1234567890`. It validates the list and updates the Worker once. Invite **ArtifactPass Archive** to each channel in Slack; installing the app in the workspace does not grant channel membership. Create a small test file from `https://artifactpass.com/upload` or `https://artifacts.example.com/upload` for a private source, then post its new share link. Post a link in every selected channel and at least one from each approved source. The bot should reply with a file in that message's thread. Download and inspect it, then choose **Check real deliveries**. The wizard says **Ready** only after each channel and each source has a successful delivery after the latest setup change and you confirm the file inspection. The terminal equivalents are `pnpm dlx artifactpass slack channels add <first-channel-link> <second-channel-link> ...` and `pnpm dlx artifactpass slack status`.

The app starts with **zero enabled channels**. The Cloudflare Worker and Slack manifest can exist while archiving is still off. A later source-domain change does require updating the same Slack app manifest because Slack must register the new domain.

## Operate and recover

| Need | Command or action |
| --- | --- |
| Inspect progress and failures | `pnpm dlx artifactpass slack status` |
| Stop new and queued transfers | `pnpm dlx artifactpass slack pause` |
| Resume enabled channels | `pnpm dlx artifactpass slack resume` |
| Update only the archive Worker | `pnpm dlx artifactpass slack update` |
| Add or remove an approved origin | `pnpm dlx artifactpass slack sources add` or `remove`, then apply the new Slack manifest |
| Add several channels in one update, or remove one | `pnpm dlx artifactpass slack channels add <links-or-ids...>` or `channels remove <link-or-id>` |
| Rotate a token or signing secret | `pnpm dlx artifactpass slack rotate` prints the Worker secret location; rotate in Cloudflare and Slack |
| Remove this add-on | `pnpm dlx artifactpass slack uninstall`, then uninstall the Slack app separately |

If a link appears to do nothing, check the posted message is in an enabled channel, the bot is a member, the source origin is on the allowlist **and** in the applied Slack manifest, the link is live, and `slack status` shows no failure. An expired or unavailable link gets a warning preview and no Slack file; create a fresh link instead. Status prints a next action for each recorded failure. An absent delivery record can mean Slack did not send an event at all: check the applied manifest, channel opt-in, and bot membership. `needs-review` means Slack upload completion was uncertain. Inspect the source thread and Slack files before any manual retry; the bot deliberately will not create a second copy blindly.

The local setup state stores resource names, IDs, channel IDs, and approved origins, not credentials or share URLs. The customer-owned D1 database stores delivery metadata and error codes, not file bytes or bearer share URLs. Queue jobs briefly carry live share URLs while processing. Cloudflare account operators can access their infrastructure. Slack workspace operators control the retained copies. Removing the bot or expiring an ArtifactPass link does **not** erase a file already uploaded to Slack.
