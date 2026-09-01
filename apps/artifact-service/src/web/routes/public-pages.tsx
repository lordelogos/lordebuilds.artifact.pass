import { renderToStaticMarkup } from "react-dom/server";

import { PublicFooter, PublicNavigation } from "../components/public-chrome";
import {
  HomePage,
  homepageBootScript,
  homepageInteractionScript,
  publicStyles,
  themeInteractionScript,
} from "./public-homepage";

export type PublicPage = "home" | "privacy" | "terms";

const repositoryUrl = "https://github.com/lordelogos/lordebuilds.artifact.pass";

const EnvironmentNotice = () => (
  <aside className="environment-notice">
    <strong>Staging environment</strong>
    <span>Use synthetic test documents only. This deployment may be reset during release validation.</span>
  </aside>
);

const PrivacyPage = ({ staging }: { readonly staging: boolean }) => (
  <section className="document">
    <p className="eyebrow">Public service policy</p>
    <h1>Privacy</h1>
    <p className="updated">Effective 31 August 2026</p>
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
        <li>Artifact files and their metadata are scheduled for deletion when their 15, 30, or 60 minute lifetime ends. Failed cleanup is retried.</li>
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
    <p className="updated">Effective 31 August 2026</p>
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
    : `pnpm dlx artifactpass@rc --base-url ${url.origin}`;
};

const pageContent = (page: PublicPage, url: URL) => {
  const staging = url.hostname === "staging.artifactpass.com";
  if (page === "privacy") return <PrivacyPage staging={staging} />;
  if (page === "terms") return <TermsPage staging={staging} />;
  return <HomePage installCommand={installCommandFor(url)} />;
};

const pageTitle = (page: PublicPage): string => {
  if (page === "privacy") return "Privacy · ArtifactPass";
  if (page === "terms") return "Terms · ArtifactPass";
  return "ArtifactPass · Pass work between agents";
};

export const publicPageHeaders = (nonce: string) => ({
  "Cache-Control": "private, no-store, max-age=0",
  "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
  "Content-Security-Policy": [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}' 'self'`,
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; "),
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const);

export const renderPublicPage = (page: PublicPage, nonce: string, requestUrl: string): string => {
  const url = new URL(requestUrl);
  const markup = renderToStaticMarkup(
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="referrer" content="no-referrer" />
        <meta name="theme-color" content="#0b0c0e" />
        <title>{pageTitle(page)}</title>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: homepageBootScript }} />
        <style nonce={nonce} dangerouslySetInnerHTML={{ __html: publicStyles }} />
      </head>
      <body>
        <div className="shell">
          <PublicNavigation installHref={page === "home" ? "#install" : "/#install"} />
          {pageContent(page, url)}
          <PublicFooter />
        </div>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeInteractionScript }} />
        {page === "home" && <script nonce={nonce} dangerouslySetInnerHTML={{ __html: homepageInteractionScript }} />}
      </body>
    </html>,
  );
  return `<!doctype html>${markup}`;
};
