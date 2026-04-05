import type { Context } from "hono";
import type { AppBindings } from "../src/types.js";
import { createCapabilityToken, verifyCapabilityToken } from "../src/utils/capability.js";
import { requireHomeBrowserCapability, requireViewerBrowserCapability } from "../src/utils/request-security.js";

function createEnv(): Env {
  return {
    AUTH_MODE: "access",
    VIEWER_CAPABILITY_SECRET: "test-capability-secret",
  } as unknown as Env;
}

function createContext(
  {
    method = "GET",
    url = "https://example.com/api/documents/doc-1",
    headers = {},
    authUser,
  }: {
    method?: string;
    url?: string;
    headers?: Record<string, string>;
    authUser: { email: string; source: "cookie" | "cf-access-token" | "access-jwt-header" | "dev" };
  },
): Context<AppBindings> {
  const requestHeaders = new Headers(headers);
  const parsedUrl = new URL(url);

  return {
    env: createEnv(),
    req: {
      method,
      url,
      header(name: string) {
        return requestHeaders.get(name) ?? undefined;
      },
      query(name: string) {
        return parsedUrl.searchParams.get(name);
      },
    },
    get(name: string) {
      if (name === "authUser") {
        return {
          id: authUser.email,
          email: authUser.email,
          source: authUser.source,
        };
      }
      return undefined;
    },
    json(body: unknown, status: number) {
      return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    },
    text(body: string, status: number) {
      return new Response(body, { status });
    },
  } as unknown as Context<AppBindings>;
}

describe("browser capability enforcement", () => {
  it("creates and verifies viewer capability tokens", async () => {
    const env = createEnv();
    const token = await createCapabilityToken(env, {
      scope: "viewer",
      email: "user@example.com",
      documentId: "doc-1",
    });

    await expect(verifyCapabilityToken(env, token, {
      scope: "viewer",
      email: "user@example.com",
      documentId: "doc-1",
    })).resolves.toBe(true);

    await expect(verifyCapabilityToken(env, token, {
      scope: "viewer",
      email: "user@example.com",
      documentId: "doc-2",
    })).resolves.toBe(false);
  });

  it("rejects cookie-auth browser requests without a capability token", async () => {
    const response = await requireViewerBrowserCapability(
      createContext({
        authUser: { email: "user@example.com", source: "cookie" },
      }),
      "doc-1",
      { requireOrigin: false },
    );

    expect(response?.status).toBe(403);
  });

  it("rejects cookie-auth browser requests with a capability token for the wrong document", async () => {
    const env = createEnv();
    const token = await createCapabilityToken(env, {
      scope: "viewer",
      email: "user@example.com",
      documentId: "doc-2",
    });

    const response = await requireViewerBrowserCapability(
      createContext({
        headers: {
          "X-ShareHTML-Browser-Capability": token,
        },
        authUser: { email: "user@example.com", source: "cookie" },
      }),
      "doc-1",
      { requireOrigin: false },
    );

    expect(response?.status).toBe(403);
  });

  it("rejects cookie-auth browser requests with a token for the wrong scope", async () => {
    const env = createEnv();
    const token = await createCapabilityToken(env, {
      scope: "home",
      email: "user@example.com",
      documentId: null,
    });

    const response = await requireViewerBrowserCapability(
      createContext({
        headers: {
          "X-ShareHTML-Browser-Capability": token,
        },
        authUser: { email: "user@example.com", source: "cookie" },
      }),
      "doc-1",
      { requireOrigin: false },
    );

    expect(response?.status).toBe(403);
  });

  it("rejects cookie-auth browser requests with a capability token for the wrong user", async () => {
    const env = createEnv();
    const token = await createCapabilityToken(env, {
      scope: "viewer",
      email: "other@example.com",
      documentId: "doc-1",
    });

    const response = await requireViewerBrowserCapability(
      createContext({
        headers: {
          "X-ShareHTML-Browser-Capability": token,
        },
        authUser: { email: "user@example.com", source: "cookie" },
      }),
      "doc-1",
      { requireOrigin: false },
    );

    expect(response?.status).toBe(403);
  });

  it("rejects cookie-auth unsafe requests with null or mismatched origins", async () => {
    const env = createEnv();
    const token = await createCapabilityToken(env, {
      scope: "viewer",
      email: "user@example.com",
      documentId: "doc-1",
    });

    const nullOrigin = await requireViewerBrowserCapability(
      createContext({
        method: "DELETE",
        headers: {
          Origin: "null",
          Host: "example.com",
          "X-ShareHTML-Browser-Capability": token,
        },
        authUser: { email: "user@example.com", source: "cookie" },
      }),
      "doc-1",
    );
    expect(nullOrigin?.status).toBe(403);

    const crossOrigin = await requireViewerBrowserCapability(
      createContext({
        method: "DELETE",
        headers: {
          Origin: "https://evil.example",
          Host: "example.com",
          "X-ShareHTML-Browser-Capability": token,
        },
        authUser: { email: "user@example.com", source: "cookie" },
      }),
      "doc-1",
    );
    expect(crossOrigin?.status).toBe(403);
  });

  it("rejects cookie-auth unsafe requests marked cross-site even when origin matches", async () => {
    const env = createEnv();
    const token = await createCapabilityToken(env, {
      scope: "viewer",
      email: "user@example.com",
      documentId: "doc-1",
    });

    const response = await requireViewerBrowserCapability(
      createContext({
        method: "PUT",
        headers: {
          Origin: "https://example.com",
          Host: "example.com",
          "Sec-Fetch-Site": "cross-site",
          "X-ShareHTML-Browser-Capability": token,
        },
        authUser: { email: "user@example.com", source: "cookie" },
      }),
      "doc-1",
    );

    expect(response?.status).toBe(403);
  });

  it("allows cookie-auth requests with a valid capability token and matching origin", async () => {
    const env = createEnv();
    const token = await createCapabilityToken(env, {
      scope: "home",
      email: "user@example.com",
      documentId: null,
    });

    const response = await requireHomeBrowserCapability(
      createContext({
        method: "POST",
        url: "https://example.com/api/documents",
        headers: {
          Origin: "https://example.com",
          Host: "example.com",
          "Sec-Fetch-Site": "same-origin",
          "X-ShareHTML-Browser-Capability": token,
        },
        authUser: { email: "user@example.com", source: "cookie" },
      }),
    );

    expect(response).toBeNull();
  });

  it("allows cookie-auth viewer GETs with a valid doc-bound capability token", async () => {
    const env = createEnv();
    const token = await createCapabilityToken(env, {
      scope: "viewer",
      email: "user@example.com",
      documentId: "doc-1",
    });

    const response = await requireViewerBrowserCapability(
      createContext({
        url: "https://example.com/api/documents/doc-1",
        headers: {
          "X-ShareHTML-Browser-Capability": token,
        },
        authUser: { email: "user@example.com", source: "cookie" },
      }),
      "doc-1",
      { requireOrigin: false },
    );

    expect(response).toBeNull();
  });

  it("returns text 403 responses for text routes like content and websocket handlers", async () => {
    const response = await requireViewerBrowserCapability(
      createContext({
        method: "GET",
        url: "https://example.com/d/doc-1/content",
        authUser: { email: "user@example.com", source: "cookie" },
      }),
      "doc-1",
      { requireOrigin: false, responseType: "text" },
    );

    expect(response?.status).toBe(403);
    await expect(response?.text()).resolves.toBe("Forbidden");
  });

  it("does not accept query-param capability tokens on normal viewer routes", async () => {
    const env = createEnv();
    const token = await createCapabilityToken(env, {
      scope: "viewer",
      email: "user@example.com",
      documentId: "doc-1",
    });

    const response = await requireViewerBrowserCapability(
      createContext({
        url: `https://example.com/api/documents/doc-1?cap=${encodeURIComponent(token)}`,
        authUser: { email: "user@example.com", source: "cookie" },
      }),
      "doc-1",
      { requireOrigin: false },
    );

    expect(response?.status).toBe(403);
  });

  it("accepts query-param capability tokens on websocket routes only", async () => {
    const env = createEnv();
    const token = await createCapabilityToken(env, {
      scope: "viewer",
      email: "user@example.com",
      documentId: "doc-1",
    });

    const response = await requireViewerBrowserCapability(
      createContext({
        url: `https://example.com/d/doc-1/ws?cap=${encodeURIComponent(token)}`,
        headers: {
          Origin: "https://example.com",
          Host: "example.com",
        },
        authUser: { email: "user@example.com", source: "cookie" },
      }),
      "doc-1",
      { requireOrigin: true, responseType: "text", allowQueryCapability: true },
    );

    expect(response).toBeNull();
  });

  it("rejects cookie-auth websocket-style requests without capability even with a trusted origin", async () => {
    const response = await requireViewerBrowserCapability(
      createContext({
        method: "GET",
        url: "https://example.com/d/doc-1/ws",
        headers: {
          Origin: "https://example.com",
          Host: "example.com",
        },
        authUser: { email: "user@example.com", source: "cookie" },
      }),
      "doc-1",
      { requireOrigin: true, responseType: "text" },
    );

    expect(response?.status).toBe(403);
    await expect(response?.text()).resolves.toBe("Forbidden");
  });

  it("allows explicit header-token auth without browser capability checks", async () => {
    const response = await requireViewerBrowserCapability(
      createContext({
        method: "DELETE",
        headers: {
          Origin: "https://evil.example",
        },
        authUser: { email: "cli@example.com", source: "cf-access-token" },
      }),
      "doc-1",
    );

    expect(response).toBeNull();
  });

  it("rejects expired capability tokens", async () => {
    const env = createEnv();
    const token = await createCapabilityToken(env, {
      scope: "viewer",
      email: "user@example.com",
      documentId: "doc-1",
      ttlSeconds: -1,
    });

    // Token is already expired (negative TTL puts exp in the past).
    await expect(verifyCapabilityToken(env, token, {
      scope: "viewer",
      email: "user@example.com",
      documentId: "doc-1",
    })).resolves.toBe(false);

    const response = await requireViewerBrowserCapability(
      createContext({
        headers: {
          "X-ShareHTML-Browser-Capability": token,
        },
        authUser: { email: "user@example.com", source: "cookie" },
      }),
      "doc-1",
      { requireOrigin: false },
    );

    expect(response?.status).toBe(403);
  });

  it("rejects tokens with extra segments", async () => {
    const env = createEnv();
    const validToken = await createCapabilityToken(env, {
      scope: "viewer",
      email: "user@example.com",
      documentId: "doc-1",
    });

    const tamperedToken = validToken + ".extra";
    await expect(verifyCapabilityToken(env, tamperedToken, {
      scope: "viewer",
      email: "user@example.com",
      documentId: "doc-1",
    })).resolves.toBe(false);
  });

  it("allows explicit header-token auth on sensitive GETs without browser capability checks", async () => {
    const response = await requireViewerBrowserCapability(
      createContext({
        method: "GET",
        url: "https://example.com/api/documents/doc-1/raw",
        authUser: { email: "cli@example.com", source: "cf-access-token" },
      }),
      "doc-1",
      { requireOrigin: false },
    );

    expect(response).toBeNull();
  });
});
