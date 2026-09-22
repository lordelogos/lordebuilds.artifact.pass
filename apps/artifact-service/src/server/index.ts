import {
  PROTOCOL_MAX_SOURCE_CHUNK_BYTES,
  PROTOCOL_VERSION,
  SUPPORTED_MIME_TYPES,
  protocolLimitsSchema,
} from "artifact-protocol";
import { Hono, type Context, type Next } from "hono";
import type { JWTVerifyGetKey } from "jose";

import type { ArtifactServiceBindings } from "./adapters/cloudflare-bindings";
import { AgentTokenRepository } from "./auth/agent-token";
import { expireArtifacts } from "./jobs/expire-artifacts";
import { expireIdentityState } from "./jobs/expire-identity-state";
import {
  requireHuman,
  requireAgent,
  readOptionalHumanIdentity,
  type ArtifactHonoEnvironment,
} from "./middleware/authorize";
import { createArtifactsRouter } from "./routes/artifacts";
import { createConnectRouter } from "./routes/connect";
import { createAuthRouter } from "./routes/auth";
import { PUBLIC_RESPONSE_HEADERS, createSharesRouter } from "./routes/shares";
import { D1ArtifactRepository } from "./storage/artifact-repository";
import { ArtifactApplicationService } from "./storage/artifact-service";
import { ArtifactError } from "./storage/artifact-error";
import { R2ArtifactObjectStore } from "./storage/r2-object-store";
import { artifactPolicyFromBindings } from "./storage/validation";
import { redactRequestPath } from "./observability/redact-request-path";
import {
  PUBLIC_SITE_ORIGIN,
  publicPageHeaders,
  renderRobotsTxt,
  renderPublicPage,
  renderSitemapXml,
  type PublicPage,
} from "../web/routes/public-pages";

export interface ArtifactApplicationOptions {
  readonly now?: () => number;
  readonly accessJwks?: JWTVerifyGetKey;
  readonly allowUnauthenticatedUploads?: boolean;
  readonly oauthFetch?: typeof globalThis.fetch;
  readonly publicUploadWindowMilliseconds?: number;
  readonly publicUploadMaximumRequests?: number;
  readonly publicUploadMaximumBytes?: number;
  readonly publicReadWindowMilliseconds?: number;
  readonly publicReadMaximumRequests?: number;
}

const createService = (
  bindings: ArtifactServiceBindings,
  options: ArtifactApplicationOptions,
): ArtifactApplicationService =>
  new ArtifactApplicationService({
    repository: new D1ArtifactRepository(bindings.ARTIFACT_DB),
    objectStore: new R2ArtifactObjectStore(bindings.ARTIFACTS),
    policy: artifactPolicyFromBindings(bindings),
    provenanceBindings: bindings,
    ...(options.now === undefined ? {} : { now: options.now }),
  });

const protocolLimitsFromBindings = (bindings: ArtifactServiceBindings) => {
  const policy = artifactPolicyFromBindings(bindings);
  return protocolLimitsSchema.parse({
    protocol_version: PROTOCOL_VERSION,
    supported_mime_types: SUPPORTED_MIME_TYPES,
    max_artifact_bytes: policy.maximumArtifactBytes,
    max_source_chunk_bytes: PROTOCOL_MAX_SOURCE_CHUNK_BYTES,
    expiry: {
      maximum_seconds: policy.maximumExpirySeconds,
      allowed_seconds: policy.allowedExpirySeconds,
    },
  });
};

const createNonce = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const preventSearchIndexing = async (
  context: Context<ArtifactHonoEnvironment>,
  next: Next,
) => {
  await next();
  context.header("X-Robots-Tag", "noindex, nofollow, noarchive");
};

export const createArtifactApplication = (options: ArtifactApplicationOptions = {}) => {
  const app = new Hono<ArtifactHonoEnvironment>();
  app.use("/auth/*", preventSearchIndexing);
  app.use("/connect", preventSearchIndexing);
  app.use("/connect/*", preventSearchIndexing);
  app.use("/upload", preventSearchIndexing);
  app.use("/upload/*", preventSearchIndexing);
  const authorizationOptions = {
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.accessJwks === undefined ? {} : { accessJwks: options.accessJwks }),
    ...(options.allowUnauthenticatedUploads === undefined
      ? {}
      : { allowUnauthenticatedUploads: options.allowUnauthenticatedUploads }),
  };
  const publicUploadOptions = {
    ...(options.now === undefined ? {} : { now: options.now }),
    disabled: options.allowUnauthenticatedUploads === true,
    ...(options.publicUploadWindowMilliseconds === undefined
      ? {}
      : { windowMilliseconds: options.publicUploadWindowMilliseconds }),
    ...(options.publicUploadMaximumRequests === undefined
      ? {}
      : { maximumRequests: options.publicUploadMaximumRequests }),
    ...(options.publicUploadMaximumBytes === undefined
      ? {}
      : { maximumBytes: options.publicUploadMaximumBytes }),
  };

  const servePublicPage = (page: PublicPage, context: Context<ArtifactHonoEnvironment>) => {
    const nonce = createNonce();
    const policy = protocolLimitsFromBindings(context.env);
    return new Response(renderPublicPage(page, nonce, context.req.url, {
      deploymentMode: context.env.HUMAN_AUTH_MODE === "artifactpass" ? "public" : "private",
      allowedExpirySeconds: policy.expiry.allowed_seconds,
    }), {
      status: 200,
      headers: {
        ...publicPageHeaders(nonce),
        "Content-Type": "text/html; charset=UTF-8",
      },
    });
  };

  app.get("/", (context) => servePublicPage("home", context));
  app.get("/privacy", (context) => servePublicPage("privacy", context));
  app.get("/terms", (context) => servePublicPage("terms", context));
  app.get("/robots.txt", (context) => {
    const canonical = new URL(context.req.url).origin === PUBLIC_SITE_ORIGIN;
    return context.text(renderRobotsTxt(context.req.url), 200, {
      "Cache-Control": canonical ? "public, max-age=3600" : "private, no-store, max-age=0",
      "Content-Type": "text/plain; charset=UTF-8",
    });
  });
  app.get("/sitemap.xml", (context) => {
    if (new URL(context.req.url).origin !== PUBLIC_SITE_ORIGIN) {
      return context.notFound();
    }
    return context.body(renderSitemapXml(), 200, {
      "Cache-Control": "public, max-age=3600",
      "Content-Type": "application/xml; charset=UTF-8",
    });
  });

  app.get("/health", (context) =>
    context.json({
      service: "lordebuilds.artifacts.share",
      status: "ok",
      ...(context.env.ARTIFACTPASS_DEPLOYMENT_ID === undefined
        ? {}
        : { deployment_id: context.env.ARTIFACTPASS_DEPLOYMENT_ID }),
      human_auth_mode: context.env.HUMAN_AUTH_MODE ?? "cloudflare-access",
      authentication_configured: context.env.HUMAN_AUTH_MODE === "artifactpass"
        ? [
            context.env.GOOGLE_OAUTH_CLIENT_ID,
            context.env.GOOGLE_OAUTH_CLIENT_SECRET,
            context.env.GITHUB_OAUTH_CLIENT_ID,
            context.env.GITHUB_OAUTH_CLIENT_SECRET,
          ].every((value) => typeof value === "string" && value.length > 0)
        : context.env.ACCESS_TEAM_DOMAIN !== undefined && context.env.ACCESS_AUD !== undefined,
      ...(context.env.PDF_PROVENANCE_KEY_ID === undefined
        ? {}
        : { pdf_provenance_key_id: context.env.PDF_PROVENANCE_KEY_ID }),
    }),
  );

  const sessionStatus = async (context: Context<ArtifactHonoEnvironment>) => {
    const authenticated = options.allowUnauthenticatedUploads === true ||
      await readOptionalHumanIdentity(context.req.raw, context.env, authorizationOptions) !== null;
    return context.json({
      authenticated,
      deployment_mode: context.env.HUMAN_AUTH_MODE === "artifactpass" ? "public" : "private",
      policy: protocolLimitsFromBindings(context.env),
    }, 200, { "Cache-Control": "private, no-store, max-age=0" });
  };

  app.get("/session/status", sessionStatus);
  app.get("/upload/preflight", sessionStatus);

  app.route("/auth", createAuthRouter({
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.oauthFetch === undefined ? {} : { oauthFetch: options.oauthFetch }),
  }));

  app.get("/upload/policy", requireHuman(authorizationOptions), (context) => {
    return context.json(protocolLimitsFromBindings(context.env), 200, {
      "Cache-Control": "private, no-store, max-age=0",
    });
  });

  app.get("/upload", requireHuman(authorizationOptions, { redirectToSignIn: true }), (context) => {
    if (context.env.ASSETS === undefined) {
      throw new ArtifactError("not_found", "Route is unavailable", 404);
    }
    const assetUrl = new URL("/", context.req.url);
    return context.env.ASSETS.fetch(new Request(assetUrl, context.req.raw));
  });

  app.route(
    "/api/artifacts",
    createArtifactsRouter(
      (bindings) => createService(bindings, options),
      authorizationOptions,
      publicUploadOptions,
    ),
  );
  app.use("/upload/artifacts", requireHuman(authorizationOptions));
  app.route(
    "/upload/artifacts",
    createArtifactsRouter(
      (bindings) => createService(bindings, options),
      authorizationOptions,
      publicUploadOptions,
    ),
  );
  app.get("/api/connection", requireAgent(authorizationOptions), (context) => {
    const principal = context.get("agentPrincipal");
    return context.json({
      protocol_version: PROTOCOL_VERSION,
      status: "active",
      scope: principal.scope,
      expires_at: principal.expiresAt,
    }, 200, { "Cache-Control": "private, no-store, max-age=0" });
  });
  app.delete("/api/connection", requireAgent(authorizationOptions), async (context) => {
    const revoked = await new AgentTokenRepository(
      context.env.ARTIFACT_DB,
      options.now,
    ).revoke(context.get("agentPrincipal"));
    if (!revoked) throw new ArtifactError("not_found", "Route is unavailable", 404);
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  });
  app.route("/connect", createConnectRouter(authorizationOptions));
  app.route(
    "/a",
    createSharesRouter(
      (bindings) => createService(bindings, options),
      artifactPolicyFromBindings,
      {
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.publicReadWindowMilliseconds === undefined
          ? {}
          : { windowMilliseconds: options.publicReadWindowMilliseconds }),
        ...(options.publicReadMaximumRequests === undefined
          ? {}
          : { maximumRequests: options.publicReadMaximumRequests }),
      },
    ),
  );

  app.onError((error, context) => {
    if (error instanceof ArtifactError) {
      return context.json(
        {
          protocol_version: PROTOCOL_VERSION,
          error: { code: error.code, message: error.message },
        },
        error.status as 400,
        PUBLIC_RESPONSE_HEADERS,
      );
    }
    const requestId = context.req.header("cf-ray") ?? crypto.randomUUID();
    console.error(JSON.stringify({
      event: "artifactpass.request_failed",
      request_id: requestId,
      method: context.req.method,
      path: redactRequestPath(new URL(context.req.url).pathname),
      error_name: error instanceof Error ? error.name : "UnknownError",
      error_message: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
    }));
    return context.json(
      {
        protocol_version: PROTOCOL_VERSION,
        error: { code: "internal_error", message: "Artifact service failed" },
      },
      500,
      { ...PUBLIC_RESPONSE_HEADERS, "X-ArtifactPass-Request-Id": requestId },
    );
  });

  return app;
};

const application = createArtifactApplication();

export default {
  fetch: (request, env, executionContext) => application.fetch(request, env, executionContext),
  scheduled: async (_controller, env) => {
    const now = Date.now();
    await expireArtifacts({
      repository: new D1ArtifactRepository(env.ARTIFACT_DB),
      objectStore: new R2ArtifactObjectStore(env.ARTIFACTS),
      now,
    });
    await expireIdentityState(env.ARTIFACT_DB, now);
  },
} satisfies ExportedHandler<ArtifactServiceBindings>;
