import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
  type JWTPayload,
} from "jose";

export interface AccessIdentity {
  readonly subject: string;
  readonly email: string;
}

export interface AccessJwtConfiguration {
  readonly issuer: string;
  readonly audience: string;
  readonly jwks?: JWTVerifyGetKey;
}

const remoteJwks = new Map<string, JWTVerifyGetKey>();

const accessIssuer = (value: string): string => {
  const issuer = new URL(value);
  if (
    issuer.protocol !== "https:" ||
    issuer.username !== "" ||
    issuer.password !== "" ||
    issuer.port !== "" ||
    issuer.pathname !== "/" ||
    issuer.search !== "" ||
    issuer.hash !== "" ||
    !issuer.hostname.endsWith(".cloudflareaccess.com")
  ) {
    throw new Error("ACCESS_TEAM_DOMAIN must be an HTTPS Cloudflare Access team origin");
  }
  return issuer.origin;
};

const signingKeys = (issuer: string): JWTVerifyGetKey => {
  const cached = remoteJwks.get(issuer);
  if (cached !== undefined) return cached;
  const jwks = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", issuer), {
    cooldownDuration: 30_000,
    timeoutDuration: 5_000,
  });
  remoteJwks.set(issuer, jwks);
  return jwks;
};

const identityFromPayload = (payload: JWTPayload): AccessIdentity => {
  const currentTime = Math.floor(Date.now() / 1000);
  if (
    typeof payload.iat !== "number" ||
    typeof payload.exp !== "number" ||
    payload.iat > currentTime + 60 ||
    payload.exp <= payload.iat
  ) {
    throw new Error("Access assertion has invalid time claims");
  }
  if (typeof payload.sub !== "string" || payload.sub.length === 0 || payload.sub.length > 255) {
    throw new Error("Access assertion is missing a subject");
  }
  if (
    typeof payload.email !== "string" ||
    payload.email.length === 0 ||
    payload.email.length > 320 ||
    !payload.email.includes("@")
  ) {
    throw new Error("Access assertion is missing an email identity");
  }
  return { subject: payload.sub, email: payload.email };
};

export const verifyAccessJwt = async (
  assertion: string,
  configuration: AccessJwtConfiguration,
): Promise<AccessIdentity> => {
  const issuer = accessIssuer(configuration.issuer);
  if (configuration.audience.length === 0) throw new Error("ACCESS_AUD is required");

  const verified = await jwtVerify(
    assertion,
    configuration.jwks ?? signingKeys(issuer),
    {
      algorithms: ["RS256"],
      issuer,
      audience: configuration.audience,
      clockTolerance: 0,
    },
  );
  return identityFromPayload(verified.payload);
};
