import { PROTOCOL_VERSION } from "artifact-protocol";
import { Hono } from "hono";

import type { ArtifactServiceBindings } from "./adapters/cloudflare-bindings";
import { expireArtifacts } from "./jobs/expire-artifacts";
import { createArtifactsRouter } from "./routes/artifacts";
import { PUBLIC_RESPONSE_HEADERS, createSharesRouter } from "./routes/shares";
import { D1ArtifactRepository } from "./storage/artifact-repository";
import { ArtifactApplicationService } from "./storage/artifact-service";
import { ArtifactError } from "./storage/artifact-error";
import { R2ArtifactObjectStore } from "./storage/r2-object-store";
import { artifactPolicyFromBindings } from "./storage/validation";

export interface ArtifactApplicationOptions {
  readonly now?: () => number;
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
  const app = new Hono<{ Bindings: ArtifactServiceBindings }>();

  app.get("/health", (context) =>
    context.json({
      service: "lordebuilds.artifacts.share",
      status: "ok",
    }),
  );

  app.route(
    "/api/artifacts",
    createArtifactsRouter((bindings) => createService(bindings, options)),
  );
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
    await expireArtifacts({
      repository: new D1ArtifactRepository(env.ARTIFACT_DB),
      objectStore: new R2ArtifactObjectStore(env.ARTIFACTS),
      now: Date.now(),
    });
  },
} satisfies ExportedHandler<ArtifactServiceBindings>;
