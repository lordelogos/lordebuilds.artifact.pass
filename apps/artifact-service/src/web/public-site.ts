export const PUBLIC_SITE_ORIGIN = "https://artifactpass.com";

export const publicSiteUrl = (path: `/${string}` | "/" = "/"): string =>
  `${PUBLIC_SITE_ORIGIN}${path}`;
