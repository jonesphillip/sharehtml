import { Hono } from "hono";
import type { Env } from "./types.js";
import { api } from "./routes/api.js";
import { viewer } from "./routes/viewer.js";
import { HomeView } from "./frontend/home.js";
import { getAuthenticatedUser } from "./utils/auth.js";
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

  const registry = getRegistry(c.env);

  const [documents, recentViews] = await Promise.all([
    registry.listDocuments(email),
    registry.getRecentViews(email, 3),
  ]);

  const url = new URL(c.req.url);
  const workerUrl = `${url.protocol}//${url.host}`;
  return c.html(
    HomeView({
      email,
      workerUrl,
      documents: documents as any,
      recentViews: recentViews as any,
      requiresLogin: c.env.AUTH_MODE === "access",
    }),
  );
});

export default app;
