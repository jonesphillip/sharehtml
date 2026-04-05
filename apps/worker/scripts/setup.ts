import { execFile, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[39m`;
const R2_PRICING_URL = "https://developers.cloudflare.com/r2/pricing/#free-tier";

process.on("SIGINT", () => {
  process.stdout.write("\n");
  process.exit(1);
});

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`  ${question} `, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function promptSecret(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const origWrite = rl["_writeToOutput" as keyof typeof rl] as (s: string) => void;
  (rl as any)._writeToOutput = (s: string) => {
    if (s.includes(question)) {
      origWrite.call(rl, s);
    } else {
      origWrite.call(rl, s.replace(/[^\r\n]/g, "*"));
    }
  };
  return new Promise((resolve) => {
    rl.question(`  ${question} `, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? "Y/n" : "y/N";
  const answer = await prompt(`${question} ${dim(`(${hint})`)}`);
  if (answer === "") return defaultYes;
  return answer.toLowerCase() === "y" || answer.toLowerCase() === "yes";
}

async function commandExists(cmd: string): Promise<boolean> {
  try {
    await run("which", [cmd]);
    return true;
  } catch {
    return false;
  }
}

function run(cmd: string, args: string[], opts?: { input?: string; cwd?: string; env?: Record<string, string> }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, {
      encoding: "utf-8",
      cwd: opts?.cwd,
      env: opts?.env ? { ...process.env, ...opts.env } : undefined,
      maxBuffer: 10 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      const outputText = [stdout, stderr].filter(Boolean).join("\n").trim();
      if (err) {
        (err as any).stdout = stdout;
        (err as any).stderr = stderr;
        (err as any).outputText = outputText;
        reject(err);
        return;
      }
      resolve(outputText);
    });
    if (opts?.input) {
      child.stdin!.write(opts.input);
      child.stdin!.end();
    }
  });
}

function getRepoRoot(): string {
  return resolve(import.meta.dirname, "../../..");
}

function runInteractive(cmd: string, args: string[], opts?: { cwd?: string }): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts?.cwd,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`${cmd} exited with code ${code}`));
    });
  });
}

function spinner(message: string, gap = false): { stop: (final?: string) => void } {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const prefix = gap ? "\n" : "";
  process.stdout.write(`${prefix}\r\x1b[K  ${dim(frames[i++ % frames.length])} ${message}`);
  const id = setInterval(() => {
    process.stdout.write(`\r\x1b[K  ${dim(frames[i++ % frames.length])} ${message}`);
  }, 80);
  return {
    stop(final?: string) {
      clearInterval(id);
      process.stdout.write(`\r\x1b[K  ${final ?? message}\n`);
    },
  };
}

async function cfApi(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<any> {
  const resp = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await resp.json();
  if (!json.success) {
    const msgs = json.errors?.map((e: any) => e.message).join(", ") || "Unknown error";
    throw new Error(msgs);
  }
  return json.result;
}

function normalizeAccessDomain(domain: string | undefined): string {
  return (domain ?? "").replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function isApiAccessDomain(domain: string | undefined, hostname: string): boolean {
  const normalized = normalizeAccessDomain(domain);
  return (
    normalized === `${hostname}/api` ||
    normalized === `${hostname}/api*` ||
    normalized === `${hostname}/api/*` ||
    normalized.startsWith(`${hostname}/api/`)
  );
}

function resolveAppPolicies(app: any, policies: any[]): any[] {
  if (!Array.isArray(app?.policies)) return [];
  return app.policies
    .map((policy: any) => {
      if (policy?.decision) return policy;
      const id = typeof policy === "string" ? policy : policy?.id;
      return policies.find((candidate: any) => candidate.id === id);
    })
    .filter(Boolean);
}

function policyIncludesEveryone(policy: any): boolean {
  return (
    Array.isArray(policy?.include) &&
    policy.include.some((rule: any) => typeof rule === "object" && rule !== null && "everyone" in rule)
  );
}

function isLegacyApiBypassApp(app: any, hostname: string, configName: string, policies: any[]): boolean {
  if (app?.name !== `${configName}-api`) return false;
  if (!isApiAccessDomain(app?.domain, hostname)) return false;

  const resolvedPolicies = resolveAppPolicies(app, policies);
  return (
    resolvedPolicies.length > 0 &&
    resolvedPolicies.every((policy: any) => policy?.decision === "bypass") &&
    resolvedPolicies.some(policyIncludesEveryone)
  );
}

function getApiPathApps(apps: any[], hostname: string): any[] {
  return apps.filter((app: any) => isApiAccessDomain(app?.domain, hostname));
}

function describePolicy(policy: any): string {
  const parts: string[] = [];
  const includes = Array.isArray(policy?.include) ? policy.include : [];

  for (const rule of includes) {
    if (rule?.email?.email) parts.push(rule.email.email);
    if (rule?.email_domain?.domain) parts.push(`*@${rule.email_domain.domain}`);
    if (rule?.everyone) parts.push("everyone");
  }

  const suffix = parts.length > 0 ? ` — ${parts.join(", ")}` : "";
  return `${policy.name || policy.id} (${policy.decision || "unknown"})${suffix}`;
}

function openUrl(url: string) {
  try {
    const cmd = process.platform === "darwin" ? "open" : "xdg-open";
    execFileSync(cmd, [url], { stdio: "ignore" });
  } catch {}
}

function findWranglerConfig(): string {
  for (const name of ["wrangler.jsonc", "wrangler.json", "wrangler.toml"]) {
    const p = resolve(import.meta.dirname, "..", name);
    if (existsSync(p)) return p;
  }
  fail("No wrangler config found. Expected wrangler.jsonc, wrangler.json, or wrangler.toml in apps/worker/");
}

function parseWranglerConfig(path: string): { name: string } {
  const raw = readFileSync(path, "utf-8");
  if (path.endsWith(".toml")) {
    const match = raw.match(/^name\s*=\s*"(.+)"/m);
    if (!match) fail("Could not parse worker name from wrangler.toml");
    return { name: match[1] };
  }
  const cleaned = raw
    .replace(/"(?:[^"\\]|\\.)*"/g, (m) => m.replace(/\/\//g, "\0\0"))
    .replace(/\/\/.*$/gm, "")
    .replace(/\0\0/g, "//")
    .replace(/,\s*([\]}])/g, "$1");
  const config = JSON.parse(cleaned);
  // Use the production env name if available, since that's what we deploy
  const prodName = config.env?.production?.name;
  if (prodName) config.name = prodName;
  return config;
}

function writeWranglerProductionVars(path: string, vars: Record<string, string>): void {
  let content = readFileSync(path, "utf-8");

  const productionVarsPattern = /("production"\s*:\s*\{[\s\S]*?"vars"\s*:\s*\{)([\s\S]*?)(\})/;
  const match = content.match(productionVarsPattern);
  if (!match) {
    throw new Error("Could not find env.production.vars block in wrangler config");
  }

  let varsBlock = match[2];
  for (const [key, value] of Object.entries(vars)) {
    const pattern = new RegExp(`("${key}"\\s*:\\s*)"[^"]*"`, "g");
    varsBlock = varsBlock.replace(pattern, `$1"${value}"`);
  }

  content = content.replace(match[0], match[1] + varsBlock + match[3]);
  writeFileSync(path, content, "utf-8");
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function extractLeadingJsonValue(value: string): string | null {
  const trimmed = value.trimStart();
  const firstChar = trimmed[0];
  if (firstChar !== "[" && firstChar !== "{") {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "[" || char === "{") {
      depth++;
      continue;
    }

    if (char === "]" || char === "}") {
      depth--;
      if (depth === 0) {
        return trimmed.slice(0, i + 1);
      }
    }
  }

  return null;
}

function parseSecretList(output: string): string[] {
  const jsonText = extractLeadingJsonValue(stripAnsi(output));
  if (!jsonText) {
    throw new Error("unexpected secret list response");
  }

  const parsed: unknown = JSON.parse(jsonText);
  if (!Array.isArray(parsed)) {
    throw new Error("unexpected secret list response");
  }

  const secrets: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    if (!("name" in entry) || typeof entry.name !== "string") continue;
    secrets.push(entry.name);
  }
  return secrets;
}

function shouldTreatSecretListFailureAsMissingWorker(message: string): boolean {
  return message.includes("script not found") ||
    message.includes("workers.api.error.script_not_found") ||
    message.includes("There doesn't seem to be a Worker");
}

async function hasProductionSecret(name: string): Promise<boolean> {
  try {
    const output = await run("npx", [
      "wrangler",
      "secret",
      "list",
      "--env",
      "production",
      "--format",
      "json",
    ]);
    return parseSecretList(output).includes(name);
  } catch (error: any) {
    const message = formatCommandError(error);
    if (shouldTreatSecretListFailureAsMissingWorker(message)) {
      return false;
    }
    throw new Error(message);
  }
}

async function ensureProductionSecret(name: string): Promise<"created" | "existing"> {
  if (await hasProductionSecret(name)) {
    return "existing";
  }

  const value = randomBytes(32).toString("hex");
  await run(
    "npx",
    ["wrangler", "secret", "put", name, "--env", "production"],
    { input: `${value}\n` },
  );
  return "created";
}

type SelectOption = { label: string; value: string; selected: boolean };
type AccessPolicy = {
  id: string;
  name?: string;
  decision?: string;
  include?: Array<Record<string, unknown>>;
  reusable?: boolean;
};
type AccessApp = {
  id: string;
  name?: string;
  domain?: string;
  aud?: string;
  policies?: Array<string | AccessPolicy | { id?: string; decision?: string }>;
};
type ExistingAccessState = {
  rootApp: AccessApp | null;
  rootPolicies: AccessPolicy[];
};
type SelectedPolicyState = {
  policyIds: string[];
  policyLabels: string[];
  newIncludeRules: Array<Record<string, unknown>>;
  shouldSelectPolicies: boolean;
};

function multiSelect(title: string, options: SelectOption[]): Promise<SelectOption[]> {
  return new Promise((resolve) => {
    let cursor = 0;
    let rendered = false;
    const { stdin, stdout } = process;

    function render() {
      if (rendered) stdout.write(`\x1b[${options.length}A`);
      rendered = true;
      for (let i = 0; i < options.length; i++) {
        const opt = options[i];
        const pointer = i === cursor ? ">" : " ";
        const check = opt.selected ? "[x]" : "[ ]";
        const line = `  ${pointer} ${check} ${opt.label}`;
        stdout.write(`\r\x1b[K${i === cursor ? bold(line) : line}\n`);
      }
    }

    console.log(`  ${title}`);
    console.log(`  ${dim("↑↓ navigate · space toggle · enter confirm")}`);
    console.log();
    render();

    if (!stdin.isTTY) {
      resolve(options.filter((o) => o.selected));
      return;
    }
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf-8");

    function cleanup() {
      stdin.setRawMode(false);
      stdin.removeListener("data", onData);
      stdin.pause();
    }

    function onData(key: string) {
      if (key === "\x03") { // Ctrl+C
        cleanup();
        process.stdout.write("\n");
        process.exit(1);
      }
      if (key === "\r" || key === "\n") { // Enter
        cleanup();
        resolve(options.filter((o) => o.selected));
        return;
      }
      if (key === " ") { // Space
        options[cursor].selected = !options[cursor].selected;
        render();
        return;
      }
      if (key === "\x1b[A" || key === "k") { // Up
        cursor = (cursor - 1 + options.length) % options.length;
        render();
        return;
      }
      if (key === "\x1b[B" || key === "j") { // Down
        cursor = (cursor + 1) % options.length;
        render();
        return;
      }
    }

    stdin.on("data", onData);
  });
}

function fail(message: string): never {
  console.error(`\n  ${message}`);
  process.exit(1);
}

function formatCommandError(error: any): string {
  const outputText = error?.outputText?.toString?.().trim();
  if (outputText) return outputText;

  const stderr = error?.stderr?.toString?.().trim();
  if (stderr) return stderr;

  const stdout = error?.stdout?.toString?.().trim();
  if (stdout) return stdout;

  return error?.message || String(error);
}

function isMissingR2Error(message: string): boolean {
  return (
    message.includes("Please enable R2 through the Cloudflare Dashboard") ||
    message.includes("[code: 10042]")
  );
}

function isAccessNotEnabledError(message: string): boolean {
  return message.includes("access.api.error.not_enabled");
}

function getR2SetupMessage(): string {
  return (
    "R2 is not enabled on this Cloudflare account.\n" +
    "In the Cloudflare Dashboard, go to Storage & databases -> R2 object storage and activate R2, then run `pnpm run setup` again.\n" +
    `R2 includes a free tier to get started: ${R2_PRICING_URL}`
  );
}

function getAccessDashboardUrl(accountId: string): string {
  return `https://dash.cloudflare.com/${accountId}/zero-trust/landing-page`;
}

async function retryAccessSetup(accountId: string): Promise<boolean> {
  const accessDashboardUrl = getAccessDashboardUrl(accountId);
  console.log();
  console.log("  Cloudflare Access is not enabled on this account.");
  console.log(
    "  Open Zero Trust for this account, click \"Get started\", choose a team name, and complete the Zero Trust Free signup flow.",
  );
  console.log(`  ${dim(accessDashboardUrl)}`);
  console.log();
  if (await confirm(`Open ${cyan(accessDashboardUrl)}?`)) {
    openUrl(accessDashboardUrl);
  }
  console.log();
  return await confirm("Retry Access setup after enabling Access?");
}

async function loadAccessConfiguration(
  cfToken: string,
  accountId: string,
): Promise<{ existingPolicies: AccessPolicy[]; existingApps: AccessApp[] }> {
  const [existingPolicies, existingApps] = await Promise.all([
    cfApi(cfToken, "GET", `/accounts/${accountId}/access/policies`),
    cfApi(cfToken, "GET", `/accounts/${accountId}/access/apps`),
  ]);
  return { existingPolicies, existingApps };
}

async function inspectExistingAccessState(
  cfToken: string,
  accountId: string,
  hostname: string,
  appName: string,
  existingApps: AccessApp[],
): Promise<ExistingAccessState> {
  const existingRootAppSummary = existingApps.find(
    (app) => normalizeAccessDomain(app.domain) === hostname && app.name === appName,
  );

  if (!existingRootAppSummary?.id) {
    return { rootApp: null, rootPolicies: [] };
  }

  const state = { rootApp: null as AccessApp | null, rootPolicies: [] as AccessPolicy[] };
  const s = spinner("Inspecting existing Access app...", true);
  try {
    const [rootApp, rootPolicies] = await Promise.all([
      cfApi(cfToken, "GET", `/accounts/${accountId}/access/apps/${existingRootAppSummary.id}`),
      cfApi(cfToken, "GET", `/accounts/${accountId}/access/apps/${existingRootAppSummary.id}/policies`).catch(
        () => [],
      ),
    ]);
    state.rootApp = rootApp;
    state.rootPolicies = rootPolicies;
    s.stop("Existing Access app found");
    return state;
  } catch (e: any) {
    s.stop();
    fail(`Failed to inspect existing Access app: ${e.message}`);
  }
}

function buildPolicyOptions(
  reusablePolicies: AccessPolicy[],
  wranglerEmail: string | undefined,
): SelectOption[] {
  const options: SelectOption[] = [];

  for (const policy of reusablePolicies) {
    const emails = policy.include
      ?.filter((rule: any) => rule.email)
      .map((rule: any) => rule.email.email);
    const domains = policy.include
      ?.filter((rule: any) => rule.email_domain)
      .map((rule: any) => rule.email_domain.domain);
    const parts = [...(emails ?? []), ...(domains ?? []).map((domain: string) => `*@${domain}`)];
    const detail = parts.length > 0 ? dim(` — ${parts.join(", ")}`) : "";
    options.push({
      label: `${policy.name}${detail}`,
      value: `policy:${policy.id}`,
      selected: false,
    });
  }

  if (wranglerEmail) {
    options.push({
      label: `${wranglerEmail} only ${dim("(new policy)")}`,
      value: `email:${wranglerEmail}`,
      selected: reusablePolicies.length === 0,
    });
  }

  options.push({
    label: `Custom emails... ${dim("(new policy)")}`,
    value: "custom",
    selected: !wranglerEmail && reusablePolicies.length === 0,
  });

  return options;
}

async function selectAccessPolicies(
  existingRootApp: AccessApp | null,
  existingRootPolicies: AccessPolicy[],
  reusablePolicies: AccessPolicy[],
  wranglerEmail: string | undefined,
): Promise<SelectedPolicyState> {
  const selected: SelectedPolicyState = {
    policyIds: [],
    policyLabels: [],
    newIncludeRules: [],
    shouldSelectPolicies: !existingRootApp || existingRootPolicies.length === 0,
  };

  if (existingRootApp && existingRootPolicies.length > 0) {
    console.log();
    console.log(`  ${dim("access")}    existing app ${bold(existingRootApp.name || existingRootApp.id)}`);
    for (const policy of existingRootPolicies) {
      console.log(`    ${dim("-")} ${describePolicy(policy)}`);
    }
    console.log();

    selected.shouldSelectPolicies = !(await confirm("Keep the existing Access policies?", true));
    if (!selected.shouldSelectPolicies) {
      selected.policyLabels = existingRootPolicies.map((policy) => policy.name || policy.id);
      return selected;
    }
  } else if (existingRootApp) {
    console.log();
    console.log(`  ${dim("access")}    existing app ${bold(existingRootApp.name || existingRootApp.id)} has no attached policies`);
    console.log();
  }

  if (!selected.shouldSelectPolicies) {
    return selected;
  }

  console.log();
  const options = buildPolicyOptions(reusablePolicies, wranglerEmail);
  const selectedOptions = await multiSelect("Who should have access?", options);
  console.log();

  let needsCustomEmails = false;
  for (const option of selectedOptions) {
    if (option.value === "custom") {
      needsCustomEmails = true;
      continue;
    }

    if (option.value.startsWith("policy:")) {
      const id = option.value.slice(7);
      selected.policyIds.push(id);
      selected.policyLabels.push(reusablePolicies.find((policy) => policy.id === id)?.name ?? id);
      continue;
    }

    if (option.value.startsWith("email:")) {
      const email = option.value.slice(6);
      selected.newIncludeRules.push({ email: { email } });
      selected.policyLabels.push(email);
    }
  }

  if (needsCustomEmails) {
    const emailsInput = await prompt("Enter email addresses (comma-separated):");
    const emails = emailsInput.split(",").map((email) => email.trim()).filter(Boolean);
    for (const email of emails) {
      selected.newIncludeRules.push({ email: { email } });
      selected.policyLabels.push(email);
    }
    console.log();
  }

  if (selected.policyIds.length === 0 && selected.newIncludeRules.length === 0) {
    fail("At least one access policy is required");
  }

  return selected;
}

async function reconcileRootAccessApp(
  cfToken: string,
  accountId: string,
  hostname: string,
  appName: string,
  existingRootApp: AccessApp | null,
  selectedPolicies: SelectedPolicyState,
): Promise<AccessApp> {
  const policyIds = [...selectedPolicies.policyIds];

  if (selectedPolicies.shouldSelectPolicies && selectedPolicies.newIncludeRules.length > 0) {
    const newPolicy = await cfApi(cfToken, "POST", `/accounts/${accountId}/access/policies`, {
      name: `${appName}-allow`,
      decision: "allow",
      include: selectedPolicies.newIncludeRules,
      session_duration: "24h",
    });
    policyIds.push(newPolicy.id);
  }

  if (!existingRootApp) {
    return cfApi(cfToken, "POST", `/accounts/${accountId}/access/apps`, {
      name: appName,
      domain: hostname,
      type: "self_hosted",
      session_duration: "24h",
      policies: policyIds.map((id) => ({ id })),
    });
  }

  if (!selectedPolicies.shouldSelectPolicies) {
    return existingRootApp;
  }

  return cfApi(cfToken, "PUT", `/accounts/${accountId}/access/apps/${existingRootApp.id}`, {
    ...existingRootApp,
    policies: policyIds.map((id) => ({ id })),
  });
}

async function migrateLegacyApiAccessApp(
  cfToken: string,
  accountId: string,
  hostname: string,
  configName: string,
  existingApps: AccessApp[],
  existingPolicies: AccessPolicy[],
): Promise<void> {
  const apiPathApps = getApiPathApps(existingApps, hostname);
  if (apiPathApps.length === 0) return;
  if (apiPathApps.length > 1) {
    fail("Multiple /api Access apps exist for this hostname. Remove them manually, then run setup again.");
  }

  const apiPathApp = apiPathApps[0].id
    ? await cfApi(cfToken, "GET", `/accounts/${accountId}/access/apps/${apiPathApps[0].id}`)
    : apiPathApps[0];

  if (!isLegacyApiBypassApp(apiPathApp, hostname, configName, existingPolicies)) {
    fail(
      `Found an existing /api Access app (${apiPathApp.name || apiPathApp.id}) that does not match the old sharehtml bypass config. Remove or change it manually, then run setup again.`,
    );
  }

  const migrate = await confirm(
    `Found legacy API-only Access app ${bold(apiPathApp.name || apiPathApp.id)}. Remove it and keep the root app so CLI login works?`,
  );
  if (!migrate) {
    fail("Migration cancelled. Remove the legacy /api Access app to use CLI login.");
  }

  const s = spinner("Removing legacy API-only Access app...", true);
  try {
    await cfApi(cfToken, "DELETE", `/accounts/${accountId}/access/apps/${apiPathApp.id}`);
    s.stop("Removed legacy API-only Access app");
  } catch (e: any) {
    s.stop();
    fail(`Failed to remove legacy API-only Access app: ${e.message}`);
  }
}

async function ensureCloudflaredForCli(): Promise<void> {
  console.log();
  const hasCloudflared = await commandExists("cloudflared");
  if (hasCloudflared) return;

  const cloudflaredInstallUrl =
    "https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/";
  const hasBrew = process.platform === "darwin" && await commandExists("brew");

  if (hasBrew && await confirm("Install cloudflared with Homebrew (required for CLI login)?")) {
    const s = spinner("Installing cloudflared...");
    try {
      await run("brew", ["install", "cloudflared"]);
      s.stop("cloudflared installed");
      return;
    } catch (e: any) {
      s.stop();
      console.log(`  ${dim(`cloudflared install failed: ${e.message}`)}`);
    }
  }

  console.log(`  ${dim("cloudflared is required before running: sharehtml login")}`);
  console.log(`  ${dim(cloudflaredInstallUrl)}`);
}

async function maybeInstallAgentSkill(cliCmd: string): Promise<void> {
  console.log();
  if (!(await confirm("Install the sharehtml agent skill for supported coding agents?"))) {
    return;
  }

  try {
    if (cliCmd === "sharehtml") {
      await runInteractive("sharehtml", ["skill", "install"]);
    } else {
      await runInteractive("pnpm", ["sharehtml", "skill", "install"], { cwd: getRepoRoot() });
    }
  } catch (error: unknown) {
    console.log();
    console.log(`  ${dim("Skill install did not complete.")}`);
    console.log(`  ${dim("You can install it later with:")} ${cliCmd} skill install`);
    if (error instanceof Error) {
      console.log(`  ${dim(error.message)}`);
    }
  }
}

async function main() {
  console.log();
  console.log(`  ${bold("sharehtml")} setup`);
  console.log(`  ${dim("Deploy your worker and configure Cloudflare Access.")}`);
  console.log();

  // Detect wrangler CLI auth
  let s: ReturnType<typeof spinner>;
  s = spinner("Detecting wrangler configuration...");
  let wranglerAccount: { name: string; id: string } | undefined;
  let wranglerEmail: string | undefined;
  let whoamiOutput = "";
  try {
    whoamiOutput = await run("npx", ["wrangler", "whoami"]);
  } catch (e: any) {
    whoamiOutput = formatCommandError(e);
  }
  const accountMatch = whoamiOutput.match(/[│|]\s+(.+?)\s+[│|]\s+([a-f0-9]{32})\s+[│|]/);
  if (accountMatch) wranglerAccount = { name: accountMatch[1], id: accountMatch[2] };
  const emailMatch = whoamiOutput.match(/associated with the email (\S+@\S+\.\S+?)\.?\s/);
  if (emailMatch) wranglerEmail = emailMatch[1];

  if (!wranglerAccount) {
    s.stop();
    console.log();
    fail(
      "Could not detect a Cloudflare account in Wrangler.\n" +
        "Run `npx wrangler login` to connect your account, then run `pnpm run setup` again.",
    );
  }

  // Detect project config
  const configPath = findWranglerConfig();
  const config = parseWranglerConfig(configPath);
  s.stop();

  console.log(`  ${dim("worker")}    ${bold(config.name)}`);
  console.log(`  ${dim("account")}   ${wranglerAccount.name} ${dim(`(${wranglerAccount.id})`)}`)
  console.log();

  if (!(await confirm("Deploy to Cloudflare?"))) {
    process.exit(0);
  }

  const accountId = wranglerAccount.id;
  console.log();
  const useAccess = await confirm("Require authentication with Cloudflare Access?");
  let accessAud = "";
  let accessTeam = "";

  if (useAccess) {
    console.log();
    const cfTokenUrl = "https://dash.cloudflare.com/profile/api-tokens";
    console.log(`  Create a Cloudflare API token with these permissions:`);
    console.log(`    ${dim("-")} Access: Apps and Policies Edit`);
    console.log(`    ${dim("-")} Access: Organizations Read`);
    console.log(`    ${dim("-")} Workers Scripts Read ${dim("(to resolve workers.dev subdomain)")}`);
    console.log(`  ${dim("Used once to configure Access policies, then discarded.")}`);
    console.log();
    if (await confirm(`Open ${cyan(cfTokenUrl)}?`)) {
      openUrl(cfTokenUrl);
    }
    console.log();
    const cfToken = await promptSecret("Paste your API token:");
    console.log();

    s = spinner("Verifying token...", true);
    try {
      await cfApi(cfToken, "GET", "/user/tokens/verify");
      s.stop("Token verified");
    } catch (e: any) {
      s.stop();
      fail(`Invalid token: ${e.message}`);
    }

    // Resolve the workers.dev hostname so we can configure the Access app
    s = spinner("Resolving workers.dev hostname...", true);
    let hostname: string;
    try {
      const subdomainResult = await cfApi(cfToken, "GET", `/accounts/${accountId}/workers/subdomain`);
      hostname = `sharehtml.${subdomainResult.subdomain}.workers.dev`;
      s.stop(`Hostname: ${hostname}`);
    } catch {
      s.stop();
      fail(
        "Could not resolve workers.dev subdomain.\n" +
          "Ensure your API token has Workers Scripts Read permission, or deploy once first with `pnpm run deploy`.",
      );
    }

    while (true) {
      let existingPolicies: AccessPolicy[] = [];
      let existingApps: AccessApp[] = [];
      let browserApp: AccessApp;
      let selectedPolicies: SelectedPolicyState;

      try {
        s = spinner("Loading Access configuration...", true);
        ({ existingPolicies, existingApps } = await loadAccessConfiguration(cfToken, accountId));
        s.stop();

        const accessState = await inspectExistingAccessState(
          cfToken,
          accountId,
          hostname,
          config.name,
          existingApps,
        );
        const reusablePolicies = existingPolicies.filter(
          (policy: AccessPolicy) => policy.reusable && policy.decision === "allow",
        );
        selectedPolicies = await selectAccessPolicies(
          accessState.rootApp,
          accessState.rootPolicies,
          reusablePolicies,
          wranglerEmail,
        );

        s = spinner("Configuring Access...", true);
        browserApp = await reconcileRootAccessApp(
          cfToken,
          accountId,
          hostname,
          config.name,
          accessState.rootApp,
          selectedPolicies,
        );
        s.stop(`Access configured for ${selectedPolicies.policyLabels.join(", ")}`);

        await migrateLegacyApiAccessApp(
          cfToken,
          accountId,
          hostname,
          config.name,
          existingApps,
          existingPolicies,
        );

        const org = await cfApi(cfToken, "GET", `/accounts/${accountId}/access/organizations`);
        accessTeam = org.auth_domain.replace(".cloudflareaccess.com", "");
        accessAud = browserApp.aud ?? "";
        if (!accessAud) {
          fail("Access app was created but has no audience tag (aud). Check the Cloudflare dashboard.");
        }
        break;
      } catch (e: any) {
        s.stop();
        const message = e?.message || String(e);
        if (isAccessNotEnabledError(message)) {
          const shouldRetry = await retryAccessSetup(accountId);
          if (shouldRetry) continue;
          fail("Cloudflare Access setup cancelled.");
        }
        if (message.startsWith("Failed to remove legacy API-only Access app:")) {
          fail(message);
        }
        if (message.startsWith("Migration cancelled.")) {
          fail(message);
        }
        fail(`Access setup failed: ${message}`);
      }
    }
  }

  s = spinner("Updating wrangler.jsonc production vars...", true);
  const productionVars: Record<string, string> = useAccess
    ? { AUTH_MODE: "access", ACCESS_AUD: accessAud, ACCESS_TEAM: accessTeam }
    : { AUTH_MODE: "none" };
  try {
    writeWranglerProductionVars(configPath, productionVars);
    s.stop("Production vars updated");
  } catch (e: any) {
    s.stop();
    fail(`Failed to update wrangler.jsonc: ${e.message}`);
  }

  if (useAccess) {
    s = spinner("Ensuring production browser capability secret...", true);
    try {
      const status = await ensureProductionSecret("VIEWER_CAPABILITY_SECRET");
      s.stop(
        status === "created"
          ? "Browser capability secret created"
          : "Browser capability secret already configured",
      );
    } catch (e: any) {
      s.stop();
      fail(`Failed to configure VIEWER_CAPABILITY_SECRET: ${formatCommandError(e)}`);
    }
  }

  s = spinner("Deploying worker (production)...", true);
  let workerUrl: string;
  try {
    await run("npx", ["vite", "build"], { env: { CLOUDFLARE_ENV: "production" } });
    const output = await run("npx", ["wrangler", "deploy", "--env", "production"], { input: "y\n" });
    const urlMatch = output.match(/https:\/\/[\w.-]+\.workers\.dev/);
    if (!urlMatch) {
      throw new Error("Could not parse worker URL from deploy output.");
    }
    workerUrl = urlMatch[0];
    s.stop(`Deployed ${cyan(workerUrl)}`);
  } catch (e: any) {
    s.stop();
    const message = formatCommandError(e);
    if (isMissingR2Error(message)) {
      fail(getR2SetupMessage());
    }
    fail(`Deploy failed: ${message}`);
  }

  if (!useAccess) {
    console.log();
    console.log(`  ${dim("Note: anyone with the URL can view and comment.")}`);
    console.log(`  ${dim("Run setup again to add Cloudflare Access later.")}`);
  } else {
    console.log();
    console.log(`  ${dim("Note: wrangler.jsonc now contains your deployment config.")}`);
  }

  // CLI install
  console.log();
  let cliCmd = "pnpm sharehtml";
  let hasCli = false;
  try {
    await run("which", ["sharehtml"]);
    hasCli = true;
    cliCmd = "sharehtml";
  } catch {}

  if (!hasCli) {
    if (await confirm("Install the sharehtml CLI globally?")) {
      s = spinner("Installing CLI...");
      try {
        await run("pnpm", ["--filter", "@sharehtml/cli", "run", "build"]);
        await run("bun", ["link"], { cwd: resolve(import.meta.dirname, "../../cli") });
        s.stop("CLI installed");
        cliCmd = "sharehtml";
      } catch {
        s.stop();
        console.log(`  ${dim("Could not install globally. Use from the repo with:")} pnpm sharehtml`);
      }
    } else {
      console.log(`  ${dim("You can use the CLI from the repo with:")} pnpm sharehtml`);
    }
  }

  if (useAccess) {
    await ensureCloudflaredForCli();
  }

  await maybeInstallAgentSkill(cliCmd);

  // Done
  console.log();
  console.log(`  ${bold("Setup complete")}`);
  console.log();
  console.log(`    ${dim("$")} ${cliCmd} config set-url ${workerUrl}`);
  if (useAccess) {
    console.log(`    ${dim("$")} ${cliCmd} login`);
  }
  console.log(`    ${dim("$")} ${cliCmd} deploy my-page.html`);
  console.log();
}

main().catch((e) => {
  fail(e.message);
});
