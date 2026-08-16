import { DEFAULT_EXPIRY_POLICY, SUPPORTED_MIME_TYPES } from "artifact-protocol";

const formatLabels = {
  "application/pdf": "PDF",
  "text/html": "HTML",
  "text/markdown": "Markdown",
} as const;

const formatDuration = (seconds: number): string => {
  if (seconds < 60 * 60) return `${seconds / 60} min`;
  return `${seconds / (60 * 60)} hr`;
};

export function App() {
  return (
    <main className="page-shell">
      <section className="intro" aria-labelledby="page-title">
        <p className="eyebrow">Customer-owned · temporary · exact source</p>
        <h1 id="page-title">Share an artifact without giving it a permanent home.</h1>
        <p className="lede">
          Artifact Share keeps HTML, Markdown, and PDF handoffs readable for people and
          coding agents, then removes access at the chosen cutoff.
        </p>
        <div className="contract-grid" aria-label="Artifact Share v1 contract">
          <article>
            <span>Formats</span>
            <strong>{SUPPORTED_MIME_TYPES.map((type) => formatLabels[type]).join(" · ")}</strong>
          </article>
          <article>
            <span>Expiry choices</span>
            <strong>
              {DEFAULT_EXPIRY_POLICY.allowed_seconds.map(formatDuration).join(" · ")}
            </strong>
          </article>
        </div>
        <p className="status-note">
          The authenticated upload surface arrives in the next product slice.
        </p>
      </section>
    </main>
  );
}
