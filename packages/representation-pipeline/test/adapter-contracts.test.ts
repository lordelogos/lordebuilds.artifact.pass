import { describe, expect, it, vi } from "vitest";

import { createBrowserPdfAdapter, createNodePdfAdapter } from "../src/index";

const extraction = {
  metadata: {
    status: "best_effort" as const,
    extractor: "test-extractor",
    extractor_version: "1.0.0",
    page_count: 1,
  },
  pages: [{ page: 1, text: "Hello" }],
};

describe("PDF adapter boundaries", () => {
  it.each([
    ["browser", createBrowserPdfAdapter],
    ["node", createNodePdfAdapter],
  ] as const)("keeps the %s runtime implementation injectable", async (runtime, createAdapter) => {
    const extract = vi.fn().mockResolvedValue(extraction);
    const adapter = createAdapter({
      extractor: "test-extractor",
      extractorVersion: "1.0.0",
      extract,
    });
    const bytes = new Uint8Array([37, 80, 68, 70]);

    await expect(adapter.extract({ bytes })).resolves.toEqual(extraction);
    expect(adapter.runtime).toBe(runtime);
    expect(extract).toHaveBeenCalledWith({ bytes });
  });
});
