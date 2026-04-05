import type { Context } from "hono";
import type { AppBindings } from "../types.js";
import type { AuthSource } from "./auth.js";
import { type CapabilityScope, verifyCapabilityToken } from "./capability.js";
import { BROWSER_CAPABILITY_HEADER, WEBSOCKET_CAPABILITY_QUERY_PARAM } from "./security-constants.js";

type CapabilityResponseType = "json" | "text";

interface CapabilityLookupOptions {
  allowQueryParam?: boolean;
}

interface BrowserCapabilityOptions {
  scope: CapabilityScope;
  documentId: string | null;
  requireOrigin: boolean;
  responseType?: CapabilityResponseType;
  allowQueryCapability?: boolean;
}

interface CapabilityRouteOptions {
  requireOrigin?: boolean;
  responseType?: CapabilityResponseType;
}

interface ViewerCapabilityRouteOptions extends CapabilityRouteOptions {
  allowQueryCapability?: boolean;
}

function isExplicitHeaderAuthSource(source: AuthSource): boolean {
  return source === "cf-access-token" || source === "access-jwt-header";
}

function isCookieAuthSource(source: AuthSource): boolean {
  return source === "cookie";
}

function isUnsafeMethod(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

function getCapabilityFromRequest(
  c: Context<AppBindings>,
  { allowQueryParam = false }: CapabilityLookupOptions = {},
): string | null {
  const headerToken = c.req.header(BROWSER_CAPABILITY_HEADER);
  if (headerToken) return headerToken;
  if (!allowQueryParam) return null;
  return c.req.query(WEBSOCKET_CAPABILITY_QUERY_PARAM) || null;
}

function originHostMatchesRequest(c: Context<AppBindings>): boolean {
  const origin = c.req.header("Origin");
  const host = c.req.header("Host") || new URL(c.req.url).host;
  if (!origin || !host) return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  if (origin === "null") return false;
  if (originHost !== host) return false;
  const fetchSite = c.req.header("Sec-Fetch-Site");
  if (fetchSite && fetchSite === "cross-site") return false;
  return true;
}

function createForbiddenResponse(
  c: Context<AppBindings>,
  responseType: CapabilityResponseType,
): Response {
  if (responseType === "text") {
    return c.text("Forbidden", 403);
  }

  return c.json({ error: "forbidden" }, 403);
}

export async function requireBrowserCapability(
  c: Context<AppBindings>,
  {
    scope,
    documentId,
    requireOrigin,
    responseType = "json",
    allowQueryCapability = false,
  }: BrowserCapabilityOptions,
): Promise<Response | null> {
  const authUser = c.get("authUser");
  if (isExplicitHeaderAuthSource(authUser.source)) {
    return null;
  }

  if (authUser.source === "dev") {
    if (requireOrigin && c.req.header("Origin") && !originHostMatchesRequest(c)) {
      console.warn("blocked_dev_request_invalid_origin", {
        url: c.req.url,
        method: c.req.method,
        origin: c.req.header("Origin"),
        host: c.req.header("Host") || new URL(c.req.url).host,
      });
      return createForbiddenResponse(c, responseType);
    }
    return null;
  }

  if (!isCookieAuthSource(authUser.source)) {
    return createForbiddenResponse(c, responseType);
  }

  if (requireOrigin && !originHostMatchesRequest(c)) {
    console.warn("blocked_browser_request_invalid_origin", {
      url: c.req.url,
      method: c.req.method,
      origin: c.req.header("Origin"),
      host: c.req.header("Host") || new URL(c.req.url).host,
    });
    return createForbiddenResponse(c, responseType);
  }

  const token = getCapabilityFromRequest(c, { allowQueryParam: allowQueryCapability });
  if (!token || !(await verifyCapabilityToken(c.env, token, {
    scope,
    email: authUser.email,
    documentId,
  }))) {
    console.warn("blocked_browser_request_invalid_capability", {
      url: c.req.url,
      method: c.req.method,
      scope,
      documentId,
      authSource: authUser.source,
    });
    return createForbiddenResponse(c, responseType);
  }

  return null;
}

export async function requireHomeBrowserCapability(
  c: Context<AppBindings>,
  options?: CapabilityRouteOptions,
): Promise<Response | null> {
  return requireBrowserCapability(c, {
    scope: "home",
    documentId: null,
    requireOrigin: options?.requireOrigin ?? isUnsafeMethod(c.req.method),
    responseType: options?.responseType,
    allowQueryCapability: false,
  });
}

export async function requireViewerBrowserCapability(
  c: Context<AppBindings>,
  documentId: string,
  options?: ViewerCapabilityRouteOptions,
): Promise<Response | null> {
  return requireBrowserCapability(c, {
    scope: "viewer",
    documentId,
    requireOrigin: options?.requireOrigin ?? isUnsafeMethod(c.req.method),
    responseType: options?.responseType,
    allowQueryCapability: options?.allowQueryCapability ?? false,
  });
}
