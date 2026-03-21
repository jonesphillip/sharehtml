import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      // Separate config needed: wrangler.jsonc uses the Vite plugin's assets
      // format (no `directory`), which the test pool's config parser rejects.
      wrangler: { configPath: "./tests/wrangler.jsonc" },
    }),
  ],
  test: {
    globals: true,
  },
});
