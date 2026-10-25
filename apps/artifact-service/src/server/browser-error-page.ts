type BrowserSurface = "approval" | "auth" | "upload" | "share";

const browserSurface = (pathname: string): BrowserSurface | null => {
  if (pathname === "/connect/approve") return "approval";
  if (/^\/auth\/(?:sign-in|login\/[^/]+|callback\/[^/]+|popup\/[^/]+)\/?$/u.test(pathname)) return "auth";
  if (pathname === "/upload") return "upload";
  if (/^\/a\/[^/]+(?:\/[^/]+)?\/?$/u.test(pathname)) return "share";
  return null;
};

export const isBrowserNavigation = (request: Request): boolean => {
  const url = new URL(request.url);
  if (browserSurface(url.pathname) === null) return false;
  if (url.pathname === "/connect/approve" && request.method === "GET" && url.searchParams.get("format") === "html") {
    return true;
  }
  if (url.pathname === "/connect/approve" && request.method === "POST" &&
    request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded") === true) {
    return true;
  }
  if (request.headers.get("sec-fetch-mode") === "navigate") return true;
  return request.headers.get("accept")?.includes("text/html") === true;
};

const escapeHtml = (value: string): string => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

const pageContent = (surface: BrowserSurface, status: number) => {
  if (surface === "approval") return status >= 500 || status === 429 ? {
    title: status === 429 ? "Too many approval attempts." : "Approval is temporarily unavailable.",
    detail: "Check whether your agent connected. If it did not, wait a moment and open its approval link again. If the link no longer works, start a new connection from your agent.",
    action: "Go to ArtifactPass",
    href: "/upload",
  } : {
    title: "This approval link is no longer available.",
    detail: "It may have expired or already been used. Check whether your agent connected. If it did not, start a new connection from your agent and open the new approval link.",
    action: "Go to ArtifactPass",
    href: "/upload",
  };
  if (surface === "auth") return {
    title: status >= 500 ? "Sign-in is temporarily unavailable." : "Sign-in could not be completed.",
    detail: status >= 500
      ? "Please try again in a moment. If this keeps happening, contact the ArtifactPass team."
      : "The sign-in link may have expired, been used, or could not be verified. Start sign-in again. If you were approving an agent, return to it and open a fresh approval link afterward.",
    action: "Start sign-in again",
    href: "/auth/sign-in",
  };
  if (surface === "share") return status === 404 || status === 410 ? {
    title: "This artifact does not exist or has expired.",
    detail: "The link may be incorrect, revoked, or past its cutoff. Ask the sender for a new link if you still need the file.",
    action: "Share a document",
    href: "/upload",
  } : {
    title: status === 429 ? "Too many requests right now." : "This artifact could not be opened right now.",
    detail: status === 429 ? "Wait a few minutes, then open the link again." : "Try opening the link again. If it still fails, ask the sender for a new link.",
    action: "ArtifactPass home",
    href: "/upload",
  };
  return {
    title: status >= 500 ? "ArtifactPass is temporarily unavailable." : "The upload page is unavailable.",
    detail: status >= 500
      ? "Your file has not been uploaded. Try again in a moment; if this continues, contact the ArtifactPass team."
      : "Your file has not been uploaded. If this is a private deployment, ask its administrator to check the app assets. Otherwise, contact the ArtifactPass team.",
    action: status >= 500 ? "Try the upload page again" : "Open setup guides",
    href: status >= 500 ? "/upload" : "https://artifactpass.com/guides",
  };
};

export const browserErrorResponse = (
  request: Request,
  status: number,
  requestId?: string,
): Response | null => {
  if (!isBrowserNavigation(request)) return null;
  const surface = browserSurface(new URL(request.url).pathname);
  if (surface === null) return null;
  const content = pageContent(surface, status);
  const nonce = crypto.randomUUID();
  const reference = requestId === undefined ? "" : `<p class="reference">Reference: ${escapeHtml(requestId)}</p>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${content.title} · ArtifactPass</title><link rel="icon" href="/artifactpass-logo.svg" type="image/svg+xml"><style nonce="${nonce}">:root{font-family:Avenir,"Helvetica Neue",sans-serif;color:#24241f;background:#f7f5ef}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:18px}.card{width:min(520px,100%);padding:clamp(26px,5vw,42px);background:#fffefa;border:1px solid #d8d5ca;border-radius:10px}.brand{font-size:.94rem;font-weight:700;letter-spacing:-.02em}h1{margin:36px 0 16px;font:400 clamp(2rem,7vw,2.8rem)/1.08 Georgia,serif;letter-spacing:-.04em}p{color:#66645e;line-height:1.6}.action{display:inline-block;margin-top:18px;padding:13px 18px;border-radius:5px;background:#24241f;color:#fff;text-decoration:none;font-size:.9rem;font-weight:700}.action:focus-visible{outline:3px solid #1f6c9f;outline-offset:3px}.reference{margin-top:24px;font:12px ui-monospace,monospace;overflow-wrap:anywhere}</style></head><body><main class="card"><div class="brand">ArtifactPass</div><h1>${content.title}</h1><p>${content.detail}</p><a class="action" href="${content.href}">${content.action}</a>${reference}</main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": `default-src 'none'; style-src 'nonce-${nonce}'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors ${surface === "share" ? "'self'" : "'none'"}`,
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
      ...(requestId === undefined ? {} : { "X-ArtifactPass-Request-Id": requestId }),
      ...(status === 429 ? { "Retry-After": "60" } : {}),
    },
  });
};
