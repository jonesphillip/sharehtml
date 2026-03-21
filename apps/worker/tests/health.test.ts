import { exports } from "cloudflare:workers";

describe("GET /health", () => {
  it("returns 200 with status ok", async () => {
    const response = await exports.default.fetch("https://example.com/health");
    expect(response.status).toBe(200);
    const body = await response.json<{ status: string }>();
    expect(body).toEqual({ status: "ok" });
  });

  it("does not require authentication", async () => {
    const response = await exports.default.fetch("https://example.com/health", {
      headers: {},
    });
    expect(response.status).toBe(200);
  });
});
