import { describe, expect, it, vi } from "vitest";

import type { CloudflareClient } from "../src/cloudflare/client";
import {
  listCloudflareIdentityProviders,
  validatePrivateIdentityPlan,
} from "../src/cloudflare/identity";

const accountId = "a".repeat(32);

describe("Cloudflare identity contract", () => {
  it("normalizes only provider metadata and discards secret-shaped configuration", async () => {
    const client = {
      request: vi.fn(async () => [{
        id: "provider-one",
        name: "Example Workspace",
        type: "Google",
        config: { client_secret: "must-not-leak", directory_token: "must-not-leak" },
      }]),
    } as unknown as CloudflareClient;
    expect(await listCloudflareIdentityProviders(client, accountId)).toEqual([{
      id: "provider-one",
      name: "Example Workspace",
      type: "google",
    }]);
  });

  it("rejects unrestricted email-code access and invalid direct redirect", () => {
    expect(() => validatePrivateIdentityPlan({
      mode: "email-code",
      providerIds: [],
      providerAction: "create-after-approval",
      autoRedirectToIdentity: true,
      rules: [{ kind: "authenticated", value: "selected-providers" }],
      providerDisplayDigest: "a".repeat(64),
    })).toThrow("cannot allow every internet email address");
    expect(() => validatePrivateIdentityPlan({
      mode: "company-login",
      providerIds: ["one", "two"],
      providerAction: "reuse",
      autoRedirectToIdentity: true,
      rules: [{ kind: "authenticated", value: "selected-providers" }],
      providerDisplayDigest: "a".repeat(64),
    })).toThrow("exactly one planned provider");
  });
});
