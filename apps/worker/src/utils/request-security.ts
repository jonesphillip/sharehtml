import type { Context } from "hono";
import type { AppBindings } from "../types.js";
import type { AuthSource } from "./auth.js";
import { type CapabilityScope, verifyCapabilityToken } from "./capability.js";
import {
  BROWSER_CAPABILITY_HEADER,
  WEBSOCKET_CAPABILITY_PROTOCOL_PREFIX,
} from "./security-constants.js";

type CapabilityResponseType = "json" | "text";

interface CapabilityLookupOptions {
  allowWebSocketProtocol?: boolean;
}

interface BrowserCapabilityOptions {
  scope: CapabilityScope;
  documentId: string | null;
  requireOrigin: boolean;
  responseType?: CapabilityResponseType;
  allowWebSocketProtocolCapability?: boolean;
}

interface CapabilityRouteOptions {
  requireOrigin?: boolean;
  responseType?: CapabilityResponseType;
}

interface ViewerCapabilityRouteOptions extends CapabilityRouteOptions {
  allowWebSocketProtocolCapability?: boolean;
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
  { allowWebSocketProtocol = false }: CapabilityLookupOptions = {},
): string | null {
  const headerToken = c.req.header(BROWSER_CAPABILITY_HEADER);
  if (headerToken) return headerToken;
  if (!allowWebSocketProtocol) return null;
  return getCapabilityFromWebSocketProtocol(c.req.header("Sec-WebSocket-Protocol"));
}

function getCapabilityFromWebSocketProtocol(header: string | undefined): string | null {
  if (!header) return null;

  const protocols = header.split(",").map((value) => value.trim()).filter(Boolean);
  for (const protocol of protocols) {
    if (!protocol.startsWith(WEBSOCKET_CAPABILITY_PROTOCOL_PREFIX)) continue;
    const token = protocol.slice(WEBSOCKET_CAPABILITY_PROTOCOL_PREFIX.length);
    if (token) return token;
  }

  return null;
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

function logSecurityWarning(
  c: Context<AppBindings>,
  event: string,
  details: Record<string, unknown>,
): void {
  console.warn({
    level: "warn",
    event,
    timestamp: new Date().toISOString(),
    method: c.req.method,
    url: c.req.url,
    ...details,
  });
}

export async function requireBrowserCapability(
  c: Context<AppBindings>,
  {
    scope,
    documentId,
    requireOrigin,
    responseType = "json",
    allowWebSocketProtocolCapability = false,
  }: BrowserCapabilityOptions,
): Promise<Response | null> {
  const authUser = c.get("authUser");
  if (isExplicitHeaderAuthSource(authUser.source)) {
    return null;
  }

  if (authUser.source === "dev") {
    if (requireOrigin && c.req.header("Origin") && !originHostMatchesRequest(c)) {
      logSecurityWarning(c, "blocked_dev_request_invalid_origin", {
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
    logSecurityWarning(c, "blocked_browser_request_invalid_origin", {
      origin: c.req.header("Origin"),
      host: c.req.header("Host") || new URL(c.req.url).host,
    });
    return createForbiddenResponse(c, responseType);
  }

  const token = getCapabilityFromRequest(c, {
    allowWebSocketProtocol: allowWebSocketProtocolCapability,
  });
  if (!token || !(await verifyCapabilityToken(c.env, token, {
    scope,
    email: authUser.email,
    documentId,
  }))) {
    logSecurityWarning(c, "blocked_browser_request_invalid_capability", {
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
    allowWebSocketProtocolCapability: false,
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
    allowWebSocketProtocolCapability: options?.allowWebSocketProtocolCapability ?? false,
  });
}
