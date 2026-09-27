import { renderToStaticMarkup } from "react-dom/server";
import { PUBLIC_ALLOWED_EXPIRY_SECONDS } from "artifact-protocol";

import packageMetadata from "../../../../../package.json" with { type: "json" };
import { PublicFooter, PublicNavigation } from "../components/public-chrome.tsx";
import { expiryOptionsForHumans } from "../components/expiry-picker.tsx";
import { PUBLIC_SITE_ORIGIN } from "../public-site.ts";
import {
  HomePage,
  homepageBootScript,
  homepageInteractionScript,
  publicStyles,
  themeInteractionScript,
} from "./public-homepage.tsx";

export type PublicPage =
  | "home"
  | "how-it-works"
  | "for-ai-agents"
  | "private-deployments"
  | "security"
  | "privacy"
  | "terms";

export interface PublicPageConfiguration {
  readonly deploymentMode: "public" | "private";
  readonly allowedExpirySeconds: readonly number[];
}

const repositoryUrl = "https://github.com/lordelogos/lordebuilds.artifact.pass";
const rawRepositoryUrl = "https://raw.githubusercontent.com/lordelogos/lordebuilds.artifact.pass/main";
export { PUBLIC_SITE_ORIGIN };
const homepageDescription = "Create expiring links for Markdown, HTML, and PDF files. Share exact work between people and AI agents from the browser, CLI, or MCP.";

const pagePath = (page: PublicPage): string => {
  if (page === "how-it-works") return "/how-it-works";
  if (page === "for-ai-agents") return "/for-ai-agents";
  if (page === "private-deployments") return "/private-deployments";
  if (page === "security") return "/security";
  if (page === "privacy") return "/privacy";
  if (page === "terms") return "/terms";
  return "/";
};

const pageDescription = (page: PublicPage): string => {
  if (page === "how-it-works") {
    return "See how ArtifactPass turns Markdown, HTML, and PDF files into temporary links for people and AI agents.";
  }
  if (page === "for-ai-agents") {
    return "Share exact Markdown, HTML, and PDF files between MCP-compatible AI agents with temporary ArtifactPass links.";
  }
  if (page === "private-deployments") {
    return "Deploy a private ArtifactPass app to your Cloudflare account with your domain, storage, database, and team access rules.";
  }
  if (page === "security") {
    return "Learn how ArtifactPass protects temporary files, share links, agent credentials, HTML previews, and private deployments.";
  }
  if (page === "privacy") {
    return "Learn how ArtifactPass processes identity, temporary artifacts, authorization, and operational data.";
  }
  if (page === "terms") {
    return "Read the terms for using ArtifactPass to create and open temporary artifact links.";
  }
  return homepageDescription;
};

const isCanonicalDeployment = (
  url: URL,
  configuration: PublicPageConfiguration,
): boolean => configuration.deploymentMode === "public" && url.origin === PUBLIC_SITE_ORIGIN;

const homepageStructuredData = JSON.stringify({
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebSite",
      "@id": `${PUBLIC_SITE_ORIGIN}/#website`,
      url: `${PUBLIC_SITE_ORIGIN}/`,
      name: "ArtifactPass",
      description: homepageDescription,
    },
    {
      "@type": "SoftwareApplication",
      "@id": `${PUBLIC_SITE_ORIGIN}/#application`,
      url: `${PUBLIC_SITE_ORIGIN}/`,
      name: "ArtifactPass",
      description: homepageDescription,
      applicationCategory: "DeveloperApplication",
      operatingSystem: "Any",
      browserRequirements: "Requires a modern web browser",
      offers: {
        "@type": "Offer",
        price: "0",
        priceCurrency: "USD",
      },
      featureList: [
        "Temporary links for Markdown, HTML, and PDF files",
        "Browser, command-line, and MCP sharing",
        "Exact source-file handoffs between people and AI agents",
      ],
    },
  ],
}).replaceAll("<", "\\u003c");

const secondaryPageStructuredData = (page: Exclude<PublicPage, "home">): string => JSON.stringify({
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebPage",
      "@id": `${PUBLIC_SITE_ORIGIN}${pagePath(page)}#webpage`,
      url: `${PUBLIC_SITE_ORIGIN}${pagePath(page)}`,
      name: pageTitle(page),
      description: pageDescription(page),
      isPartOf: { "@id": `${PUBLIC_SITE_ORIGIN}/#website` },
    },
    {
      "@type": "BreadcrumbList",
      itemListElement: [
        {
          "@type": "ListItem",
          position: 1,
          name: "ArtifactPass",
          item: `${PUBLIC_SITE_ORIGIN}/`,
        },
        {
          "@type": "ListItem",
          position: 2,
          name: pageTitle(page).replace(" · ArtifactPass", ""),
          item: `${PUBLIC_SITE_ORIGIN}${pagePath(page)}`,
        },
      ],
    },
  ],
}).replaceAll("<", "\\u003c");

const EnvironmentNotice = () => (
  <aside className="environment-notice">
    <strong>Staging environment</strong>
    <span>Use synthetic test documents only. This deployment may be reset during release validation.</span>
  </aside>
);

const HowItWorksPage = () => (
  <section className="document">
    <p className="eyebrow">Temporary file sharing</p>
    <h1>How ArtifactPass works</h1>
    <p className="updated">One file. One temporary link. No formatting lost.</p>
    <div className="prose">
      <p>ArtifactPass moves a finished Markdown, HTML, or PDF file between people and AI agents. It preserves the uploaded bytes, gives the file a browser preview, and removes access after the lifetime you choose.</p>
      <h2>1. Choose the file</h2>
      <p>Upload one Markdown, HTML, or PDF document from the <a href="/upload">browser app</a>, or publish it from an agent workspace through the ArtifactPass CLI, MCP server, or agent skill. The public service accepts files up to 25 MB.</p>
      <h2>2. Choose how long it should live</h2>
      <p>Select 1 hour, 1 day, or 7 days. ArtifactPass stores the file and its metadata only for that temporary handoff. It is not a permanent drive, project history, or backup.</p>
      <h2>3. Send the link</h2>
      <p>The recipient opens the link in a browser. Markdown is rendered, PDFs scale to the viewer, and HTML can be read as source or previewed with JavaScript disabled. If the file contains JavaScript, the recipient can choose whether to enable it in an isolated browser preview.</p>
      <h2>4. The link expires</h2>
      <p>The link is a bearer capability: anyone who has it can open the file until expiry. ArtifactPass schedules the file and metadata for deletion when that time ends.</p>
      <h2>Use it with people or agents</h2>
      <p>A person can share from the browser. An AI agent can publish the exact output it created, return the link, and let the next person or agent inspect the same file without copy-pasting its contents into chat.</p>
      <p><a href="/for-ai-agents">See the AI agent workflow</a>, review <a href="/security">how previews and temporary links are protected</a>, or <a href="/upload">create a temporary link</a>.</p>
    </div>
  </section>
);

const ForAiAgentsPage = () => (
  <section className="document">
    <p className="eyebrow">MCP and agent skills</p>
    <h1>Artifact sharing for AI agents</h1>
    <p className="updated">Pass exact files between agent workspaces and people.</p>
    <div className="prose">
      <p>Chat is useful for discussion, but it is a poor transport for a finished document. ArtifactPass gives MCP-compatible AI agents a narrow tool for publishing and reading Markdown, HTML, and PDF artifacts without flattening the file into a message.</p>
      <h2>What an agent can do</h2>
      <ul>
        <li><strong>Publish one artifact:</strong> upload a completed file and return a temporary link.</li>
        <li><strong>Read a shared artifact:</strong> retrieve a valid ArtifactPass link and inspect the original file.</li>
        <li><strong>Keep the handoff scoped:</strong> use a workspace connection that expires and can be revoked.</li>
      </ul>
      <h2>Works across MCP-compatible clients</h2>
      <p>The setup command asks which agent or editor you use, then writes the project-level configuration that client expects. ArtifactPass supports named flows for Codex, Claude Code, Gemini CLI, Kimi Code, Cursor, VS Code with GitHub Copilot, Antigravity, and a generic MCP client option.</p>
      <h2>Why use a link instead of pasting?</h2>
      <p>The recipient gets the exact file, its filename, media type, size, and remaining lifetime. HTML stays HTML, Markdown stays Markdown, and PDF layout remains intact. That makes reviews and multi-agent handoffs easier to verify.</p>
      <h2>Install for the current project</h2>
      <p>Run <code>pnpm dlx artifactpass</code> inside the project where you want the integration. The CLI connects that workspace to the hosted service and installs the portable MCP and agent skill configuration for the client you select.</p>
      <p>See <a href="/how-it-works">the full sharing flow</a>, inspect the <a href={repositoryUrl}>open-source repository</a>, <a href="/security">review the security model</a>, or <a href="/upload">share a file from the browser</a>.</p>
    </div>
  </section>
);

const PrivateDeploymentsPage = () => (
  <section className="document">
    <p className="eyebrow">Cloudflare deployment</p>
    <h1>Private ArtifactPass deployments</h1>
    <p className="updated">Your domain, access rules, database, and object storage.</p>
    <div className="prose">
      <p>A private deployment places the ArtifactPass application in your Cloudflare account. The app runs on your domain while the public ArtifactPass marketing, privacy, and terms pages remain on artifactpass.com.</p>
      <h2>What gets deployed</h2>
      <ul>
        <li>A Cloudflare Worker for publishing, authentication, and artifact viewing.</li>
        <li>An R2 bucket for the files your users share.</li>
        <li>A D1 database for temporary metadata, access state, and expiry records.</li>
        <li>A Cloudflare Access application for the people allowed to publish.</li>
      </ul>
      <h2>You do not have to transfer your domain</h2>
      <p>You connect a domain you control to Cloudflare by adding its DNS zone and updating nameservers at your registrar. The domain can remain registered with its current registrar. ArtifactPass never receives your registrar credentials.</p>
      <h2>Control who can publish</h2>
      <p>Use approved company email domains or specific email addresses. Include the administrator’s own email when using an address allow list. Anyone with a live ArtifactPass share link can read that artifact until it expires, but publishing remains behind your Access policy.</p>
      <h2>Updates are deliberate</h2>
      <p>A private deployment stays on the ArtifactPass version that created it. Run the deployment update command when you want to move that installation to a newer release.</p>
      <p>Read the <a href={repositoryUrl}>setup and deployment instructions</a>, see <a href="/security">the security model</a>, or try the <a href="/upload">hosted public service</a> first.</p>
    </div>
  </section>
);

const SecurityPage = () => (
  <section className="document">
    <p className="eyebrow">Security model</p>
    <h1>ArtifactPass security</h1>
    <p className="updated">Designed for temporary handoffs, not permanent storage.</p>
    <div className="prose">
      <p>ArtifactPass limits what it stores, how long a share remains available, and what uploaded HTML can do in the viewer. The service is built for intentional, short-lived file handoffs.</p>
      <h2>Temporary bearer links</h2>
      <p>Each share URL is a bearer capability. Anyone holding the URL can read and download the file until expiry, so send it only to intended recipients. ArtifactPass cannot recall copies that a recipient has already downloaded.</p>
      <h2>Private storage and automatic expiry</h2>
      <p>Files are stored in a private Cloudflare R2 bucket. Metadata is kept in D1. Public links last 1 hour, 1 day, or 7 days, and cleanup is retried if an expiry operation does not complete on its first attempt.</p>
      <h2>HTML and JavaScript previews</h2>
      <p>Uploaded HTML opens with JavaScript disabled. If JavaScript is present, the viewer says so and lets the recipient enable or disable it. Enabled code runs inside a sandboxed browser frame with network access blocked; it does not execute on ArtifactPass servers.</p>
      <h2>Scoped authentication</h2>
      <p>Browser sessions and agent workspace connections expire. ArtifactPass stores one-way hashes of bearer credentials rather than their reusable plaintext values. Google and GitHub sign-in request only the identity scopes needed to identify a verified account.</p>
      <h2>Private deployment boundaries</h2>
      <p>Private deployments keep their R2 bucket, D1 database, Worker, and publisher rules in the operator’s Cloudflare account. Cloudflare Access protects publishing while temporary share URLs remain readable until their chosen expiry.</p>
      <p>Read the full <a href="/privacy">privacy policy</a>, review the <a href="/terms">service terms</a>, <a href="/upload">create a temporary link</a>, or report a vulnerability privately through the <a href={repositoryUrl}>GitHub repository</a>.</p>
    </div>
  </section>
);

const PrivacyPage = ({ staging }: { readonly staging: boolean }) => (
  <section className="document">
    <p className="eyebrow">Public service policy</p>
    <h1>Privacy</h1>
    <p className="updated">Effective 11 September 2026</p>
    {staging && <EnvironmentNotice />}
    <div className="prose">
      <p>This policy explains how the hosted ArtifactPass service processes information when you sign in, connect an agent workspace, upload a document, or open a temporary artifact link. It does not govern private deployments operated by another organization.</p>
      <h2>Information ArtifactPass processes</h2>
      <ul>
        <li><strong>Identity:</strong> your Google or GitHub account identifier and verified email address.</li>
        <li><strong>Artifacts:</strong> the exact file you submit, its filename, media type, size, integrity metadata, and selected expiry.</li>
        <li><strong>Authorization:</strong> one-way hashes of browser sessions, device approvals, agent tokens, and temporary share capabilities.</li>
        <li><strong>Operations:</strong> rate-limit records and request information needed to deliver, secure, and diagnose the service. Cloudflare may process IP addresses, TLS, browser, and request metadata as part of its infrastructure and security services.</li>
      </ul>
      <h2>Google and GitHub sign-in</h2>
      <p>Google scopes are limited to <code>openid</code> and <code>email</code>. GitHub scopes are limited to <code>read:user</code> and <code>user:email</code>. ArtifactPass uses the provider access token only during the sign-in callback to retrieve your account identifier and verified email address. It does not retain the provider access token and never receives your provider password.</p>
      <h2>How information is used</h2>
      <p>ArtifactPass uses this information only to authenticate you, approve a scoped workspace connection, publish the file you selected, deliver its temporary link, enforce expiry, prevent abuse, and operate the service. We do not sell your personal information, run advertising profiles, or use artifact contents to train machine-learning models.</p>
      <h2>Temporary sharing</h2>
      <p>A share URL is a bearer capability. Anyone who receives it can view and download the artifact until its stated expiry. Recipients may keep copies they download, so expiry cannot recall a file after it has left ArtifactPass.</p>
      <h2>Retention</h2>
      <ul>
        <li>Artifact files and their metadata are scheduled for deletion when their selected lifetime ends. Public links can last 1 hour, 1 day, or 7 days. Failed cleanup is retried.</li>
        <li>Browser sessions expire after seven days.</li>
        <li>Agent publishing connections expire after 30 days unless revoked earlier.</li>
        <li>OAuth transactions, device codes, and most rate-limit records expire after approximately ten minutes.</li>
      </ul>
      <h2>Service providers and disclosure</h2>
      <p>ArtifactPass runs on Cloudflare Workers, D1, and R2. Google and GitHub provide optional sign-in. Information may also be disclosed when required by law, to protect the service or its users, or during a legitimate transfer of the service with equivalent privacy obligations.</p>
      <h2>Security</h2>
      <p>ArtifactPass uses short-lived links, scoped agent credentials, hashed bearer tokens, private object storage, strict browser isolation, and automated expiry. No internet service can guarantee absolute security. Report suspected vulnerabilities through the repository’s private vulnerability reporting channel and never include a live share link or credential.</p>
      <h2>Questions and changes</h2>
      <p>Privacy questions can be raised through the <a href={repositoryUrl}>ArtifactPass GitHub repository</a>. Material policy changes will be reflected by updating the effective date on this page.</p>
    </div>
  </section>
);

const TermsPage = ({ staging }: { readonly staging: boolean }) => (
  <section className="document">
    <p className="eyebrow">Public service terms</p>
    <h1>Terms</h1>
    <p className="updated">Effective 11 September 2026</p>
    {staging && <EnvironmentNotice />}
    <div className="prose">
      <p>These terms govern use of the hosted ArtifactPass service. By using it, you agree to these terms. Private deployments are governed by their operator. Open-source software in the ArtifactPass repository remains governed by its stated Apache-2.0 license.</p>
      <h2>The service</h2>
      <p>ArtifactPass creates temporary links for one Markdown, HTML, or PDF artifact at a time. It is not permanent storage, a backup service, or a confidential document vault. There is no artifact history or recovery screen after expiry.</p>
      <h2>Acceptable use</h2>
      <p>You may submit only material you are authorized to use and share. Do not use ArtifactPass to distribute malware, unlawful or deceptive content, rights-infringing material, secrets obtained without authorization, or content intended to harm the service, its infrastructure, or another person.</p>
      <h2>Your responsibilities</h2>
      <p>You are responsible for the document you choose, its recipients, and its lifetime. Approve only an agent code that you requested from your own workspace. Keep share URLs and workspace credentials appropriate to the sensitivity of your work.</p>
      <h2>Temporary bearer links</h2>
      <p>Each share URL is a temporary bearer link. Anyone holding it can access and download the artifact until expiry. Expiration prevents later access through ArtifactPass, but it cannot revoke copies already downloaded or shared elsewhere.</p>
      <h2>Availability and changes</h2>
      <p>The hosted service may change, be rate-limited, be suspended for security or abuse prevention, or become temporarily unavailable. Features may be added, removed, or corrected as the product develops. Material changes to these terms will update the effective date above.</p>
      <h2>Disclaimer</h2>
      <p>To the maximum extent permitted by law, the hosted service is provided as available and without warranties of uninterrupted operation, fitness for a particular purpose, or preservation of submitted material.</p>
      <h2>Limitation of liability</h2>
      <p>To the maximum extent permitted by law, ArtifactPass and its maintainers are not liable for indirect, incidental, special, consequential, or exemplary losses arising from use of the hosted service, loss of access, or a recipient’s handling of a shared artifact.</p>
      <h2>Questions</h2>
      <p>Questions about these terms can be raised through the <a href={repositoryUrl}>ArtifactPass GitHub repository</a>. Security reports must use private vulnerability reporting.</p>
    </div>
  </section>
);

const installCommandFor = (url: URL): string => {
  return url.hostname === "artifactpass.com"
    ? "pnpm dlx artifactpass"
    : `pnpm dlx artifactpass@${packageMetadata.version} --base-url ${url.origin}`;
};

const pageContent = (page: PublicPage, url: URL, configuration: PublicPageConfiguration) => {
  const staging = url.hostname === "staging.artifactpass.com";
  if (page === "how-it-works") return <HowItWorksPage />;
  if (page === "for-ai-agents") return <ForAiAgentsPage />;
  if (page === "private-deployments") return <PrivateDeploymentsPage />;
  if (page === "security") return <SecurityPage />;
  if (page === "privacy") return <PrivacyPage staging={staging} />;
  if (page === "terms") return <TermsPage staging={staging} />;
  return <HomePage
    installCommand={installCommandFor(url)}
    expiryOptions={expiryOptionsForHumans(
      configuration.allowedExpirySeconds,
      configuration.deploymentMode,
    )}
  />;
};

const pageTitle = (page: PublicPage): string => {
  if (page === "how-it-works") return "How ArtifactPass Works · Temporary File Sharing";
  if (page === "for-ai-agents") return "Artifact Sharing for AI Agents · ArtifactPass";
  if (page === "private-deployments") return "Private ArtifactPass Deployments on Cloudflare";
  if (page === "security") return "ArtifactPass Security · Temporary Links and Safe Previews";
  if (page === "privacy") return "Privacy · ArtifactPass";
  if (page === "terms") return "Terms · ArtifactPass";
  return "ArtifactPass | Temporary File Sharing for People and AI Agents";
};

export const renderRobotsTxt = (requestUrl: string): string => {
  const url = new URL(requestUrl);
  if (url.origin !== PUBLIC_SITE_ORIGIN) return "User-agent: *\nDisallow: /\n";
  return `User-agent: *\nAllow: /\n\nSitemap: ${PUBLIC_SITE_ORIGIN}/sitemap.xml\n`;
};

export const renderSitemapXml = (): string => {
  const urls = ([
    "/",
    "/how-it-works",
    "/for-ai-agents",
    "/private-deployments",
    "/security",
    "/privacy",
    "/terms",
  ] as const)
    .map((path) => `  <url><loc>${PUBLIC_SITE_ORIGIN}${path}</loc></url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
};

export const renderLlmsTxt = (): string => `# ArtifactPass

ArtifactPass creates temporary links for Markdown, HTML, and PDF files so people and AI agents can hand off exact work without losing formatting.

## Use ArtifactPass

- [ArtifactPass homepage](${PUBLIC_SITE_ORIGIN}/): Learn what ArtifactPass does and create a temporary link.
- [How ArtifactPass works](${PUBLIC_SITE_ORIGIN}/how-it-works): The browser and agent sharing flow, from upload to expiry.
- [Artifact sharing for AI agents](${PUBLIC_SITE_ORIGIN}/for-ai-agents): MCP, agent skills, supported clients, and exact-file handoffs.
- [Private deployments](${PUBLIC_SITE_ORIGIN}/private-deployments): Run ArtifactPass in your own Cloudflare account and domain.
- [Security](${PUBLIC_SITE_ORIGIN}/security): Temporary links, storage, authentication, and isolated HTML previews.
- [ArtifactPass repository](${repositoryUrl}): Install the CLI, MCP server, or agent skills and inspect the source.
- [Privacy policy](${PUBLIC_SITE_ORIGIN}/privacy): How the hosted service handles identity, artifacts, and operational data.
- [Terms of service](${PUBLIC_SITE_ORIGIN}/terms): Rules for using the hosted service.

## Agent capabilities

- [Share an artifact](${rawRepositoryUrl}/plugins/artifactpass/skills/share-artifact/SKILL.md): Publish one Markdown, HTML, or PDF artifact and return its temporary link.
- [Read a shared artifact](${rawRepositoryUrl}/plugins/artifactpass/skills/read-shared-artifact/SKILL.md): Retrieve and inspect a valid ArtifactPass handoff link.
`;

export const renderAiCatalogJson = (): string => `${JSON.stringify({
  specVersion: "1.0",
  host: {
    displayName: "ArtifactPass",
    identifier: "did:web:artifactpass.com",
    documentationUrl: repositoryUrl,
    logoUrl: `${PUBLIC_SITE_ORIGIN}/artifactpass-logo.svg`,
  },
  entries: [
    {
      identifier: "urn:air:artifactpass.com:skill:share-artifact",
      displayName: "Share an artifact",
      type: 'text/markdown; profile="urn:air:agent-skills"',
      url: `${rawRepositoryUrl}/plugins/artifactpass/skills/share-artifact/SKILL.md`,
      description: "Publish one Markdown, HTML, or PDF artifact and return its temporary ArtifactPass link.",
      tags: ["artifact-sharing", "handoff", "temporary-link"],
      capabilities: ["ShareArtifact"],
      representativeQueries: [
        "Share this HTML, Markdown, or PDF file with another person or AI agent.",
        "Create a temporary ArtifactPass link for this artifact.",
      ],
    },
    {
      identifier: "urn:air:artifactpass.com:skill:read-shared-artifact",
      displayName: "Read a shared artifact",
      type: 'text/markdown; profile="urn:air:agent-skills"',
      url: `${rawRepositoryUrl}/plugins/artifactpass/skills/read-shared-artifact/SKILL.md`,
      description: "Retrieve and inspect a valid ArtifactPass handoff link.",
      tags: ["artifact-reading", "handoff", "temporary-link"],
      capabilities: ["ReadSharedArtifact"],
      representativeQueries: [
        "Open and inspect this ArtifactPass link.",
        "Read the file shared through this ArtifactPass handoff.",
      ],
    },
  ],
}, null, 2)}\n`;

export const publicPageHeaders = (nonce: string) => ({
  "Cache-Control": "private, no-store, max-age=0",
  "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
  "Content-Security-Policy": [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}' 'self' https://static.cloudflareinsights.com`,
    "connect-src 'self' https://cloudflareinsights.com",
    "img-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; "),
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const);

const renderPage = (
  page: PublicPage,
  nonce: string | undefined,
  requestUrl: string,
  configuration: PublicPageConfiguration,
): string => {
  const url = new URL(requestUrl);
  const indexable = isCanonicalDeployment(url, configuration);
  const title = pageTitle(page);
  const description = pageDescription(page);
  const canonicalUrl = `${PUBLIC_SITE_ORIGIN}${pagePath(page)}`;
  const markup = renderToStaticMarkup(
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="referrer" content="no-referrer" />
        <meta name="theme-color" content="#0b0c0e" />
        <meta name="description" content={description} />
        <meta
          name="robots"
          content={indexable ? "index, follow, max-image-preview:large" : "noindex, nofollow, noarchive"}
        />
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="ArtifactPass" />
        <meta property="og:title" content={title} />
        <meta property="og:description" content={description} />
        <meta property="og:url" content={indexable ? canonicalUrl : url.origin + pagePath(page)} />
        <meta name="twitter:card" content="summary" />
        <meta name="twitter:title" content={title} />
        <meta name="twitter:description" content={description} />
        {indexable && <link rel="canonical" href={canonicalUrl} />}
        {indexable && page === "home" && <link rel="ai-catalog" href="/.well-known/ai-catalog.json" />}
        {indexable && page === "home" && <link rel="ard" href="/.well-known/ard.json" />}
        <link rel="icon" href="/artifactpass-logo.svg" type="image/svg+xml" />
        <title>{title}</title>
        {indexable && (
          <script
            type="application/ld+json"
            dangerouslySetInnerHTML={{
              __html: page === "home" ? homepageStructuredData : secondaryPageStructuredData(page),
            }}
          />
        )}
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: homepageBootScript }} />
        <style nonce={nonce} dangerouslySetInnerHTML={{ __html: publicStyles }} />
      </head>
      <body>
        <div className="shell">
          <PublicNavigation
            howHref={page === "home" ? "#how" : "/#how"}
            installHref={page === "home" ? "#install" : "/#install"}
          />
          {pageContent(page, url, configuration)}
          <PublicFooter />
        </div>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeInteractionScript }} />
        {page === "home" && <script nonce={nonce} dangerouslySetInnerHTML={{ __html: homepageInteractionScript }} />}
      </body>
    </html>,
  );
  return `<!doctype html>${markup}`;
};

export const renderPublicPage = (
  page: PublicPage,
  nonce: string,
  requestUrl: string,
  configuration: PublicPageConfiguration,
): string => renderPage(page, nonce, requestUrl, configuration);

export const renderStaticPublicPage = (page: PublicPage): string => renderPage(
  page,
  undefined,
  `${PUBLIC_SITE_ORIGIN}${pagePath(page)}`,
  {
    deploymentMode: "public",
    allowedExpirySeconds: PUBLIC_ALLOWED_EXPIRY_SECONDS,
  },
);
