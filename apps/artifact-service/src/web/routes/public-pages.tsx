import { renderToStaticMarkup } from "react-dom/server";

export type PublicPage = "home" | "privacy" | "terms";

const styles = `
:root{color:#24241f;background:#f7f5ef;font-family:"Avenir Next",Avenir,"Helvetica Neue",Helvetica,sans-serif;color-scheme:light}
*{box-sizing:border-box}body{margin:0;min-width:320px;min-height:100vh}a{color:inherit}a:focus-visible{outline:3px solid #1f6c9f;outline-offset:3px}
.shell{width:min(940px,100%);margin:0 auto;padding:28px clamp(20px,6vw,72px) 64px}.mast{display:flex;justify-content:space-between;gap:20px;align-items:center;padding-bottom:22px;border-bottom:1px solid #d8d5ca}.brand{font:700 1.08rem Georgia,serif;text-decoration:none}.nav{display:flex;gap:18px;color:#66645e;font-size:.78rem}.nav a{text-underline-offset:4px}
.hero{padding:clamp(64px,12vw,124px) 0 72px}.eyebrow{margin:0 0 20px;color:#706f67;font-size:.72rem;font-weight:700;letter-spacing:.14em;text-transform:uppercase}.hero h1,.document h1{max-width:820px;margin:0;font:400 clamp(3.4rem,9vw,7.4rem)/.91 Georgia,serif;letter-spacing:-.06em}.lede{max-width:670px;margin:30px 0 0;color:#5f5d57;font:1.18rem/1.7 Georgia,serif}.actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:36px}.button{display:inline-block;padding:14px 20px;border:1px solid #24241f;border-radius:5px;font-weight:700;text-decoration:none}.button.primary{background:#24241f;color:#fffefa}
.details{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border-top:1px solid #d8d5ca}.detail{padding:28px 26px 28px 0}.detail+.detail{padding-left:26px;border-left:1px solid #d8d5ca}.detail h2{margin:0 0 10px;font:700 1rem Georgia,serif}.detail p{margin:0;color:#706f67;font-size:.86rem;line-height:1.65}
.document{padding:clamp(54px,9vw,94px) 0}.document h1{font-size:clamp(3.2rem,8vw,6.4rem)}.document .updated{margin:18px 0 44px;color:#706f67;font-size:.78rem}.prose{max-width:720px;font:1rem/1.75 Georgia,serif}.prose h2{margin:38px 0 8px;font:700 1.25rem/1.3 Georgia,serif}.prose p,.prose ul{margin:0 0 18px}.prose li+li{margin-top:8px}
.footer{display:flex;justify-content:space-between;gap:24px;padding-top:22px;border-top:1px solid #d8d5ca;color:#706f67;font-size:.76rem;line-height:1.5}
@media(max-width:680px){.nav{gap:12px}.details{grid-template-columns:1fr}.detail,.detail+.detail{padding:24px 0;border-left:0;border-top:1px solid #d8d5ca}.details .detail:first-child{border-top:0}.footer{display:grid}}
`;

const Navigation = () => (
  <header className="mast">
    <a className="brand" href="/">ArtifactPass</a>
    <nav className="nav" aria-label="Service links">
      <a href="/privacy">Privacy</a>
      <a href="/terms">Terms</a>
    </nav>
  </header>
);

const Footer = () => (
  <footer className="footer">
    <span>ArtifactPass staging</span>
    <span>Short-lived sharing for people and agents.</span>
  </footer>
);

const HomePage = () => (
  <>
    <section className="hero">
      <p className="eyebrow">Temporary artifact sharing</p>
      <h1>Share work with people and agents.</h1>
      <p className="lede">
        ArtifactPass creates short-lived links for Markdown, HTML, and PDF artifacts. People sign in
        to approve their own agent connection. Anyone holding a share link can read it until expiry.
      </p>
      <div className="actions">
        <a className="button primary" href="/upload">Upload an artifact</a>
        <a className="button" href="/auth/sign-in?return_to=%2Fupload">Sign in</a>
      </div>
    </section>
    <section className="details" aria-label="How ArtifactPass works">
      <article className="detail">
        <h2>Short-lived by default</h2>
        <p>Public links last for 15, 30, or 60 minutes and stop resolving at the cutoff.</p>
      </article>
      <article className="detail">
        <h2>Agent-native</h2>
        <p>The MCP and skills publish and read artifacts without requiring a Cloudflare account.</p>
      </article>
      <article className="detail">
        <h2>Explicit connection</h2>
        <p>Google or GitHub verifies the person before an agent receives scoped publishing access.</p>
      </article>
    </section>
  </>
);

const PrivacyPage = () => (
  <section className="document">
    <p className="eyebrow">Staging service notice</p>
    <h1>Privacy</h1>
    <p className="updated">Last updated 27 August 2026</p>
    <div className="prose">
      <p>
        This notice describes the ArtifactPass staging service. Google and GitHub authenticate the
        person connecting an agent or using the human upload interface.
      </p>
      <h2>Information we process</h2>
      <ul>
        <li>Your provider account identifier and verified email address.</li>
        <li>Uploaded artifact bytes, filename, media type, size, and selected expiry.</li>
        <li>Short-lived authorization records and security rate-limit records.</li>
        <li>Operational request data processed by Cloudflare to deliver and protect the service.</li>
      </ul>
      <h2>How information is used</h2>
      <p>
        We use this information to authenticate you, approve a scoped agent connection, publish the
        artifact you selected, deliver its temporary link, enforce expiry, and prevent abuse.
      </p>
      <h2>Provider credentials</h2>
      <p>
        A Google or GitHub access token is used during the sign-in callback to retrieve your identity.
        ArtifactPass does not retain that provider access token. Browser sessions and agent tokens are
        stored as one-way hashes.
      </p>
      <h2>Retention and sharing</h2>
      <p>
        Public artifacts expire after 15, 30, or 60 minutes and are removed by the cleanup process.
        Browser sessions last up to seven days. Agent publishing connections last up to 30 days unless
        revoked earlier. A share URL is a bearer capability: anyone who receives it can access the
        artifact until it expires and may download a copy before then.
      </p>
      <h2>Staging status</h2>
      <p>
        This environment is for release evaluation. Do not upload confidential, regulated, or otherwise
        sensitive material while staging validation is in progress.
      </p>
    </div>
  </section>
);

const TermsPage = () => (
  <section className="document">
    <p className="eyebrow">Staging service notice</p>
    <h1>Terms</h1>
    <p className="updated">Last updated 27 August 2026</p>
    <div className="prose">
      <p>
        These staging terms describe the conditions for evaluating ArtifactPass before its public
        release.
      </p>
      <h2>Permitted use</h2>
      <p>
        Use ArtifactPass only for artifacts you are authorized to share. Do not use the service to
        distribute unlawful, malicious, deceptive, or rights-infringing material.
      </p>
      <h2>Temporary links</h2>
      <p>
        Each share URL is a temporary bearer link. Anyone holding it can access the artifact until the
        stated expiry. You are responsible for choosing recipients and an appropriate lifetime.
        Expiration prevents later access through ArtifactPass, but it cannot revoke copies a recipient
        downloaded beforehand.
      </p>
      <h2>Staging availability</h2>
      <p>
        The staging service is provided for testing and may change, restart, or become unavailable.
        Do not rely on it as permanent storage. Expired artifacts have no history or recovery screen.
      </p>
      <h2>Your account</h2>
      <p>
        Approve only an agent code that you requested from your own workspace. You may disconnect an
        agent connection, and access ends automatically when its scoped token expires.
      </p>
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
  return "ArtifactPass · Temporary artifact sharing";
};

export const publicPageHeaders = (nonce: string) => ({
  "Cache-Control": "private, no-store, max-age=0",
  "Content-Security-Policy": [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
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
        <title>{pageTitle(page)}</title>
        <style nonce={nonce} dangerouslySetInnerHTML={{ __html: styles }} />
      </head>
      <body>
        <main className="shell">
          <Navigation />
          {pageContent(page)}
          <Footer />
        </main>
      </body>
    </html>,
  );
  return `<!doctype html>${markup}`;
};
