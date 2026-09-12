const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const bytesToBase64Url = (bytes: Uint8Array): string => {
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
};

export const sha256 = async (input: Uint8Array | string): Promise<string> => {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.buffer)));
};

export const sha256Base64Url = async (input: string): Promise<string> => {
  const bytes = new TextEncoder().encode(input);
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.buffer)));
};

export const createShareToken = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return bytesToBase64Url(bytes);
};

export const hashShareToken = (token: string): Promise<string> => sha256(token);
