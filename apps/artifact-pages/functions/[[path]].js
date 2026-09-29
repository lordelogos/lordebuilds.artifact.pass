import { handleSeoEventRequest } from "../src/seo-analytics.ts";

export const onRequest = (context) => {
  if (new URL(context.request.url).pathname === "/seo-events") {
    return handleSeoEventRequest(context.request, context.env.SEO_ANALYTICS);
  }
  return context.env.ARTIFACT_APPLICATION.fetch(context.request);
};
