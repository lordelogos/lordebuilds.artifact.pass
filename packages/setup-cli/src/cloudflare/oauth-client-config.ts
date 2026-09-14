import packageMetadata from "../../package.json" with { type: "json" };

export type CloudflareOAuthEnvironment = "staging" | "production";

export interface CloudflareOAuthClientConfiguration {
  readonly environment: CloudflareOAuthEnvironment;
  readonly clientId: string;
}

export const resolveCloudflareOAuthClientConfiguration = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): CloudflareOAuthClientConfiguration => {
  const requestedEnvironment = environment.ARTIFACTPASS_CLOUDFLARE_OAUTH_ENVIRONMENT ??
    "production";
  if (requestedEnvironment !== "staging" && requestedEnvironment !== "production") {
    throw new Error("ARTIFACTPASS_CLOUDFLARE_OAUTH_ENVIRONMENT must be staging or production");
  }
  const packaged = requestedEnvironment === "staging"
    ? packageMetadata.artifactpass.cloudflareOAuth.stagingClientId
    : packageMetadata.artifactpass.cloudflareOAuth.productionClientId;
  const clientId = environment.ARTIFACTPASS_CLOUDFLARE_OAUTH_CLIENT_ID ?? packaged;
  if (!/^[a-f0-9]{32}$/u.test(clientId)) {
    throw new Error(
      requestedEnvironment === "production"
        ? "The production ArtifactPass Cloudflare OAuth client is not published yet"
        : "ArtifactPass Cloudflare OAuth client ID is not configured",
    );
  }
  return { environment: requestedEnvironment, clientId };
};
