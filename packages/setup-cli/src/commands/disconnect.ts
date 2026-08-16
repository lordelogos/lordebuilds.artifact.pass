import { OsCredentialStore, assertSafeDeploymentOrigin, type CredentialStore } from "agent-bridge";

export const disconnectHost = async (
  baseUrl: string,
  options: { readonly fetch?: typeof globalThis.fetch; readonly credentialStore?: CredentialStore } = {},
): Promise<void> => {
  const store = options.credentialStore ?? new OsCredentialStore();
  const token = await store.get();
  if (token === null) return;
  const origin = assertSafeDeploymentOrigin(new URL(baseUrl));
  const response = await (options.fetch ?? globalThis.fetch)(new URL("/api/connection", origin), {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
    redirect: "error",
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Could not revoke Artifact Share connection (${response.status})`);
  }
  await store.delete();
};
