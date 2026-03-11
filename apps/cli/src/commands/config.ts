import { Command } from "commander";
import { setConfig, getConfig } from "../config/store.js";

export const configCmd = new Command("config").description("Configure the CLI");

configCmd
  .command("set-url <url>")
  .description("Set the worker URL")
  .action((url: string) => {
    setConfig("workerUrl", url.replace(/\/$/, ""));
    console.log(`Worker URL set to: ${url}`);
  });

configCmd
  .command("show")
  .description("Show current configuration")
  .action(() => {
    const c = getConfig();
    console.log(`Worker URL: ${c.workerUrl || "(not set)"}`);
    console.log(`Login:      run 'sharehtml login' when Cloudflare Access is enabled`);
  });
