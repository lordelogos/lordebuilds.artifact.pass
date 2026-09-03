import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ExpiryPicker } from "../src/web/components/expiry-picker";
import { FileDrop } from "../src/web/components/file-drop";
import { prepareBrowserFile } from "../src/web/file-validation";

describe("browser upload components", () => {
  it("renders a single-file drop target and accessible picker", () => {
    const html = renderToStaticMarkup(
      <FileDrop disabled={false} file={null} onFile={() => undefined} />,
    );

    expect(html).toContain('type="file"');
    expect(html).toContain('accept=".html,.htm,.md,.markdown,.pdf,text/html,text/markdown,application/pdf"');
    expect(html).not.toContain("multiple");
    expect(html).toContain("Choose a file");
    expect(html).toContain("Drop a document here");
  });

  it("derives every expiry choice from deployment policy", () => {
    const html = renderToStaticMarkup(
      <ExpiryPicker
        disabled={false}
        options={[900, 1800, 3600]}
        value={1800}
        onChange={() => undefined}
      />,
    );

    expect(html).toContain('value="900"');
    expect(html).toContain('checked="" value="1800"');
    expect(html).toContain('value="3600"');
    expect(html).not.toContain('value="86400"');
  });

  it("rejects unsupported, mismatched and oversized files before upload", async () => {
    await expect(
      prepareBrowserFile(
        new File(["plain"], "notes.txt", { type: "text/plain" }),
        1024,
      ).then((prepared) => prepared.error),
    ).resolves.toBe("Only HTML, Markdown, and PDF files are supported.");

    await expect(
      prepareBrowserFile(
        new File(["# heading"], "notes.pdf", { type: "text/markdown" }),
        1024,
      ).then((prepared) => prepared.error),
    ).resolves.toBe("The filename extension does not match the file type.");

    await expect(
      prepareBrowserFile(
        new File(["too large"], "notes.md", { type: "text/markdown" }),
        4,
      ).then((prepared) => prepared.error),
    ).resolves.toBe("This file is larger than the deployment allows.");
  });

  it("normalizes mobile files with missing media types before validation", async () => {
    const prepared = await prepareBrowserFile(
      new File(["# Mobile handoff"], "handoff.md", { type: "" }),
      1024,
    );

    expect(prepared.error).toBeNull();
    expect(prepared.file?.type).toBe("text/markdown");
    expect(await prepared.file?.text()).toBe("# Mobile handoff");
  });

  it("executes every security-critical browser validation branch", async () => {
    await expect(prepareBrowserFile(
      new File(["not pdf"], "invalid.pdf", { type: "application/pdf" }),
      1024,
    )).resolves.toMatchObject({
      error: "This file does not contain a valid PDF signature.",
      file: null,
    });

    const sensitivePdf = new File(["%PDF-"], "sensitive.pdf", { type: "application/pdf" });
    await expect(prepareBrowserFile(
      sensitivePdf,
      1024,
      async () => ({ derivedText: `cfut_${"a".repeat(20)}` }),
    )).resolves.toMatchObject({
      error: "This PDF may contain sensitive Cloudflare user token.",
      file: null,
    });

    await expect(prepareBrowserFile(
      new File(["%PDF-clean"], "clean.pdf", { type: "application/pdf" }),
      1024,
      async () => ({ derivedText: "Clean report" }),
    )).resolves.toMatchObject({ error: null });

    await expect(prepareBrowserFile(
      new File(["bad\0text"], "null.md", { type: "text/markdown" }),
      1024,
    )).resolves.toMatchObject({
      error: "Text artifacts cannot contain null bytes.",
      file: null,
    });

    await expect(prepareBrowserFile(
      new File([new Uint8Array([0xff])], "invalid-utf8.md", { type: "text/markdown" }),
      1024,
    )).resolves.toMatchObject({
      error: "Text artifacts must use UTF-8 encoding.",
      file: null,
    });
  });
});
