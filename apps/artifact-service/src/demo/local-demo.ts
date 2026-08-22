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
import { hashShareToken } from "../server/storage/crypto";

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

const auditRoute = (pathname: string): string => {
  if (pathname === "/api/artifacts") return "/api/artifacts";
  if (pathname === "/api/connection") return "/api/connection";
  const shareRoute = /^\/a\/[A-Za-z0-9_-]{43}\/(manifest|source|derived|raw)$/u.exec(pathname);
  if (shareRoute !== null) return `/a/:capability/${shareRoute[1]}`;
  if (/^\/a\/[A-Za-z0-9_-]{43}$/u.test(pathname)) return "/a/:capability";
  return pathname;
};

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
  const responseFaults = new Map<string, "redirect-manifest" | "malformed-manifest">();
  const requestCounts = new Map<string, number>();
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

      if (!url.pathname.startsWith("/__local-test/")) {
        const key = `${request.method.toUpperCase()} ${auditRoute(url.pathname)}`;
        requestCounts.set(key, (requestCounts.get(key) ?? 0) + 1);
      }

      const shareToken = /^\/a\/([A-Za-z0-9_-]{43})\/manifest$/u.exec(url.pathname)?.[1];
      const responseFault = shareToken === undefined ? undefined : responseFaults.get(shareToken);
      if (request.method === "GET" && responseFault === "redirect-manifest") {
        return new Response(null, {
          status: 302,
          headers: { Location: "https://leak.invalid/artifactpass-eval" },
        });
      }
      if (request.method === "GET" && responseFault === "malformed-manifest") {
        return new Response("{malformed", {
          status: 200,
          headers: { "content-type": "application/json", "Cache-Control": "no-store" },
        });
      }

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
        if (request.method === "GET" && url.pathname === "/__local-test/evidence") {
          const [artifactRows, activeAgentTokens, deviceAuthorizations] = await Promise.all([
            bindings.ARTIFACT_DB.prepare("SELECT COUNT(*) AS count FROM artifacts").first<number>("count"),
            bindings.ARTIFACT_DB.prepare(
              "SELECT COUNT(*) AS count FROM agent_tokens WHERE revoked_at IS NULL AND expires_at > ?",
            ).bind(now()).first<number>("count"),
            bindings.ARTIFACT_DB.prepare("SELECT COUNT(*) AS count FROM device_authorizations")
              .first<number>("count"),
          ]);
          let objects = 0;
          let cursor: string | undefined;
          do {
            const page = await bindings.ARTIFACTS.list(cursor === undefined ? undefined : { cursor });
            objects += page.objects.length;
            cursor = page.truncated ? page.cursor : undefined;
          } while (cursor !== undefined);
          return Response.json({
            requests: Object.fromEntries([...requestCounts.entries()].sort(([left], [right]) =>
              left.localeCompare(right))),
            artifact_rows: artifactRows ?? 0,
            r2_objects: objects,
            active_agent_tokens: activeAgentTokens ?? 0,
            device_authorizations: deviceAuthorizations ?? 0,
          }, { headers: { "Cache-Control": "no-store" } });
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
        if (request.method === "POST" && url.pathname === "/__local-test/revoke") {
          const body = await request.json().catch(() => null) as { share_url?: unknown } | null;
          if (typeof body?.share_url !== "string") {
            return Response.json({ error: "share_url must be a string" }, { status: 400 });
          }
          let shareUrl: URL;
          try {
            shareUrl = new URL(body.share_url);
          } catch {
            return Response.json({ error: "share_url must be a valid URL" }, { status: 400 });
          }
          const token = /^\/a\/([A-Za-z0-9_-]{43})$/u.exec(shareUrl.pathname)?.[1];
          if (shareUrl.origin !== url.origin || token === undefined || shareUrl.search !== "" || shareUrl.hash !== "") {
            return Response.json({ error: "share_url must be a local ArtifactPass capability" }, { status: 400 });
          }
          const repository = new D1ArtifactRepository(bindings.ARTIFACT_DB);
          const artifact = await repository.findActiveByShareTokenHash(await hashShareToken(token));
          if (artifact === null) return new Response(null, { status: 404 });
          await repository.markCleanupPending(artifact.id);
          return Response.json(
            { revoked: true },
            { headers: { "Cache-Control": "no-store" } },
          );
        }
        if (request.method === "POST" && url.pathname === "/__local-test/fault") {
          const body = await request.json().catch(() => null) as {
            share_url?: unknown;
            mode?: unknown;
          } | null;
          if (
            typeof body?.share_url !== "string" ||
            !new Set([
              "corrupt-source",
              "delete-source",
              "redirect-manifest",
              "malformed-manifest",
            ]).has(body.mode as string)
          ) {
            return Response.json({ error: "share_url and a supported fault mode are required" }, { status: 400 });
          }
          let faultUrl: URL;
          try {
            faultUrl = new URL(body.share_url);
          } catch {
            return Response.json({ error: "share_url must be a valid URL" }, { status: 400 });
          }
          const faultToken = /^\/a\/([A-Za-z0-9_-]{43})$/u.exec(faultUrl.pathname)?.[1];
          if (
            faultUrl.origin !== url.origin ||
            faultToken === undefined ||
            faultUrl.search !== "" ||
            faultUrl.hash !== ""
          ) {
            return Response.json({ error: "share_url must be a local ArtifactPass capability" }, { status: 400 });
          }
          const mode = body.mode as "corrupt-source" | "delete-source" | "redirect-manifest" | "malformed-manifest";
          if (mode === "redirect-manifest" || mode === "malformed-manifest") {
            responseFaults.set(faultToken, mode);
          } else {
            const repository = new D1ArtifactRepository(bindings.ARTIFACT_DB);
            const artifact = await repository.findActiveByShareTokenHash(await hashShareToken(faultToken));
            if (artifact === null) return new Response(null, { status: 404 });
            if (mode === "delete-source") {
              await bindings.ARTIFACTS.delete(artifact.objectKey);
            } else {
              const object = await bindings.ARTIFACTS.get(artifact.objectKey);
              if (object === null) return new Response(null, { status: 404 });
              const bytes = new Uint8Array(await object.arrayBuffer());
              if (bytes.byteLength === 0) return Response.json({ error: "source is empty" }, { status: 409 });
              bytes[0] = (bytes[0] ?? 0) ^ 0xff;
              await bindings.ARTIFACTS.put(artifact.objectKey, bytes, {
                ...(object.httpMetadata === undefined ? {} : { httpMetadata: object.httpMetadata }),
                ...(object.customMetadata === undefined ? {} : { customMetadata: object.customMetadata }),
              });
            }
          }
          return Response.json(
            { fault: mode, armed: true },
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
