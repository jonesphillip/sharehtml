import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppBindings } from "./types.js";
import { authMiddleware } from "./utils/auth.js";
import { api } from "./routes/api.js";
import { viewer } from "./routes/viewer.js";
import { HomeView } from "./frontend/home.js";
import { createCapabilityToken } from "./utils/capability.js";
import { getAssetUrls } from "./utils/assets.js";
import { getRegistry } from "./utils/registry.js";

export { DocumentDO } from "./durable-objects/document.js";
export { RegistryDO } from "./durable-objects/registry.js";

const app = new Hono<AppBindings>();

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status);
  }
  console.error({
    level: "error",
    event: "unhandled_error",
    timestamp: new Date().toISOString(),
    method: c.req.method,
    url: c.req.url,
    error: err.message,
    stack: err.stack,
  });
  return c.json({ error: "Internal Server Error" }, 500);
});

app.get("/health", (c) => c.json({ status: "ok" }));

app.use("/*", authMiddleware);

app.route("/api", api);
app.route("/", viewer);

app.get("/", async (c) => {
  const { email } = c.get("authUser");
  const url = new URL(c.req.url);
  const query = (url.searchParams.get("q") || "").trim();
  const requestedPage = Number.parseInt(url.searchParams.get("page") || "1", 10);
  const page = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const pageSize = 10;

  const registry = getRegistry(c.env);

  const [documentsPage, recentViews] = await Promise.all([
    registry.listDocumentsPage(email, { query, limit: pageSize, page }),
    registry.getRecentViews(email, 3),
  ]);

  const workerUrl = `${url.protocol}//${url.host}`;
  const assets = await getAssetUrls(c.env.ASSETS);
  const homeCapabilityToken = await createCapabilityToken(c.env, {
    scope: "home",
    email,
    documentId: null,
  });
  return c.html(
    HomeView({
      assets,
      email,
      workerUrl,
      documents: documentsPage.documents,
      recentViews,
      query,
      page: documentsPage.page,
      pageSize,
      totalCount: documentsPage.totalCount,
      requiresLogin: c.env.AUTH_MODE === "access",
      homeCapabilityToken,
    }),
  );
});

export default app;
