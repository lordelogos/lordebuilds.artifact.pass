import type { JWTVerifyGetKey } from "jose";
import type { Context, MiddlewareHandler } from "hono";

import type { ArtifactServiceBindings } from "../adapters/cloudflare-bindings";
import { verifyAccessJwt, type AccessIdentity } from "../auth/access-jwt";
import { AGENT_TOKEN_SCOPE, AgentTokenRepository, type AgentPrincipal } from "../auth/agent-token";
import { ArtifactError } from "../storage/artifact-error";

export interface AuthorizationVariables {
  accessIdentity: AccessIdentity;
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

export const requireAccess = (
  options: AuthorizationOptions = {},
): MiddlewareHandler<ArtifactHonoEnvironment> =>
  async (context, next) => {
    context.set("accessIdentity", await accessIdentity(context, options));
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
    if (options.allowUnauthenticatedUploads === true) {
      await next();
      return;
    }
    if (context.req.header("cf-access-jwt-assertion") !== undefined) {
      context.set("accessIdentity", await accessIdentity(context, options));
    } else {
      context.set("agentPrincipal", await agentPrincipal(context, options));
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
