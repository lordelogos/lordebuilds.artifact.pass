import {
  PROTOCOL_MAX_SOURCE_CHUNK_BYTES,
  PROTOCOL_VERSION,
  SUPPORTED_MIME_TYPES,
  protocolLimitsSchema,
} from "artifact-protocol";
import { Hono } from "hono";
import type { JWTVerifyGetKey } from "jose";

import type { ArtifactServiceBindings } from "./adapters/cloudflare-bindings";
import { AgentTokenRepository } from "./auth/agent-token";
import { expireArtifacts } from "./jobs/expire-artifacts";
import { expireIdentityState } from "./jobs/expire-identity-state";
import {
  requireAccess,
  requireAgent,
  type ArtifactHonoEnvironment,
} from "./middleware/authorize";
import { createArtifactsRouter } from "./routes/artifacts";
import { createConnectRouter } from "./routes/connect";
import { PUBLIC_RESPONSE_HEADERS, createSharesRouter } from "./routes/shares";
import { D1ArtifactRepository } from "./storage/artifact-repository";
import { ArtifactApplicationService } from "./storage/artifact-service";
import { ArtifactError } from "./storage/artifact-error";
import { R2ArtifactObjectStore } from "./storage/r2-object-store";
import { artifactPolicyFromBindings } from "./storage/validation";

export interface ArtifactApplicationOptions {
  readonly now?: () => number;
  readonly accessJwks?: JWTVerifyGetKey;
}

const createService = (
  bindings: ArtifactServiceBindings,
  options: ArtifactApplicationOptions,
): ArtifactApplicationService =>
  new ArtifactApplicationService({
    repository: new D1ArtifactRepository(bindings.ARTIFACT_DB),
    objectStore: new R2ArtifactObjectStore(bindings.ARTIFACTS),
    policy: artifactPolicyFromBindings(bindings),
    ...(options.now === undefined ? {} : { now: options.now }),
  });

export const createArtifactApplication = (options: ArtifactApplicationOptions = {}) => {
  const app = new Hono<ArtifactHonoEnvironment>();
  const authorizationOptions = {
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.accessJwks === undefined ? {} : { accessJwks: options.accessJwks }),
  };

  app.get("/health", (context) =>
    context.json({
      service: "lordebuilds.artifacts.share",
      status: "ok",
    }),
  );

  app.get("/upload/policy", requireAccess(authorizationOptions), (context) => {
    const policy = artifactPolicyFromBindings(context.env);
    return context.json(protocolLimitsSchema.parse({
      protocol_version: PROTOCOL_VERSION,
      supported_mime_types: SUPPORTED_MIME_TYPES,
      max_artifact_bytes: policy.maximumArtifactBytes,
      max_source_chunk_bytes: PROTOCOL_MAX_SOURCE_CHUNK_BYTES,
      expiry: {
        maximum_seconds: policy.maximumExpirySeconds,
        allowed_seconds: policy.allowedExpirySeconds,
      },
    }), 200, { "Cache-Control": "private, no-store, max-age=0" });
  });

  app.get("/upload", requireAccess(authorizationOptions), (context) => {
    if (context.env.ASSETS === undefined) {
      throw new ArtifactError("not_found", "Route is unavailable", 404);
    }
    const assetUrl = new URL("/", context.req.url);
    return context.env.ASSETS.fetch(new Request(assetUrl, context.req.raw));
  });

  app.route(
    "/api/artifacts",
    createArtifactsRouter((bindings) => createService(bindings, options), authorizationOptions),
  );
  app.use("/upload/artifacts", requireAccess(authorizationOptions));
  app.route(
    "/upload/artifacts",
    createArtifactsRouter((bindings) => createService(bindings, options), authorizationOptions),
  );
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
    return context.json(
      {
        protocol_version: PROTOCOL_VERSION,
        error: { code: "internal_error", message: "Artifact service failed" },
      },
      500,
      PUBLIC_RESPONSE_HEADERS,
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
