import { Command } from "commander";
import { loginWithAccess } from "../auth/access.js";
import { getConfig, isConfigured } from "../config/store.js";

export const loginCmd = new Command("login")
  .description("Log in to Cloudflare Access for CLI requests")
  .action(async () => {
    try {
      if (!isConfigured()) {
        throw new Error("Not configured. Run: sharehtml config set-url <url>");
      }

      const { workerUrl } = getConfig();
      console.log(`Logging in to ${workerUrl}...`);
      await loginWithAccess(workerUrl);
      console.log("Login complete.");
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });
