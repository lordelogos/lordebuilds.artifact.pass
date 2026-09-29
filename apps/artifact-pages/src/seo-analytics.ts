import { PUBLIC_SITE_ORIGIN, PUBLIC_SITE_PATHS } from "./public-site.ts";

const SEO_EVENT_PATH = "/seo-events";

const publicPagePaths = new Set<string>(PUBLIC_SITE_PATHS);

const eventNames = new Set([
  "page_view",
  "setup_command_copy",
  "upload_open",
  "github_open",
  "npm_open",
  "private_deployment_interest",
]);

const campaignValues = {
  source: new Set([
    "direct",
    "google",
    "bing",
    "duckduckgo",
    "medium",
    "hashnode",
    "linkedin",
    "reddit",
    "devto",
    "x",
    "other-referral",
    "other",
  ]),
  medium: new Set(["", "organic-social", "referral", "community", "other"]),
  campaign: new Set([
    "",
    "artifactpass-introduction",
    "agent-handoffs",
    "temporary-sharing",
    "other",
  ]),
} as const;

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_PER_CLIENT = 60;
const RATE_LIMIT_MAX_CLIENTS = 4_096;
let rateLimitWindowStartedAt = 0;
const rateLimitCounts = new Map<string, number>();

export interface SeoAnalyticsDataset {
  writeDataPoint(point: {
    indexes: string[];
    blobs: string[];
    doubles: number[];
  }): void;
}

const badRequest = () => new Response(null, {
  status: 400,
  headers: { "Cache-Control": "no-store" },
});

const readLimitedJson = async (request: Request): Promise<unknown> => {
  if (request.body === null) return undefined;
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let body = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1_024) {
        await reader.cancel();
        return undefined;
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
};

const normalizedCampaignValue = (
  value: unknown,
  allowed: ReadonlySet<string>,
): string | undefined => {
  if (value === undefined || value === "") return "";
  if (typeof value !== "string") return undefined;
  const normalized = value.toLowerCase();
  return allowed.has(normalized) ? normalized : undefined;
};

const consumeRateLimit = (request: Request): boolean => {
  const now = Date.now();
  if (now - rateLimitWindowStartedAt >= RATE_LIMIT_WINDOW_MS) {
    rateLimitWindowStartedAt = now;
    rateLimitCounts.clear();
  }

  const client = request.headers.get("CF-Connecting-IP");
  if (client === null) return true;
  const count = rateLimitCounts.get(client) ?? 0;
  if (count >= RATE_LIMIT_PER_CLIENT) return false;
  if (count === 0 && rateLimitCounts.size >= RATE_LIMIT_MAX_CLIENTS) return false;
  rateLimitCounts.set(client, count + 1);
  return true;
};

export const handleSeoEventRequest = async (
  request: Request,
  dataset: SeoAnalyticsDataset | undefined,
): Promise<Response> => {
  if (request.method !== "POST") {
    return new Response(null, {
      status: 405,
      headers: { "Allow": "POST", "Cache-Control": "no-store" },
    });
  }

  const requestUrl = new URL(request.url);
  if (requestUrl.origin !== PUBLIC_SITE_ORIGIN || request.headers.get("Origin") !== PUBLIC_SITE_ORIGIN) {
    return new Response(null, {
      status: 403,
      headers: { "Cache-Control": "no-store" },
    });
  }
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  if (fetchSite !== null && fetchSite !== "same-origin") {
    return new Response(null, {
      status: 403,
      headers: { "Cache-Control": "no-store" },
    });
  }
  if (!consumeRateLimit(request)) {
    return new Response(null, {
      status: 429,
      headers: { "Cache-Control": "no-store", "Retry-After": "60" },
    });
  }
  if (Number(request.headers.get("Content-Length") ?? "0") > 1_024) return badRequest();
  const payload = await readLimitedJson(request);
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return badRequest();

  const event = "event" in payload ? payload.event : undefined;
  const page = "page" in payload ? payload.page : undefined;
  const payloadSource = "source" in payload ? payload.source : undefined;
  const payloadMedium = "medium" in payload ? payload.medium : undefined;
  const payloadCampaign = "campaign" in payload ? payload.campaign : undefined;

  const source = normalizedCampaignValue(payloadSource, campaignValues.source);
  const medium = normalizedCampaignValue(payloadMedium, campaignValues.medium);
  const campaign = normalizedCampaignValue(payloadCampaign, campaignValues.campaign);
  if (
    typeof event !== "string"
    || typeof page !== "string"
    || !eventNames.has(event)
    || !publicPagePaths.has(page)
    || source === undefined
    || medium === undefined
    || campaign === undefined
  ) return badRequest();

  if (dataset === undefined) {
    return new Response(null, {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }

  dataset.writeDataPoint({
    indexes: [event],
    blobs: [event, page, source, medium, campaign],
    doubles: [1],
  });

  return new Response(null, {
    status: 204,
    headers: { "Cache-Control": "no-store" },
  });
};

export const seoAnalyticsScript = `(()=>{
if(location.origin!==${JSON.stringify(PUBLIC_SITE_ORIGIN)})return;
if(navigator.webdriver||/(?:bot|crawler|spider|lighthouse)/i.test(navigator.userAgent))return;
const endpoint=${JSON.stringify(SEO_EVENT_PATH)};
const allowed={source:new Set(${JSON.stringify([...campaignValues.source])}),medium:new Set(${JSON.stringify([...campaignValues.medium])}),campaign:new Set(${JSON.stringify([...campaignValues.campaign])})};
const clean=(value,kind,fallback="")=>{const normalized=(value||"").toLowerCase();return allowed[kind].has(normalized)?normalized:value?"other":fallback;};
const parameters=new URLSearchParams(location.search);
const referrer=(()=>{try{return new URL(document.referrer).hostname.toLowerCase();}catch{return"";}})();
const domain=(...parts)=>parts.join(".");
const matchesDomain=(host,...parts)=>{const expected=domain(...parts);return host===expected||host.endsWith("."+expected);};
const referrerSource=referrer.includes("google.")?"google":referrer.includes("bing.")?"bing":referrer.includes("duckduckgo.")?"duckduckgo":matchesDomain(referrer,"medium","com")?"medium":matchesDomain(referrer,"hashnode","com")?"hashnode":matchesDomain(referrer,"linkedin","com")?"linkedin":matchesDomain(referrer,"reddit","com")?"reddit":matchesDomain(referrer,"dev","to")?"devto":matchesDomain(referrer,"x","com")||matchesDomain(referrer,"twitter","com")?"x":referrer?"other-referral":"direct";
const context={page:location.pathname.replace(/\\/+$/,"")||"/",source:clean(parameters.get("utm_source"),"source",referrerSource),medium:clean(parameters.get("utm_medium"),"medium"),campaign:clean(parameters.get("utm_campaign"),"campaign")};
const send=event=>{const body=JSON.stringify({...context,event});if(navigator.sendBeacon&&navigator.sendBeacon(endpoint,body))return;void fetch(endpoint,{method:"POST",headers:{"Content-Type":"application/json"},body,keepalive:true,credentials:"omit"});};
send("page_view");
document.addEventListener("click",event=>{const target=event.target instanceof Element?event.target.closest("a,button"):null;if(!target)return;
if(target.matches("#copy-command,[data-copy-command]")){send("setup_command_copy");return;}
if(target.matches("#open-upload")||target instanceof HTMLAnchorElement&&new URL(target.href,location.href).pathname==="/upload"){send("upload_open");return;}
if(!(target instanceof HTMLAnchorElement))return;const destination=new URL(target.href,location.href);
if(destination.hostname==="github.com"&&destination.pathname==="/lordelogos/lordebuilds.artifact.pass"){send("github_open");return;}
if(destination.hostname===domain("www","npmjs","com")&&destination.pathname==="/package/artifactpass"){send("npm_open");return;}
if(destination.origin===location.origin&&(destination.pathname==="/private-deployments"||destination.pathname==="/guides/private-deployment")){send("private_deployment_interest");}
});
})();`;
