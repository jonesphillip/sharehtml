import { isRecord } from "../types.js";
import { BROWSER_CAPABILITY_HEADER, WEBSOCKET_CAPABILITY_QUERY_PARAM } from "./security-constants.js";

export { BROWSER_CAPABILITY_HEADER, WEBSOCKET_CAPABILITY_QUERY_PARAM };

export type CapabilityScope = "home" | "viewer";

interface CapabilityPayload {
  v: 1;
  scope: CapabilityScope;
  email: string;
  documentId: string | null;
  exp: number;
  nonce: string;
}

function getCapabilitySecret(env: Env): string {
  const configured = env.VIEWER_CAPABILITY_SECRET?.trim();
  if (configured) return configured;
  if (env.AUTH_MODE === "none") return "dev-viewer-capability-secret";
  throw new Error("VIEWER_CAPABILITY_SECRET is required when AUTH_MODE=access");
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string): Uint8Array | null {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  try {
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

const hmacKeyCache = new Map<string, CryptoKey>();

async function importHmacKey(secret: string): Promise<CryptoKey> {
  const cached = hmacKeyCache.get(secret);
  if (cached) return cached;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  hmacKeyCache.set(secret, key);
  return key;
}

async function sign(message: string, secret: string): Promise<string> {
  const key = await importHmacKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return encodeBase64Url(new Uint8Array(signature));
}

async function verify(message: string, signature: string, secret: string): Promise<boolean> {
  const key = await importHmacKey(secret);
  const signatureBytes = decodeBase64Url(signature);
  if (!signatureBytes) return false;
  return crypto.subtle.verify("HMAC", key, signatureBytes, new TextEncoder().encode(message));
}

function parsePayload(value: string): CapabilityPayload | null {
  try {
    const payload: unknown = JSON.parse(value);
    if (!isRecord(payload)) return null;
    if (payload.v !== 1) return null;
    if (payload.scope !== "home" && payload.scope !== "viewer") return null;
    if (typeof payload.email !== "string" || payload.email.length === 0) return null;
    if (payload.documentId !== null && typeof payload.documentId !== "string") return null;
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) return null;
    if (typeof payload.nonce !== "string" || payload.nonce.length === 0) return null;
    return {
      v: 1,
      scope: payload.scope,
      email: payload.email,
      documentId: payload.documentId,
      exp: payload.exp,
      nonce: payload.nonce,
    };
  } catch {
    return null;
  }
}

export async function createCapabilityToken(
  env: Env,
  {
    scope,
    email,
    documentId,
    ttlSeconds = 600,
  }: {
    scope: CapabilityScope;
    email: string;
    documentId: string | null;
    ttlSeconds?: number;
  },
): Promise<string> {
  const payload: CapabilityPayload = {
    v: 1,
    scope,
    email,
    documentId,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    nonce: crypto.randomUUID(),
  };
  const encodedPayload = encodeBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await sign(encodedPayload, getCapabilitySecret(env));
  return `${encodedPayload}.${signature}`;
}

export async function verifyCapabilityToken(
  env: Env,
  token: string,
  {
    scope,
    email,
    documentId,
  }: {
    scope: CapabilityScope;
    email: string;
    documentId: string | null;
  },
): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [encodedPayload, signature] = parts;
  if (!encodedPayload || !signature) return false;
  const secret = getCapabilitySecret(env);
  if (!(await verify(encodedPayload, signature, secret))) return false;

  const payloadBytes = decodeBase64Url(encodedPayload);
  if (!payloadBytes) return false;
  const payload = parsePayload(new TextDecoder().decode(payloadBytes));
  if (!payload) return false;
  if (payload.scope !== scope) return false;
  if (payload.email !== email) return false;
  if (payload.documentId !== documentId) return false;
  if (payload.exp < Math.floor(Date.now() / 1000)) return false;
  return true;
}
