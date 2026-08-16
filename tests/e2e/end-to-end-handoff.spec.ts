import { expect, request as playwrightRequest, test } from "@playwright/test";

const configured =
  process.env.ARTIFACT_SHARE_E2E_BASE_URL !== undefined &&
  process.env.ARTIFACT_SHARE_E2E_AGENT_TOKEN !== undefined;
const agentToken = process.env.ARTIFACT_SHARE_E2E_AGENT_TOKEN ?? "not-configured";
test.use({ trace: "off" });

test.describe("live two-agent handoff", () => {
  test.skip(
    !configured,
    "Set a deployed base URL and scoped agent token; see docs/operations.md.",
  );

  test("one agent publishes while a human and a second agent read the same exact source", async ({
    baseURL,
    page,
    request,
  }) => {
    const marker = crypto.randomUUID();
    const source = `# Cross-agent handoff\n\n${"bounded source chunk\n".repeat(4_096)}\n${marker}\n`;
    const form = new FormData();
    form.set("file", new File([source], `handoff-${marker}.md`, { type: "text/markdown" }));
    form.set("expires_in_seconds", "900");
    form.set("extraction_status", "not_applicable");

    const uploaded = await request.post("/api/artifacts", {
      headers: { authorization: `Bearer ${agentToken}` },
      multipart: form,
    });
    expect(uploaded.status()).toBe(201);
    const result = await uploaded.json() as {
      share_url: string;
      manifest: { byte_size: number; sha256: string };
    };
    expect(result.share_url).toMatch(/\/a\/[A-Za-z0-9_-]{43}$/u);

    await page.goto(result.share_url);
    await expect(page.getByRole("heading", { name: "Cross-agent handoff" })).toBeVisible();
    await expect(page.getByText(marker)).toBeVisible();

    const secondAgent = await playwrightRequest.newContext({ baseURL });
    try {
      let cursor: string | null = null;
      const chunks: Buffer[] = [];
      do {
        const chunkResponse = await secondAgent.get(
          `${new URL(result.share_url).pathname}/source`,
          { params: { limit: "65536", ...(cursor === null ? {} : { cursor }) } },
        );
        expect(chunkResponse.status()).toBe(200);
        const chunk = await chunkResponse.json() as {
          data: string;
          next_cursor: string | null;
          total_size: number;
          sha256: string;
        };
        expect(chunk.total_size).toBe(result.manifest.byte_size);
        expect(chunk.sha256).toBe(result.manifest.sha256);
        chunks.push(Buffer.from(chunk.data, "base64"));
        cursor = chunk.next_cursor;
      } while (cursor !== null);
      expect(Buffer.concat(chunks).toString("utf8")).toBe(source);
    } finally {
      await secondAgent.dispose();
    }
  });
});
