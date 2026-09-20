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

ArtifactPass applies this setup and approved file access only to the current project.

Restart your agent after setup. When you first ask it to share a file, choose **Connect ArtifactPass**, sign in, and approve the connection. You do not need to reinstall after connecting.

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

Restart your agent after changing the setup.

## Private deployments

Create a private ArtifactPass deployment in your own Cloudflare account:

```sh
pnpm dlx artifactpass deploy --new
```

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
