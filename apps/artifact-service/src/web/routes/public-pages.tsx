import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { renderToStaticMarkup } from "react-dom/server";

import { GitHubIcon } from "../components/brand-icons";
import {
  HomePage,
  homepageBootScript,
  homepageInteractionScript,
  publicStyles,
  themeInteractionScript,
} from "./public-homepage";

export type PublicPage = "home" | "privacy" | "terms";

const Navigation = ({ page }: { readonly page: PublicPage }) => (
  <header className="site-header">
    <a className="brand" href="/">
      <span className="brand-mark" aria-hidden="true" />
      ArtifactPass
    </a>
    <div className="header-actions">
      <a className="header-action header-action--github" href="https://github.com/lordelogos/lordebuilds.artifact.pass" aria-label="View ArtifactPass on GitHub" title="GitHub">
        <GitHubIcon aria-hidden="true" focusable="false" />
        <span className="header-action-label">GitHub</span>
      </a>
      <span className="header-divider" aria-hidden="true" />
      <button className="theme-toggle" id="theme-toggle" type="button" aria-label="Switch to light mode" aria-pressed="true">
        <svg className="theme-symbol" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path stroke="none" d="M0 0h24v24H0z" fill="none" />
          <path d="M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0-18 0" />
          <path d="M12 3v18" />
          <path d="m12 9 4.65-4.65" />
          <path d="m12 14.3 7.37-7.37" />
          <path d="m12 19.6 8.85-8.85" />
        </svg>
      </button>
      <span className="header-divider" aria-hidden="true" />
      <a className="header-action header-action--primary" href={page === "home" ? "#install" : "/#install"} aria-label="Set up ArtifactPass" title="Set up">
        <HugeiconsIcon icon={PlusSignIcon} aria-hidden="true" />
        <span className="header-action-label">Set up</span>
      </a>
    </div>
  </header>
);

const Footer = () => (
  <footer className="page-footer">
    <span>ArtifactPass</span>
    <span className="footer-links">
      <a href="/privacy">Privacy</a>
      <a href="/terms">Terms</a>
      <span>Built for agentic handoffs.</span>
    </span>
  </footer>
);

const PrivacyPage = () => (
  <section className="document">
    <p className="eyebrow">Staging service notice</p>
    <h1>Privacy</h1>
    <p className="updated">Last updated 27 August 2026</p>
    <div className="prose">
      <p>This notice describes the ArtifactPass staging service. Google and GitHub authenticate the person connecting an agent or using the human upload interface.</p>
      <h2>Information we process</h2>
      <ul>
        <li>Your provider account identifier and verified email address.</li>
        <li>Uploaded artifact bytes, filename, media type, size, and selected expiry.</li>
        <li>Short-lived authorization records and security rate-limit records.</li>
        <li>Operational request data processed by Cloudflare to deliver and protect the service.</li>
      </ul>
      <h2>How information is used</h2>
      <p>We use this information to authenticate you, approve a scoped agent connection, publish the artifact you selected, deliver its temporary link, enforce expiry, and prevent abuse.</p>
      <h2>Provider credentials</h2>
      <p>A Google or GitHub access token is used during the sign-in callback to retrieve your identity. ArtifactPass does not retain that provider access token. Browser sessions and agent tokens are stored as one-way hashes.</p>
      <h2>Retention and sharing</h2>
      <p>Public artifacts expire after 15, 30, or 60 minutes and are removed by the cleanup process. Browser sessions last up to seven days. Agent publishing connections last up to 30 days unless revoked earlier. A share URL is a bearer capability: anyone who receives it can access the artifact until it expires and may download a copy before then.</p>
      <h2>Staging status</h2>
      <p>This environment is for release evaluation. Do not upload confidential, regulated, or otherwise sensitive material while staging validation is in progress.</p>
    </div>
  </section>
);

const TermsPage = () => (
  <section className="document">
    <p className="eyebrow">Staging service notice</p>
    <h1>Terms</h1>
    <p className="updated">Last updated 27 August 2026</p>
    <div className="prose">
      <p>These staging terms describe the conditions for evaluating ArtifactPass before its public release.</p>
      <h2>Permitted use</h2>
      <p>Use ArtifactPass only for artifacts you are authorized to share. Do not use the service to distribute unlawful, malicious, deceptive, or rights-infringing material.</p>
      <h2>Temporary links</h2>
      <p>Each share URL is a temporary bearer link. Anyone holding it can access the artifact until the stated expiry. You are responsible for choosing recipients and an appropriate lifetime. Expiration prevents later access through ArtifactPass, but it cannot revoke copies a recipient downloaded beforehand.</p>
      <h2>Staging availability</h2>
      <p>The staging service is provided for testing and may change, restart, or become unavailable. Do not rely on it as permanent storage. Expired artifacts have no history or recovery screen.</p>
      <h2>Your account</h2>
      <p>Approve only an agent code that you requested from your own workspace. You may disconnect an agent connection, and access ends automatically when its scoped token expires.</p>
    </div>
  </section>
);

const pageContent = (page: PublicPage) => {
  if (page === "privacy") return <PrivacyPage />;
  if (page === "terms") return <TermsPage />;
  return <HomePage />;
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
    `script-src 'nonce-${nonce}'`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; "),
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const);

export const renderPublicPage = (page: PublicPage, nonce: string): string => {
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
          <Navigation page={page} />
          {pageContent(page)}
          <Footer />
        </div>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeInteractionScript }} />
        {page === "home" && <script nonce={nonce} dangerouslySetInnerHTML={{ __html: homepageInteractionScript }} />}
      </body>
    </html>,
  );
  return `<!doctype html>${markup}`;
};
