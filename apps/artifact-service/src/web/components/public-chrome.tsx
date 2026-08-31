import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { GitHubIcon } from "./brand-icons";

export type PublicTheme = "dark" | "light";

export const readPublicTheme = (): PublicTheme => {
  if (typeof window === "undefined") return "dark";
  const requested = new URLSearchParams(window.location.search).get("theme");
  if (requested === "dark" || requested === "light") return requested;
  const stored = window.localStorage.getItem("artifactpass-theme");
  return stored === "light" ? "light" : "dark";
};

export const applyPublicTheme = (theme: PublicTheme): void => {
  document.documentElement.dataset.theme = theme;
  window.localStorage.setItem("artifactpass-theme", theme);
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute(
    "content",
    theme === "light" ? "#f3f3f0" : "#0b0c0e",
  );
};

export interface PublicNavigationProps {
  readonly installHref?: string;
  readonly onThemeToggle?: () => void;
  readonly theme?: PublicTheme;
}

export const PublicNavigation = ({
  installHref = "/#install",
  onThemeToggle,
  theme,
}: PublicNavigationProps) => {
  const isLight = theme === "light";
  const targetTheme = isLight ? "dark" : "light";

  return (
    <header className="site-header">
      <a className="brand" href="/">
        <span className="brand-mark" aria-hidden="true" />
        ArtifactPass
      </a>
      <div className="header-actions">
        <a
          className="header-action header-action--github"
          href="https://github.com/lordelogos/lordebuilds.artifact.pass"
          aria-label="View ArtifactPass on GitHub"
          title="GitHub"
        >
          <GitHubIcon aria-hidden="true" focusable="false" />
          <span className="header-action-label">GitHub</span>
        </a>
        <span className="header-divider" aria-hidden="true" />
        <button
          className="theme-toggle"
          id="theme-toggle"
          type="button"
          aria-label={`Switch to ${targetTheme} mode`}
          aria-pressed={!isLight}
          title={`Switch to ${targetTheme} mode`}
          onClick={onThemeToggle}
        >
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
        <a className="header-action header-action--primary" href={installHref} aria-label="Set up ArtifactPass" title="Set up">
          <HugeiconsIcon icon={PlusSignIcon} aria-hidden="true" />
          <span className="header-action-label">Set up</span>
        </a>
      </div>
    </header>
  );
};

export const PublicFooter = () => (
  <footer className="page-footer">
    <span>ArtifactPass</span>
    <span className="footer-links">
      <a href="/privacy">Privacy</a>
      <a href="/terms">Terms</a>
      <span>Built for agentic handoffs.</span>
    </span>
  </footer>
);
