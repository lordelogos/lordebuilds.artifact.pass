import { expect, test } from "@playwright/test";

import { startWorkspaceApprovalServer } from "../../packages/agent-bridge/src/connection/workspace-approval-server";

test("reviews and approves an exact workspace in the real local page", async ({ page }) => {
  let approvedOrigin: string | undefined;
  const pending = await startWorkspaceApprovalServer({
    workspaceRoot: "/Users/example/work/client-project",
    proposedOrigin: "https://artifactpass.com",
    availableOrigins: ["https://artifactpass.com", "https://artifacts.example.com"],
    approve: async (origin) => { approvedOrigin = origin; },
  });

  try {
    const response = await page.goto(pending.approvalUrl);
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: "Allow ArtifactPass to publish from this project?" }))
      .toBeVisible();
    await expect(page.getByText("/Users/example/work/client-project", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Publish to")).toHaveValue("https://artifactpass.com");
    await page.getByLabel("Publish to").fill("https://artifacts.example.com");
    await page.getByRole("button", { name: "Allow project" }).click();
    await expect(page.getByRole("heading", { name: "Project approved" })).toBeVisible();
    await expect(page.getByRole("status")).toContainText("Return to your agent");
    await expect(pending.result).resolves.toEqual({
      status: "approved",
      origin: "https://artifacts.example.com",
    });
    expect(approvedOrigin).toBe("https://artifacts.example.com");
  } finally {
    await pending.close();
  }
});

test("keeps Allow and Cancel usable in a narrow dark viewport", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await page.emulateMedia({ colorScheme: "dark" });
  const pending = await startWorkspaceApprovalServer({
    workspaceRoot: "/Users/example/work/mobile-project",
    proposedOrigin: "https://artifactpass.com",
    availableOrigins: ["https://artifactpass.com"],
    approve: async () => undefined,
  });

  try {
    await page.goto(pending.approvalUrl);
    await expect(page.getByRole("button", { name: "Allow project" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("heading", { name: "Approval cancelled" })).toBeVisible();
    await expect(pending.result).resolves.toEqual({ status: "cancelled" });
  } finally {
    await pending.close();
  }
});
