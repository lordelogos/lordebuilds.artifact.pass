import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
} from "jose";

import type { ArtifactServiceBindings } from "../server/adapters/cloudflare-bindings";
import { D1ArtifactRepository } from "../server/storage/artifact-repository";
import { R2ArtifactObjectStore } from "../server/storage/r2-object-store";
import { createArtifactApplication } from "../server/index";
import { expireArtifacts } from "../server/jobs/expire-artifacts";

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
  let controlledNow: number | undefined;
  const now = () => controlledNow ?? Date.now();
  const application = createArtifactApplication({
    accessJwks,
    allowUnauthenticatedUploads: true,
    now,
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

      if (url.pathname.startsWith("/__local-test/")) {
        const expectedToken = bindings.LOCAL_TEST_CONTROL_TOKEN;
        if (
          expectedToken === undefined ||
          expectedToken.length < 32 ||
          request.headers.get("x-artifact-test-control") !== expectedToken
        ) {
          return new Response(null, { status: 404 });
        }
        if (request.method === "POST" && url.pathname === "/__local-test/time") {
          const body = await request.json().catch(() => null) as { now_ms?: unknown } | null;
          if (!Number.isSafeInteger(body?.now_ms) || (body?.now_ms as number) < 0) {
            return Response.json({ error: "now_ms must be a non-negative safe integer" }, { status: 400 });
          }
          controlledNow = body?.now_ms as number;
          return Response.json({ now_ms: controlledNow }, { headers: { "Cache-Control": "no-store" } });
        }
        if (request.method === "POST" && url.pathname === "/__local-test/cleanup") {
          const result = await expireArtifacts({
            repository: new D1ArtifactRepository(bindings.ARTIFACT_DB),
            objectStore: new R2ArtifactObjectStore(bindings.ARTIFACTS),
            now: now(),
          });
          const rows = await bindings.ARTIFACT_DB.prepare(
            "SELECT COUNT(*) AS count FROM artifacts",
          ).first<number>("count");
          let objects = 0;
          let cursor: string | undefined;
          do {
            const page = await bindings.ARTIFACTS.list(
              cursor === undefined ? undefined : { cursor },
            );
            objects += page.objects.length;
            cursor = page.truncated ? page.cursor : undefined;
          } while (cursor !== undefined);
          return Response.json(
            { ...result, rows: rows ?? 0, objects },
            { headers: { "Cache-Control": "no-store" } },
          );
        }
        return new Response(null, { status: 404 });
      }

      if (!requiresHumanIdentity(url.pathname)) {
        return application.fetch(request, demoBindings, executionContext);
      }

      const headers = new Headers(request.headers);
      headers.set("cf-access-jwt-assertion", await signedIdentity());
      return application.fetch(new Request(request, { headers }), demoBindings, executionContext);
    },
  };
};
