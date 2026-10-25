export const PUBLIC_SITE_ORIGIN = "https://artifactpass.com";

export const PUBLIC_SITE_PATHS = [
  "/",
  "/how-it-works",
  "/for-ai-agents",
  "/private-deployments",
  "/guides",
  "/guides/agent-setup",
  "/guides/private-deployment",
  "/guides/private-teammate",
  "/guides/share-files-from-ai-agents",
  "/guides/temporary-file-sharing",
  "/guides/private-file-sharing-cloudflare",
  "/guides/share-interactive-html",
  "/guides/safe-javascript-preview",
  "/security",
  "/privacy",
  "/terms",
] as const;

export const publicSiteUrl = (path: `/${string}` | "/" = "/"): string =>
  `${PUBLIC_SITE_ORIGIN}${path}`;
