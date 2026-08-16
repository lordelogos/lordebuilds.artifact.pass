import {
  SUPPORTED_MIME_TYPES,
  protocolLimitsSchema,
  uploadResponseSchemaForOrigin,
  type ExtractionMetadata,
  type ProtocolLimits,
  type UploadResponse,
} from "artifact-protocol";
import { useEffect, useMemo, useState } from "react";

import { ExpiryPicker } from "../components/expiry-picker";
import { FileDrop } from "../components/file-drop";

type UploadStage = "idle" | "validating" | "extracting" | "uploading" | "complete";

type UploadPolicy = ProtocolLimits;
type UploadResult = UploadResponse;

const extensionByMime = {
  "text/html": new Set(["html", "htm"]),
  "text/markdown": new Set(["md", "markdown"]),
  "application/pdf": new Set(["pdf"]),
} as const;

export const validateBrowserFile = async (
  file: File,
  maximumBytes: number,
): Promise<string | null> => {
  if (!SUPPORTED_MIME_TYPES.includes(file.type as never)) {
    return "Only HTML, Markdown, and PDF files are supported.";
  }
  if (file.size === 0) return "Choose a file that is not empty.";
  if (file.size > maximumBytes) return "This file is larger than the deployment allows.";
  const mimeType = file.type as keyof typeof extensionByMime;
  const extension = file.name.toLowerCase().split(".").pop() ?? "";
  if (!extensionByMime[mimeType].has(extension)) {
    return "The filename extension does not match the file type.";
  }
  if (mimeType === "application/pdf") {
    const bytes = new Uint8Array(await file.slice(0, 5).arrayBuffer());
    if (new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") {
      return "This file does not contain a valid PDF signature.";
    }
  } else {
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (text.includes("\0")) return "Text artifacts cannot contain null bytes.";
    } catch {
      return "Text artifacts must use UTF-8 encoding.";
    }
  }
  return null;
};

const uploadWithProgress = (
  file: File,
  expiresInSeconds: number,
  extraction: ExtractionMetadata,
  derivedText: string,
  onProgress: (progress: number) => void,
): Promise<UploadResult> =>
  new Promise((resolve, reject) => {
    const form = new FormData();
    form.set("file", file);
    form.set("expires_in_seconds", String(expiresInSeconds));
    if (file.type === "application/pdf") {
      form.set("extraction_status", extraction.status);
      if (extraction.status === "best_effort") {
        form.set("extractor", extraction.extractor);
        form.set("extractor_version", extraction.extractor_version);
        form.set("page_count", String(extraction.page_count));
        form.set("derived_text", derivedText);
      } else if (extraction.status === "unavailable") {
        if (extraction.extractor !== undefined) form.set("extractor", extraction.extractor);
        if (extraction.extractor_version !== undefined) {
          form.set("extractor_version", extraction.extractor_version);
        }
        if (extraction.reason !== undefined) form.set("extraction_reason", extraction.reason);
      }
    }

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/upload/artifacts");
    xhr.withCredentials = true;
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    });
    xhr.addEventListener("load", () => {
      let body: unknown;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        reject(new Error("The service returned an unreadable response."));
        return;
      }
      if (xhr.status !== 201) {
        const message =
          typeof body === "object" && body !== null && "error" in body &&
          typeof body.error === "object" && body.error !== null && "message" in body.error &&
          typeof body.error.message === "string"
            ? body.error.message
            : "The artifact could not be shared.";
        reject(new Error(message));
        return;
      }
      const parsed = uploadResponseSchemaForOrigin(new URL(window.location.origin)).safeParse(body);
      if (!parsed.success) {
        reject(new Error("The service returned an incomplete share result."));
        return;
      }
      resolve(parsed.data);
    });
    xhr.addEventListener("error", () => reject(new Error("The upload connection failed.")));
    xhr.send(form);
  });

const statusCopy: Record<Exclude<UploadStage, "idle" | "complete">, string> = {
  validating: "Checking the artifact",
  extracting: "Reading embedded PDF text",
  uploading: "Publishing the temporary link",
};

export function UploadPage() {
  const [policy, setPolicy] = useState<UploadPolicy | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [expiresInSeconds, setExpiresInSeconds] = useState(0);
  const [stage, setStage] = useState<UploadStage>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [copiedShareUrl, setCopiedShareUrl] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/upload/policy", { credentials: "same-origin", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("The upload policy is unavailable.");
        return protocolLimitsSchema.parse(await response.json());
      })
      .then((nextPolicy) => {
        setPolicy(nextPolicy);
        setExpiresInSeconds(nextPolicy.expiry.allowed_seconds[0] ?? 0);
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) {
          setError(caught instanceof Error ? caught.message : "The upload policy is unavailable.");
        }
      });
    return () => controller.abort();
  }, []);

  const busy = stage !== "idle" && stage !== "complete";
  const cutoff = useMemo(
    () => result === null ? null : new Date(result.manifest.expires_at),
    [result],
  );

  const chooseFile = async (nextFile: File) => {
    if (policy === null) return;
    setResult(null);
    setCopiedShareUrl(null);
    setStage("validating");
    const validationError = await validateBrowserFile(
      nextFile,
      policy.max_artifact_bytes,
    );
    setError(validationError);
    setFile(validationError === null ? nextFile : null);
    setStage("idle");
  };

  const publish = async () => {
    if (file === null || policy === null || expiresInSeconds === 0) return;
    setError(null);
    setProgress(0);
    try {
      let extraction: ExtractionMetadata = { status: "not_applicable" };
      let derivedText = "";
      if (file.type === "application/pdf") {
        setStage("extracting");
        const { extractPdfInBrowser } = await import("../workers/pdf-extraction-client");
        const extracted = await extractPdfInBrowser(file);
        extraction = extracted.result.metadata;
        derivedText = extracted.derivedText;
      }
      setStage("uploading");
      setResult(await uploadWithProgress(
        file,
        expiresInSeconds,
        extraction,
        derivedText,
        setProgress,
      ));
      setProgress(100);
      setStage("complete");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The artifact could not be shared.");
      setStage("idle");
    }
  };

  const copyShareUrl = async () => {
    if (result === null) return;
    const shareUrl = result.share_url;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopiedShareUrl(shareUrl);
    } catch {
      setError("Copy was blocked. Select the link and copy it manually.");
    }
  };

  return (
    <main className="upload-shell">
      <header className="masthead">
        <a className="wordmark" href="/upload" aria-label="Artifact Share upload">Artifact Share</a>
        <span className="masthead__note">Temporary handoffs, exact source</span>
      </header>

      <section className="upload-layout" aria-labelledby="upload-title">
        <div className="upload-intro">
          <p className="eyebrow">One file. One expiring URL.</p>
          <h1 id="upload-title">Share the work,<br />not a permanent copy.</h1>
          <p className="lede">
            Publish HTML, Markdown, or PDF for a person or coding agent. Access ends at
            the selected cutoff; there is no history or recovery screen.
          </p>
        </div>

        <form
          className="upload-form"
          onSubmit={(event) => {
            event.preventDefault();
            void publish();
          }}
        >
          <FileDrop disabled={busy || policy === null} file={file} onFile={(nextFile) => void chooseFile(nextFile)} />

          {policy === null ? (
            <p className="policy-note">Reading this deployment’s limits…</p>
          ) : (
            <div className="form-row">
              <ExpiryPicker
                disabled={busy}
                options={policy.expiry.allowed_seconds}
                value={expiresInSeconds}
                onChange={setExpiresInSeconds}
              />
              <p className="policy-note">
                Up to {Math.round(policy.max_artifact_bytes / (1024 * 1024))} MB · exact bytes retained
              </p>
            </div>
          )}

          {error !== null && <p className="message message--error" role="alert">{error}</p>}

          {busy && (
            <div className="progress" role="status" aria-live="polite">
              <div className="progress__line">
                <span>{statusCopy[stage]}</span>
                {stage === "uploading" && <span>{progress}%</span>}
              </div>
              <progress max="100" value={stage === "uploading" ? progress : undefined} />
            </div>
          )}

          {result === null ? (
            <button className="primary-button" type="submit" disabled={file === null || policy === null || busy}>
              Create temporary link
            </button>
          ) : (
            <section className="share-result" aria-labelledby="share-result-title">
              <p className="result-kicker">Ready to share</p>
              <h2 id="share-result-title">The link is live.</h2>
              <div className="share-link-row">
                <input aria-label="Share URL" readOnly value={result.share_url} onFocus={(event) => event.currentTarget.select()} />
                <button className="primary-button" type="button" onClick={() => void copyShareUrl()}>
                  {copiedShareUrl === result.share_url ? "Copied" : "Copy link"}
                </button>
              </div>
              <p className="cutoff">
                Available until {cutoff?.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}.
                Losing this URL means losing access.
              </p>
            </section>
          )}
        </form>
      </section>
    </main>
  );
}
