# ArtifactPass

Create temporary links for Markdown, HTML, and PDF files. Publish from a browser or an AI agent, then open the same link as a person or through a connected agent.

## Use ArtifactPass four ways

- **Person → person:** upload in the browser and send the link to a teammate or client.
- **Person → agent:** give a browser-created link to a connected agent to read supported source.
- **Agent → person:** ask an agent to publish, then open its link in any browser.
- **Agent → agent:** one agent publishes and another reads the exact supported source.

Only the publisher signs in. Anyone with the temporary link can open the artifact until it expires.

## Set up ArtifactPass

Open a terminal in the project where you want to use ArtifactPass, then run:

```sh
pnpm dlx artifactpass
```

Setup asks:

1. Which agent you use.
2. Whether you use public or private ArtifactPass.
3. Your private deployment URL, if you selected private.

ArtifactPass installs the agent integration once and approves file access only for the current project. When the same integration is used from another project, ArtifactPass asks you to approve that exact project and destination inside the agent. You do not reinstall it.

Restart your agent once after installation. When you first ask it to share a file, review the folder and destination in the local ArtifactPass page, then sign in if that deployment is not connected. Later project approvals take effect in the same agent session.

## Share from an agent

Ask your agent naturally:

```text
Share ./report.md for 1 day.
```

The agent returns a temporary HTTPS link. Public ArtifactPass supports links lasting 1 hour, 1 day, or 7 days.

## Share from the browser

Open [artifactpass.com](https://artifactpass.com), choose a Markdown, HTML, or PDF file, pick its lifetime, and send the resulting link to a person or agent.

## Change the setup

Run this inside the project you want to update:

```sh
pnpm dlx artifactpass configure
```

Running agent sessions read the changed project configuration on the next ArtifactPass tool call.

List or remove exact project grants without disconnecting the deployment:

```sh
pnpm dlx artifactpass workspace list
pnpm dlx artifactpass workspace remove /absolute/path/to/project
```

## Private deployments

Create a private ArtifactPass deployment in your own Cloudflare account:

```sh
pnpm dlx artifactpass deploy --new
```

When setup asks for your domain, enter only the domain, such as `example.com`. Do not enter a URL such as `https://example.com`.

A private deployment stays on the ArtifactPass version that was deployed. It does not update automatically.

To update it, run the latest CLI against its hostname:

```sh
pnpm dlx artifactpass deploy --resume artifacts.example.com
```

ArtifactPass reviews the deployment, applies any required database migrations, and redeploys the Worker. The existing hostname, Cloudflare Access configuration, D1 database, R2 bucket, and stored artifacts are reused.

To test a release candidate instead of the latest stable version, use `artifactpass@rc` in either command.

## Requirements

- Node.js 24 or newer
- pnpm
