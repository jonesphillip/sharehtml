import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { readFileSync, writeFileSync } from "node:fs";

// Generate a test wrangler config from the main one, stripping the `assets`
// block that the vitest pool's config parser can't handle.
function generateTestWranglerConfig() {
  const outPath = "./tests/wrangler.jsonc";
  const raw = readFileSync("./wrangler.jsonc", "utf-8");
  // Strip JSONC comments and trailing commas to parse as JSON.
  // Protect "//" inside quoted strings by temporarily replacing them.
  const json = raw
    .replace(/"(?:[^"\\]|\\.)*"/g, (m) => m.replace(/\/\//g, "\0\0"))
    .replace(/\/\/.*$/gm, "")
    .replace(/\0\0/g, "//")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/,\s*([\]}])/g, "$1");
  const config = JSON.parse(json);

  delete config.$schema;
  delete config.assets;
  delete config.env;
  config.name = "sharehtml-test";
  config.main = "../src/index.ts";
  config.workers_dev = true;

  writeFileSync(outPath, JSON.stringify(config, null, 2), "utf-8");
  return outPath;
}

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: generateTestWranglerConfig() },
    }),
  ],
  test: {
    globals: true,
  },
});
