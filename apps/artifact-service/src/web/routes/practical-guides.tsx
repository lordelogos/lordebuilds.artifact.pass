import type { ReactNode } from "react";

import {
  agentSharingContent,
  interactiveHtmlContent,
  javascriptPreviewContent,
  privateCloudflareContent,
  temporarySharingContent,
} from "./practical-guide-content.ts";

export const practicalGuidePageNames = [
  "agent-sharing-guide",
  "temporary-sharing-guide",
  "private-cloudflare-guide",
  "interactive-html-guide",
  "javascript-preview-guide",
] as const;

export type PracticalGuidePageName = typeof practicalGuidePageNames[number];

interface PracticalGuideSection {
  readonly href: `#${string}`;
  readonly label: string;
}

export interface PracticalGuideMetadata {
  readonly category: string;
  readonly deck: string;
  readonly description: string;
  readonly headline: string;
  readonly image: `/${string}`;
  readonly intent: string;
  readonly label: string;
  readonly page: PracticalGuidePageName;
  readonly path: `/guides/${string}`;
  readonly sections: readonly PracticalGuideSection[];
  readonly source: string;
  readonly title: string;
}

const guideRecords: readonly PracticalGuideMetadata[] = [
  {
    page: "agent-sharing-guide",
    path: "/guides/share-files-from-ai-agents",
    label: "AI agent sharing",
    category: "Agent workflows",
    headline: "Share files from AI agents without flattening the work into chat",
    deck: "Let an agent publish a finished Markdown, HTML, or PDF file without flattening it into chat.",
    title: "Share Files From AI Agents | ArtifactPass",
    description: "Learn how to share exact Markdown, HTML, and PDF files from Codex, Claude Code, Gemini CLI, and other MCP-compatible AI agents.",
    intent: "share files from AI agents",
    image: "/guides/practical/viewer-markdown.png",
    source: agentSharingContent,
    sections: [
      { href: "#why", label: "Why chat is not enough" },
      { href: "#ready", label: "Start from a connected project" },
      { href: "#publish", label: "Publish a file" },
      { href: "#handoff", label: "Complete the handoff" },
      { href: "#boundaries", label: "Know the boundaries" },
      { href: "#faq", label: "Questions" },
    ],
  },
  {
    page: "temporary-sharing-guide",
    path: "/guides/temporary-file-sharing",
    label: "Temporary links",
    category: "Temporary sharing",
    headline: "Create an expiring file link without leaving a permanent public URL",
    deck: "Publish one Markdown, HTML, or PDF file for 1 hour, 1 day, or 7 days.",
    title: "Create an Expiring File Link | ArtifactPass",
    description: "Use temporary file sharing to publish Markdown, HTML, and PDF files through links that expire after 1 hour, 1 day, or 7 days.",
    intent: "temporary file sharing",
    image: "/guides/practical/upload-selected-markdown.png",
    source: temporarySharingContent,
    sections: [
      { href: "#problem", label: "Permanent by accident" },
      { href: "#lifetime", label: "Choose a lifetime" },
      { href: "#share", label: "Publish and send" },
      { href: "#expiry", label: "What expiry means" },
      { href: "#fit", label: "When to use something else" },
      { href: "#checklist", label: "Before you send" },
      { href: "#faq", label: "Questions" },
    ],
  },
  {
    page: "private-cloudflare-guide",
    path: "/guides/private-file-sharing-cloudflare",
    label: "Private operations",
    category: "Private infrastructure",
    headline: "Understand what a private ArtifactPass deployment keeps in Cloudflare",
    deck: "See what moves into your account, who can publish, who can read, and how updates work.",
    title: "Private Artifact Sharing on Cloudflare | ArtifactPass",
    description: "Understand how private ArtifactPass deployments use Cloudflare Workers, R2, D1, Access, and a domain you control.",
    intent: "private file sharing on Cloudflare",
    image: "/guides/private-deployment/cloudflare-access-application.png",
    source: privateCloudflareContent,
    sections: [
      { href: "#ownership", label: "What stays in your account" },
      { href: "#access", label: "Who can publish and read" },
      { href: "#updates", label: "How updates work" },
      { href: "#fit", label: "When private deployment fits" },
      { href: "#next", label: "Continue with setup" },
      { href: "#faq", label: "Questions" },
    ],
  },
  {
    page: "interactive-html-guide",
    path: "/guides/share-interactive-html",
    label: "Interactive HTML",
    category: "Interactive HTML",
    headline: "Share an interactive HTML prototype with one link",
    deck: "Turn one self-contained HTML file into a temporary browser link that preserves its source and interaction.",
    title: "Share an Interactive HTML Prototype | ArtifactPass",
    description: "Learn how to share interactive HTML through a temporary preview link without deploying a site or asking the recipient to run it locally.",
    intent: "share interactive HTML",
    image: "/guides/practical/viewer-javascript-enabled.png",
    source: interactiveHtmlContent,
    sections: [
      { href: "#problem", label: "The handoff problem" },
      { href: "#prepare", label: "Prepare the file" },
      { href: "#publish", label: "Publish it" },
      { href: "#recipient", label: "What the recipient sees" },
      { href: "#limits", label: "Important limits" },
      { href: "#faq", label: "Questions" },
    ],
  },
  {
    page: "javascript-preview-guide",
    path: "/guides/safe-javascript-preview",
    label: "JavaScript previews",
    category: "Preview security",
    headline: "Preview HTML with JavaScript safely disabled by default",
    deck: "See what changes when a recipient enables JavaScript and which security boundaries stay in place.",
    title: "Preview HTML With JavaScript Safely Disabled | ArtifactPass",
    description: "Understand how ArtifactPass provides a safe HTML preview with JavaScript disabled until the recipient enables it in an isolated browser frame.",
    intent: "safe HTML preview",
    image: "/guides/practical/viewer-javascript-disabled-mobile.png",
    source: javascriptPreviewContent,
    sections: [
      { href: "#default", label: "The default state" },
      { href: "#enabled", label: "What enabling changes" },
      { href: "#isolation", label: "The security boundary" },
      { href: "#compute", label: "Where the code runs" },
      { href: "#decide", label: "When to enable it" },
      { href: "#faq", label: "Questions" },
    ],
  },
] as const;

const guideByPage = new Map<PracticalGuidePageName, PracticalGuideMetadata>(
  guideRecords.map((guide) => [guide.page, guide]),
);

export const isPracticalGuidePage = (page: string): page is PracticalGuidePageName =>
  guideByPage.has(page as PracticalGuidePageName);

export const practicalGuideMetadata = (page: PracticalGuidePageName): PracticalGuideMetadata => {
  const guide = guideByPage.get(page);
  if (guide === undefined) throw new Error(`Unknown practical guide page: ${page}`);
  return guide;
};

export const practicalGuides = (): readonly PracticalGuideMetadata[] => guideRecords;

const htmlAttribute = (value: string): string => value
  .replaceAll("&", "&amp;")
  .replaceAll('"', "&quot;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;");

const articleBody = (guide: PracticalGuideMetadata): string => {
  return guide.source
    .replaceAll('src="assets/', 'src="/guides/practical/')
    .replaceAll('src="../../../apps/artifact-service/public/guides/private-deployment/', 'src="/guides/private-deployment/')
    .replace(
      /<div class="command">\s*<code>([\s\S]*?)<\/code>\s*<button class="copy-button" type="button" data-copy>Copy<\/button>\s*<\/div>/gu,
      (_value, command: string) => `<div class="guide-command practical-command"><code data-guide-command="">${command}</code><button type="button" data-copy-command="" aria-label="Copy command: ${htmlAttribute(command)}">Copy</button><span class="visually-hidden" data-copy-status="" aria-live="polite"></span></div>`,
    )
    .trim();
};

const GuidePager = ({ page }: { readonly page: PracticalGuidePageName }): ReactNode => {
  const index = guideRecords.findIndex((guide) => guide.page === page);
  const previous = index === 0 ? undefined : guideRecords[index - 1];
  const next = index === guideRecords.length - 1 ? undefined : guideRecords[index + 1];

  return (
    <nav className="guide-pager" aria-label="Practical guide navigation">
      {previous === undefined ? (
        <a className="guide-pager-link" href="/guides">
          <span>All guides</span>
          <strong>Browse the complete guide library</strong>
        </a>
      ) : (
        <a className="guide-pager-link" href={previous.path}>
          <span>Previous practical guide</span>
          <strong>{previous.headline}</strong>
        </a>
      )}
      {next === undefined ? (
        <a className="guide-pager-link guide-pager-link--next" href="/guides">
          <span>All guides</span>
          <strong>Browse the complete guide library</strong>
        </a>
      ) : (
        <a className="guide-pager-link guide-pager-link--next" href={next.path}>
          <span>Next practical guide</span>
          <strong>{next.headline}</strong>
        </a>
      )}
    </nav>
  );
};

export const PracticalGuidePage = ({ page }: { readonly page: PracticalGuidePageName }) => {
  const guide = practicalGuideMetadata(page);

  return (
    <section className="document practical-guide">
      <nav className="guide-trail" aria-label="Guide path">
        <a href="/guides">All guides</a>
        <span aria-hidden="true">/</span>
        <span aria-current="page">{guide.label}</span>
      </nav>

      <nav className="practical-series" aria-label="Practical guide series">
        <span>Practical guides</span>
        {guideRecords.map((item) => (
          <a
            key={item.page}
            href={item.path}
            {...(item.page === page ? { "aria-current": "page" as const } : {})}
          >
            {item.label}
          </a>
        ))}
      </nav>

      <header className="practical-hero">
        <p className="eyebrow">{guide.category}</p>
        <h1>{guide.headline}</h1>
        <p className="guide-deck">{guide.deck}</p>
        <div className="guide-meta" aria-label="Guide details">
          <span>{guide.intent}</span>
          <span>Markdown · HTML · PDF</span>
          <span>Updated 27 September 2026</span>
        </div>
      </header>

      <div className="practical-layout">
        <nav className="practical-contents" aria-label="On this guide">
          <strong>On this guide</strong>
          <ol>
            {guide.sections.map((section) => (
              <li key={section.href}><a href={section.href}>{section.label}</a></li>
            ))}
          </ol>
        </nav>

        <article
          className="practical-article"
          dangerouslySetInnerHTML={{ __html: articleBody(guide) }}
        />
      </div>

      <GuidePager page={page} />
    </section>
  );
};
