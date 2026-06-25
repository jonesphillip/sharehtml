import {
  buildDocCsp,
  docCspFromEnv,
  injectDocCsp,
  parseAllowedOrigins,
} from "../src/utils/doc-csp.js";

describe("parseAllowedOrigins", () => {
  it("splits on whitespace and commas, trims, drops empties", () => {
    expect(parseAllowedOrigins("https://a.com, https://b.com  https://c.com")).toEqual([
      "https://a.com",
      "https://b.com",
      "https://c.com",
    ]);
  });

  it("treats the 'none' keyword as zero origins", () => {
    expect(parseAllowedOrigins("none")).toEqual([]);
    expect(parseAllowedOrigins("https://a.com none")).toEqual(["https://a.com"]);
  });
});

describe("buildDocCsp", () => {
  it("locks egress to 'none' when no origins are allowed", () => {
    const csp = buildDocCsp([]);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("img-src data: blob:");
    expect(csp).toContain("form-action 'none'");
    expect(csp).not.toContain("http");
  });

  it("extends each fetch directive with the allowlist", () => {
    const csp = buildDocCsp(["https://fonts.example.com"]);
    expect(csp).toContain("connect-src https://fonts.example.com");
    expect(csp).toContain("img-src data: blob: https://fonts.example.com");
    expect(csp).toContain("script-src 'unsafe-inline' 'unsafe-eval' https://fonts.example.com");
  });
});

describe("docCspFromEnv", () => {
  it("is disabled when unset or empty", () => {
    expect(docCspFromEnv(undefined)).toBeNull();
    expect(docCspFromEnv("")).toBeNull();
    expect(docCspFromEnv("   ")).toBeNull();
  });

  it("enables full lockdown for 'none'", () => {
    expect(docCspFromEnv("none")).toContain("connect-src 'none'");
  });

  it("enables an allowlist when origins are given", () => {
    expect(docCspFromEnv("https://a.com")).toContain("connect-src https://a.com");
  });
});

describe("injectDocCsp", () => {
  const csp = "default-src 'none'";
  const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;

  it("inserts the meta right after an existing <head>", () => {
    const out = injectDocCsp("<!doctype html><html><head><title>x</title></head><body>hi</body></html>", csp);
    expect(out).toContain(`<head>${meta}`);
  });

  it("creates a <head> after <html> when none exists", () => {
    const out = injectDocCsp("<html><body>hi</body></html>", csp);
    expect(out).toContain(`<html><head>${meta}</head>`);
  });

  it("prepends the meta for a bare fragment", () => {
    const out = injectDocCsp("<p>hi</p>", csp);
    expect(out).toBe(`${meta}<p>hi</p>`);
  });
});
