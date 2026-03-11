import { createMiddleware } from "hono/factory";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { Env, AppBindings } from "../types.js";

export interface AuthUser {
  id: string;
  email: string;
}

interface AccessJWTPayload extends JWTPayload {
  email?: string;
  sub?: string;
}

let jwksCache: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJWKS(teamName: string) {
  if (!jwksCache) {
    jwksCache = createRemoteJWKSet(
      new URL(`https://${teamName}.cloudflareaccess.com/cdn-cgi/access/certs`),
    );
  }
  return jwksCache;
}

function getAccessJWTFromRequest(request: Request): string | null {
  return request.headers.get("CF-Access-JWT-Assertion") || request.headers.get("cf-access-token");
}

async function verifyAccessJWT(jwt: string, env: Env): Promise<AuthUser | null> {
  if (!env.ACCESS_AUD || !env.ACCESS_TEAM) {
    console.error("ACCESS_AUD or ACCESS_TEAM not configured");
    return null;
  }

  try {
    const jwks = getJWKS(env.ACCESS_TEAM);
    const { payload } = await jwtVerify(jwt, jwks, {
      audience: env.ACCESS_AUD,
      issuer: `https://${env.ACCESS_TEAM}.cloudflareaccess.com`,
    });

    const accessPayload = payload as AccessJWTPayload;
    if (!accessPayload.sub || !accessPayload.email) {
      console.error("JWT missing sub or email claim");
      return null;
    }

    return {
      id: accessPayload.sub,
      email: accessPayload.email,
    };
  } catch (error) {
    console.error(
      "JWT verification failed",
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

export async function getAuthenticatedUser(request: Request, env: Env): Promise<AuthUser | null> {
  if (env.AUTH_MODE !== "access") {
    return { id: "dev", email: "dev@localhost" };
  }

  const jwt = getAccessJWTFromRequest(request);
  if (!jwt) {
    return null;
  }

  return verifyAccessJWT(jwt, env);
}

export const apiAuth = createMiddleware<AppBindings>(async (c, next) => {
  if (c.env.AUTH_MODE !== "access") {
    c.set("apiUser", "dev@localhost");
    await next();
    return;
  }

  const user = await getAuthenticatedUser(c.req.raw, c.env);
  if (!user) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  c.set("apiUser", user.email);
  await next();
});
