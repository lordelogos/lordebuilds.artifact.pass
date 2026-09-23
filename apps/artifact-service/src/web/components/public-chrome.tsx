import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { ArtifactPassIcon, GitHubIcon, ThemeIcon } from "./brand-icons.tsx";

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
  readonly howHref?: string;
  readonly installHref?: string;
  readonly onThemeToggle?: () => void;
  readonly theme?: PublicTheme;
}

export const PublicNavigation = ({
  howHref = "/#how",
  installHref = "/#install",
  onThemeToggle,
  theme,
}: PublicNavigationProps) => {
  const isLight = theme === "light";
  const targetTheme = isLight ? "dark" : "light";

  return (
    <header className="site-header">
      <a className="brand" href="/">
        <ArtifactPassIcon className="brand-mark" aria-hidden="true" focusable="false" />
        ArtifactPass
      </a>
      <div className="header-actions">
        <a
          className="header-action header-action--how"
          href={howHref}
          aria-label="How ArtifactPass works"
        >
          <span className="header-action-label">How it works</span>
        </a>
        <span className="header-divider header-divider--how" aria-hidden="true" />
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
          <ThemeIcon className="theme-symbol" aria-hidden="true" focusable="false" />
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
