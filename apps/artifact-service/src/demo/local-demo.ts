import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
} from "jose";

import type { ArtifactServiceBindings } from "../server/adapters/cloudflare-bindings";
import { createArtifactApplication } from "../server/index";

const keyId = "artifact-share-local-demo-key";
const issuer = "https://artifact-share-local.cloudflareaccess.com";
const audience = "artifact-share-local-demo";
const demoIdentity = {
  subject: "artifact-share-local-demo-user",
  email: "local-demo@artifact-share.test",
} as const;

const requiresHumanIdentity = (pathname: string): boolean =>
  pathname === "/upload" ||
  pathname.startsWith("/upload/") ||
  pathname === "/connect/approve" ||
  pathname.startsWith("/connect/approve/");

export interface LocalDemoHandler {
  readonly fetch: (
    request: Request,
    bindings: ArtifactServiceBindings,
    executionContext?: ExecutionContext,
  ) => Promise<Response>;
}

export const createLocalDemoHandler = async (): Promise<LocalDemoHandler> => {
  const generated = await generateKeyPair("RS256", { extractable: true });
  const publicJwk = await exportJWK(generated.publicKey);
  const accessJwks = createLocalJWKSet({
    keys: [{ ...publicJwk, alg: "RS256", kid: keyId, use: "sig" }],
  });
  const application = createArtifactApplication({
    accessJwks,
    allowUnauthenticatedUploads: true,
  });
  let cachedIdentity: { readonly assertion: string; readonly refreshAt: number } | undefined;
  let signingIdentity: Promise<{ readonly assertion: string; readonly refreshAt: number }> | undefined;

  const signedIdentity = async (): Promise<string> => {
    const issuedAt = Math.floor(Date.now() / 1000);
    if (cachedIdentity !== undefined && cachedIdentity.refreshAt > issuedAt) {
      return cachedIdentity.assertion;
    }
    signingIdentity ??= (async () => {
      try {
        const expiresAt = issuedAt + 3_600;
        const assertion = await new SignJWT({ email: demoIdentity.email })
          .setProtectedHeader({ alg: "RS256", kid: keyId })
          .setIssuer(issuer)
          .setAudience(audience)
          .setSubject(demoIdentity.subject)
          .setIssuedAt(issuedAt)
          .setExpirationTime(expiresAt)
          .sign(generated.privateKey);
        cachedIdentity = { assertion, refreshAt: expiresAt - 60 };
        return cachedIdentity;
      } finally {
        signingIdentity = undefined;
      }
    })();
    return (await signingIdentity).assertion;
  };

  return {
    fetch: async (request, bindings, executionContext) => {
      const url = new URL(request.url);
      const demoBindings = {
        ...bindings,
        ACCESS_TEAM_DOMAIN: issuer,
        ACCESS_AUD: audience,
      };

      if (!requiresHumanIdentity(url.pathname)) {
        return application.fetch(request, demoBindings, executionContext);
      }

      const headers = new Headers(request.headers);
      headers.set("cf-access-jwt-assertion", await signedIdentity());
      return application.fetch(new Request(request, { headers }), demoBindings, executionContext);
    },
  };
};
