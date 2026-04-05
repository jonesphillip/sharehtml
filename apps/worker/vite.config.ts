import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";

const disableInspector = process.env.PLAYWRIGHT === "1";

export default defineConfig({
  plugins: [cloudflare({ inspectorPort: disableInspector ? false : undefined })],
  build: {
    manifest: "manifest.json",
    rollupOptions: {
      input: {
        "home-client": "src/client/home-client.ts",
        "shell-client": "src/client/shell-client.ts",
        "collab-client": "src/client/collab-client.ts",
      },
    },
  },
});
