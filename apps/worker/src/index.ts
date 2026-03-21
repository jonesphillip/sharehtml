import { Hono } from "hono";
import { api } from "./routes/api.js";
import { viewer } from "./routes/viewer.js";
import { HomeView } from "./frontend/home.js";
import { getAuthenticatedUser } from "./utils/auth.js";
import { getAssetUrls } from "./utils/assets.js";
import { getRegistry } from "./utils/registry.js";

export { DocumentDO } from "./durable-objects/document.js";
export { RegistryDO } from "./durable-objects/registry.js";

const app = new Hono<{ Bindings: Env }>();

app.route("/api", api);
app.route("/", viewer);

app.get("/", async (c) => {
  const user = await getAuthenticatedUser(c.req.raw, c.env);
  if (!user) return c.text("Unauthorized", 401);
  const email = user.email;
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
    }),
  );
});

export default app;
