export interface ApprovedShare {
  readonly origin: string;
  readonly shareUrl: string;
  readonly token: string;
}

const sharePath = /^\/a\/([A-Za-z0-9_-]{43})$/u;

export const parseApprovedShareUrl = (
  raw: unknown,
  approvedOrigins: readonly string[],
): ApprovedShare | null => {
  if (typeof raw !== "string" || raw.length > 2048) return null;
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "https:" ||
      url.href !== raw ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      !approvedOrigins.includes(url.origin)
    ) return null;
    const match = sharePath.exec(url.pathname);
    if (!match?.[1]) return null;
    return { origin: url.origin, shareUrl: raw, token: match[1] };
  } catch {
    return null;
  }
};
