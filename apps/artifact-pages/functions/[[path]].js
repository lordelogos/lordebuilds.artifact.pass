import { PROTOCOL_VERSION } from "artifact-protocol";

import { handleSeoEventRequest } from "../src/seo-analytics.ts";

export const onRequest = async (context) => {
  const pathname = new URL(context.request.url).pathname;
  if (pathname === "/seo-events") {
    return handleSeoEventRequest(context.request, context.env.SEO_ANALYTICS);
  }
  if (pathname.startsWith("/assets/")) {
    const staticAsset = await context.env.ASSETS.fetch(context.request);
    if (staticAsset.status !== 404) return staticAsset;
  }
  try {
    return await context.env.ARTIFACT_APPLICATION.fetch(context.request);
  } catch (error) {
    const requestId = context.request.headers.get("cf-ray") ?? crypto.randomUUID();
    console.error(JSON.stringify({
      event: "artifactpass.pages_proxy_failed",
      request_id: requestId,
      method: context.request.method,
      error_name: error instanceof Error ? error.name : "UnknownError",
    }));
    return Response.json({
      protocol_version: PROTOCOL_VERSION,
      error: {
        code: "internal_error",
        message: "Artifact service failed",
        request_id: requestId,
      },
    }, {
      status: 503,
      headers: {
        "Cache-Control": "no-store",
        "Retry-After": "5",
        "X-ArtifactPass-Request-Id": requestId,
      },
    });
  }
};
