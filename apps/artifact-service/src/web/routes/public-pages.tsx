import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { PUBLIC_ALLOWED_EXPIRY_SECONDS } from "artifact-protocol";

import packageMetadata from "../../../../../package.json" with { type: "json" };
import { PublicFooter, PublicNavigation } from "../components/public-chrome.tsx";
import { expiryOptionsForHumans, formatDuration } from "../components/expiry-picker.tsx";
import { PUBLIC_SITE_ORIGIN, publicSiteUrl } from "../public-site.ts";
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
  | "guides"
  | "agent-setup-guide"
  | "private-deployment-guide"
  | "private-teammate-guide"
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

const pagePath = (page: PublicPage): "/" | `/${string}` => {
  if (page === "how-it-works") return "/how-it-works";
  if (page === "for-ai-agents") return "/for-ai-agents";
  if (page === "private-deployments") return "/private-deployments";
  if (page === "guides") return "/guides";
  if (page === "agent-setup-guide") return "/guides/agent-setup";
  if (page === "private-deployment-guide") return "/guides/private-deployment";
  if (page === "private-teammate-guide") return "/guides/private-teammate";
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
  if (page === "guides") {
    return "Choose the ArtifactPass setup guide for an AI agent, a private-deployment administrator, or a private-deployment teammate.";
  }
  if (page === "agent-setup-guide") {
    return "Set up ArtifactPass in an AI agent project, connect the workspace, and publish a first temporary artifact link.";
  }
  if (page === "private-deployment-guide") {
    return "Deploy ArtifactPass in your Cloudflare account, connect a domain safely, and configure publisher access and link lifetimes.";
  }
  if (page === "private-teammate-guide") {
    return "Join a private ArtifactPass deployment from one project, complete publisher access, and verify browser and agent sharing.";
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

const guideSteps = (page: "agent-setup-guide" | "private-deployment-guide" | "private-teammate-guide") => page === "agent-setup-guide"
  ? [
      "Open a terminal in the project",
      "Run the ArtifactPass setup command",
      "Choose the agent and deployment",
      "Restart the agent session",
      "Connect ArtifactPass on first use",
      "Publish a test artifact",
    ]
  : page === "private-deployment-guide" ? [
      "Start the private deployment wizard",
      "Authorize the correct Cloudflare account",
      "Connect example.com to Cloudflare DNS",
      "Choose sign-in and publisher access",
      "Choose the link lifetimes this deployment offers",
      "Review, deploy, and manage artifacts.example.com",
    ]
  : [
      "Confirm publisher access with the administrator",
      "Open the teammate project",
      "Run the private setup command",
      "Restart the agent session",
      "Connect through Cloudflare Access",
      "Verify browser and agent publishing",
    ];

const secondaryPageStructuredData = (page: Exclude<PublicPage, "home">): string => JSON.stringify({
  "@context": "https://schema.org",
  "@graph": [
    page === "agent-setup-guide" || page === "private-deployment-guide" || page === "private-teammate-guide" ? {
      "@type": "HowTo",
      "@id": `${publicSiteUrl(pagePath(page))}#webpage`,
      url: publicSiteUrl(pagePath(page)),
      name: pageTitle(page),
      description: pageDescription(page),
      isPartOf: { "@id": `${PUBLIC_SITE_ORIGIN}/#website` },
      step: guideSteps(page).map((name, index) => ({
        "@type": "HowToStep",
        position: index + 1,
        name,
        url: `${publicSiteUrl(pagePath(page))}#step-${index + 1}`,
      })),
    } : {
      "@type": "WebPage",
      "@id": `${publicSiteUrl(pagePath(page))}#webpage`,
      url: publicSiteUrl(pagePath(page)),
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
          item: publicSiteUrl(pagePath(page)),
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
      <p>Follow the <a href="/guides/agent-setup">illustrated agent setup guide</a>, see <a href="/how-it-works">the full sharing flow</a>, inspect the <a href={repositoryUrl}>open-source repository</a>, or <a href="/upload">share a file from the browser</a>.</p>
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
      <p>Follow the <a href="/guides/private-deployment">administrator deployment guide</a>, share the <a href="/guides/private-teammate">teammate setup guide</a>, see <a href="/security">the security model</a>, or try the <a href="/upload">hosted public service</a> first.</p>
    </div>
  </section>
);

export const guideInteractionScript = `
document.querySelectorAll("[data-copy-command]").forEach((button)=>{
  let resetTimer;
  let copyRun=0;
  let copyPending=false;
  button.addEventListener("click",async()=>{
    if(copyPending)return;
    const command=button.parentElement.querySelector("[data-guide-command]");
    const status=button.parentElement.querySelector("[data-copy-status]");
    if(!command||!status)return;
    const run=++copyRun;
    clearTimeout(resetTimer);
    copyPending=true;
    button.setAttribute("aria-disabled","true");
    try{
      await navigator.clipboard.writeText(command.textContent||"");
      if(run!==copyRun)return;
      button.textContent="Copied";
      status.textContent="Command copied.";
    }catch{
      if(run!==copyRun)return;
      const selection=window.getSelection();
      const range=document.createRange();
      range.selectNodeContents(command);
      selection.removeAllRanges();
      selection.addRange(range);
      button.textContent="Selected";
      status.textContent="Copy unavailable. Command selected for manual copying.";
    }finally{
      copyPending=false;
      button.removeAttribute("aria-disabled");
    }
    resetTimer=setTimeout(()=>{
      if(run!==copyRun)return;
      button.textContent="Copy";
      status.textContent="";
    },1800);
  });
});
`;

const GuidesPage = () => (
  <section className="document guide-hub">
    <p className="eyebrow">ArtifactPass guides</p>
    <h1>Choose the setup path that matches your role.</h1>
    <p className="guide-deck">Set up an agent project, deploy a private ArtifactPass, or join a private deployment someone else manages.</p>
    <div className="guide-cards">
      <a className="guide-card" href="/guides/agent-setup">
        <span>For any supported agent</span>
        <strong>Set up ArtifactPass in a project</strong>
        <p>Choose your MCP client, connect the workspace, and publish a first temporary artifact.</p>
      </a>
      <a className="guide-card" href="/guides/private-deployment">
        <span>For administrators</span>
        <strong>Deploy ArtifactPass on Cloudflare</strong>
        <p>Connect a domain, choose sign-in and publisher access, set lifetimes, and deploy.</p>
      </a>
      <a className="guide-card" href="/guides/private-teammate">
        <span>For teammates</span>
        <strong>Join a private deployment</strong>
        <p>Connect one project to a team deployment and complete Cloudflare Access sign-in.</p>
      </a>
    </div>
  </section>
);

interface GuideImageProps {
  readonly alt: string;
  readonly caption: string;
  readonly src: string;
}

const GuideImage = ({ alt, caption, src }: GuideImageProps) => (
  <figure className="guide-figure">
    <img src={src} alt={alt} width="1200" height="720" loading="lazy" decoding="async" />
    <figcaption>{caption}</figcaption>
  </figure>
);

const GuideCommand = ({ children }: { readonly children: string }) => (
  <div className="guide-command">
    <code data-guide-command="">{children}</code>
    <button type="button" data-copy-command="" aria-label={`Copy command: ${children}`}>Copy</button>
    <span className="visually-hidden" data-copy-status="" aria-live="polite" />
  </div>
);

const GuideNote = ({ children, title }: { readonly children: ReactNode; readonly title: string }) => (
  <aside className="guide-note">
    <strong>{title}</strong>
    <div>{children}</div>
  </aside>
);

const AgentSetupGuidePage = () => (
  <article className="document guide-document">
    <p className="eyebrow">Setup guide</p>
    <h1>Set up ArtifactPass for an AI agent</h1>
    <p className="guide-deck">Install ArtifactPass in one project, connect your agent, and publish a first temporary link.</p>
    <div className="guide-meta">
      <span>About 5 minutes</span>
      <span>Node.js 24+</span>
      <span>pnpm</span>
    </div>

    <nav className="guide-contents" aria-label="On this page">
      <strong>On this page</strong>
      <ol>
        <li><a href="#step-1">Open the project</a></li>
        <li><a href="#step-2">Run setup</a></li>
        <li><a href="#step-3">Choose the agent and deployment</a></li>
        <li><a href="#step-4">Restart the agent</a></li>
        <li><a href="#step-5">Connect on first use</a></li>
        <li><a href="#step-6">Publish a test artifact</a></li>
      </ol>
    </nav>

    <div className="prose guide-prose">
      <p>ArtifactPass setup is project-specific. Run the command inside the project your agent may access. It does not install one global connection across every workspace on your computer.</p>

      <section className="guide-step" id="step-1">
        <span className="guide-step-number">01</span>
        <h2>Open a terminal in the project</h2>
        <p>Move into the project where you want the agent to share Markdown, HTML, or PDF files. ArtifactPass stores the agent registration for this project only.</p>
        <GuideCommand>cd /path/to/your-project</GuideCommand>
      </section>

      <section className="guide-step" id="step-2">
        <span className="guide-step-number">02</span>
        <h2>Run the setup command</h2>
        <GuideCommand>pnpm dlx artifactpass</GuideCommand>
        <p>The installer adds the portable MCP server and ArtifactPass skills. It does not sign you in and it does not upload any file.</p>
        <GuideImage
          src="/guides/agent-setup/run-command.svg"
          alt="A terminal running pnpm dlx artifactpass and displaying the supported agent choices"
          caption="Run setup from the project folder, then choose the agent or editor used in that project."
        />
      </section>

      <section className="guide-step" id="step-3">
        <span className="guide-step-number">03</span>
        <h2>Choose the agent and deployment</h2>
        <p>Select the agent you actually use in this project. The named choices include Codex, Claude Code, Gemini CLI, Kimi Code, Cursor, VS Code with GitHub Copilot, and Antigravity. Use the generic MCP option for another compatible client.</p>
        <p>Choose <strong>Public</strong> to use <code>artifactpass.com</code>. Choose <strong>Private</strong> when a team administrator gave you a private deployment URL.</p>
        <GuideImage
          src="/guides/agent-setup/select-deployment.svg"
          alt="ArtifactPass setup showing Public and Private deployment choices, with artifacts.example.com as the private example"
          caption="Public ArtifactPass needs no URL. A private setup uses the complete URL supplied by its administrator."
        />
        <GuideNote title="Private example">
          <p>If an administrator gives you <code>artifacts.example.com</code>, choose Private and enter <code>https://artifacts.example.com</code>. Include <code>https://</code> here.</p>
        </GuideNote>
      </section>

      <section className="guide-step" id="step-4">
        <span className="guide-step-number">04</span>
        <h2>Restart the agent session</h2>
        <p>Close the current agent session and open a new one in the same project. The new session loads the MCP server and skills that setup installed.</p>
        <p>You only need this restart after installing ArtifactPass or changing the deployment used by the project.</p>
      </section>

      <section className="guide-step" id="step-5">
        <span className="guide-step-number">05</span>
        <h2>Connect ArtifactPass on first use</h2>
        <p>Ask the agent to share a file, or say <strong>Connect ArtifactPass</strong>. ArtifactPass opens the approval page in your browser automatically. If the browser does not open, the agent shows the approval URL so you can open it yourself in the correct browser profile.</p>
        <p>For public ArtifactPass, sign in with Google or GitHub. For a private deployment, complete the Cloudflare Access login configured by the administrator. Confirm that the browser code matches the code shown by the agent before approving.</p>
        <GuideImage
          src="/guides/agent-setup/connect-agent.svg"
          alt="An agent asking to connect ArtifactPass and a browser approval page with a matching code"
          caption="The agent and browser show the same approval code. Approve only a connection you started."
        />
      </section>

      <section className="guide-step" id="step-6">
        <span className="guide-step-number">06</span>
        <h2>Publish a test artifact</h2>
        <p>Ask the connected agent to share a supported file and choose a lifetime.</p>
        <GuideCommand>Share ./report.md for 1 day.</GuideCommand>
        <p>The agent returns one temporary HTTPS link. Opening the link does not require an account. Anyone who has the live link can read that artifact until it expires.</p>
        <GuideImage
          src="/guides/agent-setup/share-result.svg"
          alt="An agent returning a temporary ArtifactPass link after publishing report.md"
          caption="A successful publish returns the filename, expiry, and temporary link."
        />
      </section>

      <section className="guide-finish">
        <p className="eyebrow">You are ready</p>
        <h2>ArtifactPass is connected to this project.</h2>
        <p>Change the deployment used by this project:</p>
        <GuideCommand>pnpm dlx artifactpass configure</GuideCommand>
        <p>Check the installation:</p>
        <GuideCommand>pnpm dlx artifactpass doctor</GuideCommand>
        <p><a href="/guides/private-deployment">Need your own Cloudflare deployment? Follow the private deployment guide.</a></p>
      </section>
    </div>
  </article>
);

const PrivateDeploymentGuidePage = () => (
  <article className="document guide-document">
    <p className="eyebrow">Administrator guide</p>
    <h1>Deploy a private ArtifactPass on Cloudflare</h1>
    <p className="guide-deck">Create <strong>artifacts.example.com</strong> in your Cloudflare account, choose who may publish, and keep control of every resource.</p>
    <div className="guide-meta">
      <span>Administrator</span>
      <span>Cloudflare account</span>
      <span>Domain access</span>
    </div>

    <nav className="guide-contents" aria-label="On this page">
      <strong>On this page</strong>
      <ol>
        <li><a href="#step-1">Start deployment</a></li>
        <li><a href="#step-2">Authorize Cloudflare</a></li>
        <li><a href="#step-3">Connect the domain</a></li>
        <li><a href="#step-4">Choose publisher access</a></li>
        <li><a href="#step-5">Choose link lifetimes</a></li>
        <li><a href="#step-6">Review, deploy, and manage</a></li>
      </ol>
    </nav>

    <div className="prose guide-prose">
      <GuideNote title="Connect, do not transfer">
        <p>Your domain stays registered and renewed at its current registrar. Cloudflare receives DNS authority after you change nameservers. ArtifactPass never receives registrar credentials.</p>
      </GuideNote>

      <section className="guide-step" id="step-1">
        <span className="guide-step-number">01</span>
        <h2>Start a new private deployment</h2>
        <p>Run the wizard from any folder. It saves a local deployment receipt for your operating-system user, so you can safely save and resume later.</p>
        <GuideCommand>pnpm dlx artifactpass deploy --new</GuideCommand>
        <p>The wizard plans a Worker, D1 database, R2 bucket, and Cloudflare Access application in your account. Enter the root domain as <code>example.com</code>, not <code>https://example.com</code>, <code>www.example.com</code>, or a path.</p>
        <GuideImage
          src="/guides/private-deployment/start-deployment.svg"
          alt="ArtifactPass private deployment wizard introducing the Cloudflare resources it will create"
          caption="The wizard explains every Cloudflare resource before it requests authorization."
        />
      </section>

      <section className="guide-step" id="step-2">
        <span className="guide-step-number">02</span>
        <h2>Authorize the correct Cloudflare account</h2>
        <p>ArtifactPass prints the full authorization URL before trying to open a browser. Use that URL in the browser profile signed into the account that should own the deployment.</p>
        <p>Review the requested permissions, choose the intended account, and authorize. If several Cloudflare accounts are available, the terminal asks which one to use.</p>
        <GuideNote title="Browser opened the wrong profile?">
          <p>Close the tab and paste the printed authorization URL into the correct profile. The terminal can continue from the same step.</p>
        </GuideNote>
      </section>

      <section className="guide-step" id="step-3">
        <span className="guide-step-number">03</span>
        <h2>Connect example.com to Cloudflare DNS</h2>
        <p>If <code>example.com</code> is already Active in this account, select it. Otherwise open the Cloudflare link printed by the CLI and choose <strong>Connect a domain</strong>. Do not choose <strong>Transfer a domain</strong>.</p>
        <GuideImage
          src="/guides/private-deployment/connect-domain.svg"
          alt="Cloudflare Add a site screen with Connect a domain highlighted and Transfer a domain marked as incorrect"
          caption="Connecting DNS is enough. Domain registration does not need to move to Cloudflare."
        />
        <p>Let Cloudflare scan the existing DNS records. Before changing nameservers, compare the imported records with your current DNS provider. Check the apex website record, <code>www</code>, email MX records, and verification or mail TXT records.</p>
        <GuideImage
          src="/guides/private-deployment/review-dns.svg"
          alt="A Cloudflare DNS review table showing website, www, email, and TXT records for example.com"
          caption="Add any missing website or email records before the nameserver change."
        />
        <p>Cloudflare assigns two nameservers. At the current registrar, replace the old authoritative nameservers with those exact two values. Do not unlock the domain and do not request a transfer authorization code.</p>
        <GuideImage
          src="/guides/private-deployment/change-nameservers.svg"
          alt="Two Cloudflare nameservers being copied to the current registrar for example.com"
          caption="Only the nameservers change. Registration and renewal stay at the existing registrar."
        />
        <p>Wait until Cloudflare shows <code>example.com</code> as <strong>Active</strong>. Return to the terminal and choose <strong>Check again</strong>. Activation can take time because nameserver changes must propagate.</p>
      </section>

      <section className="guide-step" id="step-4">
        <span className="guide-step-number">04</span>
        <h2>Choose sign-in and publisher access</h2>
        <p><strong>Email verification code</strong> is the simplest option. Then choose how the allow list works:</p>
        <ul>
          <li><strong>Approved company email domains:</strong> enter a domain such as <code>example.com</code>. Everyone with an address on that domain may publish. If your administrator email uses that domain, it is already included. If the administrator uses an address outside that domain and also needs to publish, use the specific-address model instead and include the administrator’s address. Do not approve a shared consumer email domain.</li>
          <li><strong>Specific email addresses:</strong> enter each publisher, such as <code>admin@example.com</code> and <code>teammate@example.net</code>. Include your own administrator email. Setup does not add it automatically.</li>
        </ul>
        <p><strong>Existing company login</strong> uses an identity provider already configured in Cloudflare Zero Trust. Select only providers your teammates can actually use. This branch does not create a separate ArtifactPass email-address allow list.</p>
        <GuideNote title="No invitation email is sent">
          <p>ArtifactPass configures access but does not email teammates. After deployment, send each teammate the private URL and the setup command yourself.</p>
        </GuideNote>
        <GuideImage
          src="/guides/private-deployment/configure-access.svg"
          alt="ArtifactPass questions for publisher access, example email addresses, link lifetimes, and the artifacts.example.com hostname"
          caption="For an address allow list, include the administrator and every teammate who needs to publish."
        />
      </section>

      <section className="guide-step" id="step-5">
        <span className="guide-step-number">05</span>
        <h2>Choose the link lifetimes this deployment offers</h2>
        <p>Select one or more lifetimes. They become the choices people and agents see when publishing:</p>
        <ul>
          {PUBLIC_ALLOWED_EXPIRY_SECONDS.map((seconds, index) => (
            <li key={seconds}>
              <strong>{formatDuration(seconds)}</strong>{[
                " for very short handoffs.",
                " for quick reviews.",
                " for normal same-session work.",
                " for asynchronous review.",
                " for week-long collaboration.",
              ][index]}
            </li>
          ))}
        </ul>
        <p>The maximum supported lifetime is 7 days. ArtifactPass does not offer permanent links. You can change the available choices later by resuming the deployment.</p>
      </section>

      <section className="guide-step" id="step-6">
        <span className="guide-step-number">06</span>
        <h2>Review, deploy, and manage artifacts.example.com</h2>
        <p>The final review shows the hostname, Cloudflare account, domain, sign-in method, allowed people, and link lifetimes. Use the numbered actions instead of restarting the wizard:</p>
        <ul>
          <li><strong>Approve and deploy</strong> when every value is correct.</li>
          <li><strong>Edit hostname</strong> to change the private subdomain.</li>
          <li><strong>Edit sign-in</strong> to change the login method.</li>
          <li><strong>Edit allowed people</strong> to change domains or email addresses when that access model is in use.</li>
          <li><strong>Edit link lifetimes</strong> to change the publishing choices.</li>
          <li><strong>Save and exit</strong> to stop safely and resume later.</li>
        </ul>
        <GuideImage
          src="/guides/private-deployment/review-deployment.svg"
          alt="ArtifactPass deployment review for artifacts.example.com with edit choices and Approve and deploy"
          caption="Nothing deploys until the administrator approves this final summary."
        />
        <p>After approval, the terminal shows live progress while ArtifactPass creates and verifies the Worker, D1 database, R2 bucket, Access application, and custom hostname. Keep it open until the success summary appears.</p>
        <p>Success prints the private URL, teammate command, update command, and local deployment receipt. A private deployment stays on its deployed ArtifactPass version until an administrator approves an update.</p>
        <GuideCommand>pnpm dlx artifactpass deploy --resume artifacts.example.com</GuideCommand>
        <p>Run the resume command later to update the software or edit the hostname, sign-in method, allowed publishers, or link lifetimes. The wizard reloads the saved state and returns to a review before applying changes.</p>
      </section>

      <section className="guide-finish">
        <p className="eyebrow">Deployment complete</p>
        <h2>Now give publishers the teammate guide.</h2>
        <p>Share the deployment URL and <a href="/guides/private-teammate">private teammate setup guide</a>. People who only receive live artifact links do not need publisher access.</p>
      </section>
    </div>
  </article>
);

const PrivateTeammateGuidePage = () => (
  <article className="document guide-document">
    <p className="eyebrow">Teammate guide</p>
    <h1>Join a private ArtifactPass deployment</h1>
    <p className="guide-deck">Connect one project to <strong>artifacts.example.com</strong>, sign in through your team’s Cloudflare Access policy, and verify publishing.</p>
    <div className="guide-meta">
      <span>Teammate</span>
      <span>One project</span>
      <span>Publisher access required</span>
    </div>

    <nav className="guide-contents" aria-label="On this page">
      <strong>On this page</strong>
      <ol>
        <li><a href="#step-1">Confirm access</a></li>
        <li><a href="#step-2">Open the project</a></li>
        <li><a href="#step-3">Run setup</a></li>
        <li><a href="#step-4">Restart the agent</a></li>
        <li><a href="#step-5">Connect and sign in</a></li>
        <li><a href="#step-6">Verify publishing</a></li>
      </ol>
    </nav>

    <div className="prose guide-prose">
      <section className="guide-step" id="step-1">
        <span className="guide-step-number">01</span>
        <h2>Confirm publisher access with the administrator</h2>
        <p>ArtifactPass does not send invitation emails. Ask the administrator for the private deployment URL and confirm which sign-in model applies:</p>
        <ul>
          <li><strong>Email verification code:</strong> your exact email address or its approved company domain must be on the deployment’s allow list.</li>
          <li><strong>Existing company login:</strong> the administrator must have selected a Cloudflare Zero Trust identity provider you can use.</li>
        </ul>
        <GuideNote title="Administrators">
          <p>If access is not configured yet, use the <a href="/guides/private-deployment">private deployment administrator guide</a> and resume the deployment before sending this guide.</p>
        </GuideNote>
      </section>

      <section className="guide-step" id="step-2">
        <span className="guide-step-number">02</span>
        <h2>Open the project your agent may access</h2>
        <p>ArtifactPass setup is project-specific. Open a terminal in the workspace where the agent should publish files.</p>
        <GuideCommand>cd /path/to/your-project</GuideCommand>
      </section>

      <section className="guide-step" id="step-3">
        <span className="guide-step-number">03</span>
        <h2>Run the private setup command</h2>
        <p>Use the complete HTTPS URL supplied by the administrator:</p>
        <GuideCommand>pnpm dlx artifactpass --base-url https://artifacts.example.com</GuideCommand>
        <p>Choose the agent or editor used in this project. The installer supports Codex, Claude Code, Gemini CLI, Kimi Code, Cursor, VS Code with GitHub Copilot, Antigravity, and a generic MCP client.</p>
        <GuideImage
          src="/guides/private-teammate/teammate-setup.svg"
          alt="A teammate running ArtifactPass setup for artifacts.example.com and choosing an MCP-compatible agent"
          caption="The private URL selects the deployment. The agent choice installs the project-level configuration."
        />
      </section>

      <section className="guide-step" id="step-4">
        <span className="guide-step-number">04</span>
        <h2>Restart the agent session</h2>
        <p>Close the current agent session and open a new one in the same project. The new session loads the MCP server and ArtifactPass skills.</p>
      </section>

      <section className="guide-step" id="step-5">
        <span className="guide-step-number">05</span>
        <h2>Connect and complete Cloudflare Access sign-in</h2>
        <p>Ask the agent to share a file, or say <strong>Connect ArtifactPass</strong>. ArtifactPass opens the approval page in your browser automatically. If the browser does not open, the agent shows the approval URL so you can open it yourself in the correct browser profile.</p>
        <p>With <strong>Email verification code</strong>, enter the allowed email and use the one-time code Cloudflare sends. With <strong>Existing company login</strong>, choose the team identity provider and finish its normal sign-in. Confirm the browser code matches the agent before approving.</p>
      </section>

      <section className="guide-step" id="step-6">
        <span className="guide-step-number">06</span>
        <h2>Verify browser and agent publishing</h2>
        <p>Visit <code>https://artifacts.example.com</code> and confirm the upload app opens after sign-in. Then ask the connected agent to publish a supported file.</p>
        <GuideCommand>Share ./report.md for 1 day.</GuideCommand>
        <p>Open the returned link in a signed-out browser window. Anyone with that live link can read the one artifact until it expires, but creating a new link still requires publisher access.</p>
      </section>

      <section className="guide-finish">
        <p className="eyebrow">Setup complete</p>
        <h2>ArtifactPass is connected to this project.</h2>
        <p>Switch this project to another deployment:</p>
        <GuideCommand>pnpm dlx artifactpass configure</GuideCommand>
        <p>Check the installation:</p>
        <GuideCommand>pnpm dlx artifactpass doctor</GuideCommand>
      </section>
    </div>
  </article>
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
  if (page === "guides") return <GuidesPage />;
  if (page === "agent-setup-guide") return <AgentSetupGuidePage />;
  if (page === "private-deployment-guide") return <PrivateDeploymentGuidePage />;
  if (page === "private-teammate-guide") return <PrivateTeammateGuidePage />;
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
  if (page === "guides") return "ArtifactPass Setup Guides · Agents and Private Deployments";
  if (page === "agent-setup-guide") return "Set Up ArtifactPass for an AI Agent · Guide";
  if (page === "private-deployment-guide") return "Private ArtifactPass Deployment Guide · Cloudflare";
  if (page === "private-teammate-guide") return "Join a Private ArtifactPass Deployment · Teammate Guide";
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
    "/guides",
    "/guides/agent-setup",
    "/guides/private-deployment",
    "/guides/private-teammate",
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
- [Setup guides](${PUBLIC_SITE_ORIGIN}/guides): Choose the guide for an agent project, private-deployment administrator, or teammate.
- [Agent setup guide](${PUBLIC_SITE_ORIGIN}/guides/agent-setup): Install ArtifactPass in one project, connect an agent, and publish a first link.
- [Private deployment administrator guide](${PUBLIC_SITE_ORIGIN}/guides/private-deployment): Deploy on Cloudflare, connect a domain, and configure publisher access and lifetimes.
- [Private deployment teammate guide](${PUBLIC_SITE_ORIGIN}/guides/private-teammate): Connect one project to a private deployment and verify publishing.
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
        {(page === "agent-setup-guide" || page === "private-deployment-guide" || page === "private-teammate-guide") && (
          <script nonce={nonce} dangerouslySetInnerHTML={{ __html: guideInteractionScript }} />
        )}
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
