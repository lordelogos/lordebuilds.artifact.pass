# Set up private ArtifactPass

Private ArtifactPass runs in your Cloudflare account, on your domain, with your D1 database, private R2 bucket, login rules, logs, and Cloudflare bill. ArtifactPass guides the setup but does not accept plans, add payment methods, or change billing.

## Before you start

You need:

- a Cloudflare account you may administer;
- a domain you control at its registrar;
- permission to create Workers, D1, R2, and Cloudflare Access resources;
- an interactive terminal with Node.js 24 or later and pnpm;
- either approved email domains or specific email addresses for email-code login, or an existing company login configured in Cloudflare Zero Trust.

The same Cloudflare account and payment method may own several deployments. A separate account, card, or domain is not required for each deployment.

## Run the setup

From any folder, run:

```sh
pnpm dlx artifactpass deploy
```

ArtifactPass asks for the domain, the hostname to use, how teammates sign in, who may publish, and which link lifetimes to offer. It then opens Cloudflare so you can authorize the least-privilege setup profile.

When Cloudflare needs first-time account setup, ArtifactPass opens the exact page and waits:

- **Domain:** add the domain, then copy Cloudflare's nameservers into your registrar. Return when Cloudflare shows the domain as Active.
- **R2:** review Cloudflare's plan or payment screen and enable R2 yourself.
- **Zero Trust:** choose a team name and complete any plan or payment screen yourself.
- **Company login:** add the provider in Cloudflare, then return and select it in ArtifactPass.

ArtifactPass never clicks an agreement, selects a paid plan, stores billing information, or receives your registrar or identity-provider password.

The command stops before deployment and shows one approval summary. Review the account, hostname, resources, publisher audience, login method, retention options, Worker digest, and bearer-link warning. Approve only that exact summary. If Cloudflare or the package changes afterward, ArtifactPass requires a new approval.

Successful setup prints a teammate command like:

```sh
pnpm dlx artifactpass --base-url https://artifacts.example.com
```

It also writes a redacted receipt. The receipt contains resource identifiers and verification results, not Cloudflare credentials, login secrets, agent tokens, private keys, or live share links.

Immediately after Cloudflare activates a new hostname, the operating system may briefly retain an earlier DNS failure. ArtifactPass retries that narrow case through Cloudflare's public resolver while preserving HTTPS hostname verification. It does not accept redirects or private-network fallback addresses. Teammates can therefore connect as soon as the deployment passes verification instead of waiting for a local DNS cache to expire.

## Pause or resume

Setup progress belongs to your operating-system user, not the folder where the command was started. You may stop and resume from another folder:

```sh
pnpm dlx artifactpass deploy --resume artifacts.example.com
```

Non-secret progress is stored in ArtifactPass's user configuration directory. The Cloudflare refresh grant is stored separately in the operating-system credential store. Secrets are never written into deployment state.

See recorded deployments without changing Cloudflare:

```sh
pnpm dlx artifactpass deploy --status
```

Check one deployment without changing it:

```sh
pnpm dlx artifactpass deployment doctor --resume artifacts.example.com
```

Doctor reports whether setup is healthy, incomplete, waiting for Cloudflare, unauthorized, drifted, conflicted, repair-required, or failing verification. It prints one next action and never refreshes credentials or mutates Cloudflare.

## Teammate setup

A teammate runs the exact command printed by the admin from the workspace their agent may share:

```sh
pnpm dlx artifactpass --base-url https://artifacts.example.com
```

Setup installs the shared plugin, MCP server, and Agent Skills. It does not sign in. Start a new agent session, ask it to share a file, and choose **Connect ArtifactPass**. The private deployment opens its own Cloudflare Access login. After approval, the agent stores its scoped token and locally generated device private key in the operating-system credential store.

The private key never leaves the teammate's machine. The deployment receives only its public key, key ID, agent name, and workspace name. Disconnecting revokes both the agent token and that device key.

## What is private and what is public

Cloudflare Access protects uploads and agent approval. D1 and R2 stay inside the customer's Cloudflare account. Share links are intentionally different: anyone holding a live `/a/...` URL can read that one artifact until its exact expiry. There is no artifact listing or history page.

## Repair, upgrade, and rollback

- **Repair:** run doctor, then resume the named deployment. ArtifactPass reuses only resources whose recorded ownership markers match. It refuses ambiguous same-name resources.
- **Upgrade:** run the pinned new version with `deploy --resume`, review a new approval, then verify one browser upload and one agent handoff.
- **Rollback:** redeploy the previous pinned package against the same recorded bindings. Do not reverse D1 migrations in place.
- **Disconnect Cloudflare authorization:** `pnpm dlx artifactpass deployment auth disconnect --resume artifacts.example.com`. This removes the local grant and attempts Cloudflare revocation. It does not delete the deployment.

Cloudflare owns runtime placement. ArtifactPass deploys with automatic placement and does not ask the admin to choose a region.
