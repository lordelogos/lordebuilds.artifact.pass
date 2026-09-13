# ArtifactPass

Create temporary links for Markdown, HTML, and PDF files.

## Set up ArtifactPass

Open a terminal in the project where you want to use ArtifactPass, then run:

```sh
pnpm dlx artifactpass@0.1.0
```

Setup asks:

1. Which agent you use.
2. Whether you use public or private ArtifactPass.
3. Your private deployment URL, if you selected private.

ArtifactPass applies this setup and approved file access only to the current project.

Restart your agent after setup. When you first ask it to share a file, choose **Connect ArtifactPass**, sign in, and approve the connection. You do not need to reinstall after connecting.

## Share a file

Ask your agent naturally:

```text
Share ./report.md for 1 day.
```

The agent returns a temporary HTTPS link. Public ArtifactPass supports links lasting 1 hour, 1 day, or 7 days.

## Change the setup

Run this inside the project you want to update:

```sh
pnpm dlx artifactpass@0.1.0 configure
```

Restart your agent after changing the setup.

## Requirements

- Node.js 24 or newer
- pnpm
