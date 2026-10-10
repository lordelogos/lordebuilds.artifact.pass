import { handleSeoEventRequest } from "../src/seo-analytics.ts";

export const onRequest = async (context) => {
  if (new URL(context.request.url).pathname === "/seo-events") {
    return handleSeoEventRequest(context.request, context.env.SEO_ANALYTICS);
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
      error: {
        code: "service_unavailable",
        message: "ArtifactPass is temporarily unavailable",
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
