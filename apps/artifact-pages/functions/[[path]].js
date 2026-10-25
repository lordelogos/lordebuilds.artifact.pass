import { PROTOCOL_VERSION } from "artifact-protocol";

import { handleSeoEventRequest } from "../src/seo-analytics.ts";

const browserRoute = (pathname) =>
  pathname === "/upload" ||
  pathname === "/connect/approve" ||
  /^\/auth\/(?:sign-in|login\/[^/]+|callback\/[^/]+|popup\/[^/]+)\/?$/u.test(pathname) ||
  /^\/a\/[^/]+(?:\/[^/]+)?\/?$/u.test(pathname);

const browserProxyError = (request, pathname, requestId) => {
  if (!browserRoute(pathname) || !(
    request.headers.get("accept")?.includes("text/html") ||
    request.headers.get("sec-fetch-mode") === "navigate" ||
    (pathname === "/connect/approve" && new URL(request.url).searchParams.get("format") === "html") ||
    (pathname === "/connect/approve" && request.method === "POST" &&
      request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded"))
  )) return null;
  const nonce = crypto.randomUUID();
  const approvalPost = pathname === "/connect/approve" && request.method === "POST";
  const guidance = approvalPost
    ? "The approval did not complete. Check your agent's connection status. If it is not connected, start a new connection and open the new approval link."
    : pathname.startsWith("/auth/callback/")
      ? "Sign-in did not complete. Start it again, then return to the page you were opening. If this keeps happening, contact the ArtifactPass team with the reference below."
    : "We could not load this page. Wait a moment, then try again. If it keeps failing, contact the ArtifactPass team with the reference below.";
  const action = approvalPost
    ? '<a href="/upload">Go to ArtifactPass</a>'
    : pathname.startsWith("/auth/callback/")
      ? '<a href="/auth/sign-in">Start sign-in again</a>'
      : '<a href="">Try again</a>';
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ArtifactPass is temporarily unavailable</title><style nonce="${nonce}">:root{font-family:Avenir,"Helvetica Neue",sans-serif;color:#24241f;background:#f7f5ef}body{min-height:100vh;margin:0;display:grid;place-items:center;padding:18px}.card{box-sizing:border-box;width:min(520px,100%);padding:42px;background:#fffefa;border:1px solid #d8d5ca;border-radius:10px}h1{font:400 2.5rem/1.08 Georgia,serif;letter-spacing:-.04em}p{color:#66645e;line-height:1.6}a{display:inline-block;margin-top:18px;padding:13px 18px;border-radius:5px;background:#24241f;color:white;text-decoration:none;font-weight:700}</style></head><body><main class="card"><strong>ArtifactPass</strong><h1>Temporarily unavailable.</h1><p>${guidance}</p>${action}<p>Reference: ${requestId.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</p></main></body></html>`, {
    status: 503,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": `default-src 'none'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`,
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
      "Retry-After": "5",
      "X-ArtifactPass-Request-Id": requestId,
    },
  });
};

export const onRequest = async (context) => {
  const pathname = new URL(context.request.url).pathname;
  if (pathname === "/seo-events") {
    return handleSeoEventRequest(context.request, context.env.SEO_ANALYTICS);
  }
  if (pathname.startsWith("/assets/")) {
    const staticAsset = await context.env.ASSETS.fetch(context.request);
    const contentType = staticAsset.headers.get("content-type") ?? "";
    // Pages serves the homepage HTML as a successful fallback for unknown asset
    // paths. That response must not shadow the application Worker's JS and CSS.
    if (staticAsset.status !== 404 && !contentType.startsWith("text/html")) {
      return staticAsset;
    }
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
    const browserResponse = browserProxyError(context.request, pathname, requestId);
    if (browserResponse !== null) return browserResponse;
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
