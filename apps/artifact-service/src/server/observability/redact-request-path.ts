const capabilityPath = /^\/a\/[A-Za-z0-9_-]{32,256}(?=\/|$)/u;

export const redactRequestPath = (pathname: string): string =>
  pathname.replace(capabilityPath, "/a/:capability");
