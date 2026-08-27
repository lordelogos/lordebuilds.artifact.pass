import type { JWTVerifyGetKey } from "jose";
import type { Context, MiddlewareHandler } from "hono";

import type { ArtifactServiceBindings } from "../adapters/cloudflare-bindings";
import { verifyAccessJwt, type AccessIdentity } from "../auth/access-jwt";
import { AGENT_TOKEN_SCOPE, AgentTokenRepository, type AgentPrincipal } from "../auth/agent-token";
import { readPublicSession, type HumanIdentity } from "../auth/public-session";
import { ArtifactError } from "../storage/artifact-error";

export interface AuthorizationVariables {
  accessIdentity: AccessIdentity;
  humanIdentity: HumanIdentity;
  agentPrincipal: AgentPrincipal;
  shareToken: string;
}

export type ArtifactHonoEnvironment = {
  Bindings: ArtifactServiceBindings;
  Variables: AuthorizationVariables;
};

export interface AuthorizationOptions {
  readonly accessJwks?: JWTVerifyGetKey;
  readonly now?: () => number;
  readonly allowUnauthenticatedUploads?: boolean;
}

const unavailable = (): ArtifactError =>
  new ArtifactError("not_found", "Route is unavailable", 404);

const accessIdentity = async (
  context: Context<ArtifactHonoEnvironment>,
  options: AuthorizationOptions,
): Promise<AccessIdentity> => {
  const assertion = context.req.header("cf-access-jwt-assertion");
  const issuer = context.env.ACCESS_TEAM_DOMAIN;
  const audience = context.env.ACCESS_AUD;
  if (assertion === undefined || issuer === undefined || audience === undefined) throw unavailable();
  try {
    return await verifyAccessJwt(assertion, {
      issuer,
      audience,
      ...(options.accessJwks === undefined ? {} : { jwks: options.accessJwks }),
    });
  } catch {
    throw unavailable();
  }
};

const humanIdentity = async (
  context: Context<ArtifactHonoEnvironment>,
  options: AuthorizationOptions,
): Promise<HumanIdentity> => {
  if (context.env.HUMAN_AUTH_MODE !== "artifactpass") {
    return accessIdentity(context, options);
  }
  const identity = await readPublicSession(
    context.req.raw,
    context.env,
    (options.now ?? Date.now)(),
  );
  if (identity === null) throw unavailable();
  return identity;
};

const signInLocation = (request: Request): string => {
  const url = new URL(request.url);
  return `/auth/sign-in?return_to=${encodeURIComponent(`${url.pathname}${url.search}`)}`;
};

const agentPrincipal = async (
  context: Context<ArtifactHonoEnvironment>,
  options: AuthorizationOptions,
): Promise<AgentPrincipal> => {
  const authorization = context.req.header("authorization");
  const match = /^Bearer (as_[A-Za-z0-9_-]{43})$/u.exec(authorization ?? "");
  if (match?.[1] === undefined) throw unavailable();
  const principal = await new AgentTokenRepository(
    context.env.ARTIFACT_DB,
    options.now,
  ).authenticate(match[1]);
  if (principal === null || principal.scope !== AGENT_TOKEN_SCOPE) throw unavailable();
  return principal;
};

export const requireHuman = (
  options: AuthorizationOptions = {},
  behavior: { readonly redirectToSignIn?: boolean } = {},
): MiddlewareHandler<ArtifactHonoEnvironment> =>
  async (context, next) => {
    try {
      context.set("humanIdentity", await humanIdentity(context, options));
    } catch (error) {
      if (
        context.env.HUMAN_AUTH_MODE === "artifactpass" &&
        behavior.redirectToSignIn === true &&
        error instanceof ArtifactError &&
        error.status === 404
      ) {
        return context.redirect(signInLocation(context.req.raw), 302);
      }
      throw error;
    }
    await next();
  };

export const requireAgent = (
  options: AuthorizationOptions = {},
): MiddlewareHandler<ArtifactHonoEnvironment> =>
  async (context, next) => {
    context.set("agentPrincipal", await agentPrincipal(context, options));
    await next();
  };

export const requireUploader = (
  options: AuthorizationOptions = {},
): MiddlewareHandler<ArtifactHonoEnvironment> =>
  async (context, next) => {
    if (context.get("humanIdentity") !== undefined || context.get("agentPrincipal") !== undefined) {
      await next();
      return;
    }
    if (options.allowUnauthenticatedUploads === true) {
      await next();
      return;
    }
    if (context.req.header("authorization") !== undefined) {
      context.set("agentPrincipal", await agentPrincipal(context, options));
    } else {
      const identity = await humanIdentity(context, options);
      context.set("humanIdentity", identity);
      if (context.env.HUMAN_AUTH_MODE !== "artifactpass") {
        context.set("accessIdentity", identity as AccessIdentity);
      }
    }
    await next();
  };

export const requirePublicCapability = (): MiddlewareHandler<ArtifactHonoEnvironment> =>
  async (context, next) => {
    const token = context.req.param("shareToken") ?? "";
    if (!/^[A-Za-z0-9_-]{32,256}$/u.test(token)) throw unavailable();
    context.set("shareToken", token);
    await next();
  };
