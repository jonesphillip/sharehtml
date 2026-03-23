import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Command } from "commander";

type AgentName = "claude" | "codex" | "opencode";

const AGENT_NAMES = new Set<string>(["claude", "codex", "opencode"]);

interface AgentTarget {
  name: AgentName;
  label: string;
  detected: boolean;
  destination: string;
}

interface SelectOption {
  label: string;
  value: AgentName;
  selected: boolean;
}

function dim(text: string): string {
  return `\x1b[2m${text}\x1b[22m`;
}

function bold(text: string): string {
  return `\x1b[1m${text}\x1b[22m`;
}

function getSkillSourcePath(): string {
  const candidates = [
    resolve(import.meta.dirname, "../../../skills/sharehtml-collaboration"),
    resolve(import.meta.dirname, "../../../../skills/sharehtml-collaboration"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error("could not locate skills/sharehtml-collaboration");
}

function getTargets(): AgentTarget[] {
  return [
    {
      name: "claude",
      label: "Claude Code",
      detected: existsSync(resolve(homedir(), ".claude")),
      destination: resolve(homedir(), ".claude/skills/sharehtml-collaboration"),
    },
    {
      name: "codex",
      label: "Codex",
      detected: existsSync(resolve(homedir(), ".codex")),
      destination: resolve(homedir(), ".codex/skills/sharehtml-collaboration"),
    },
    {
      name: "opencode",
      label: "OpenCode",
      detected: existsSync(resolve(homedir(), ".config/opencode")) || existsSync(resolve(homedir(), ".opencode")),
      destination: resolve(homedir(), ".config/opencode/skills/sharehtml-collaboration"),
    },
  ];
}

async function commandExists(command: string): Promise<boolean> {
  return new Promise((resolveExists) => {
    const child = spawn("which", [command], { stdio: "ignore" });
    child.on("close", (code) => resolveExists(code === 0));
    child.on("error", () => resolveExists(false));
  });
}

async function detectAgent(target: AgentTarget): Promise<boolean> {
  return (await commandExists(target.name)) || target.detected;
}

async function multiSelect(title: string, options: SelectOption[]): Promise<SelectOption[]> {
  if (!process.stdin.isTTY) {
    return options.filter((option) => option.selected);
  }

  let cursor = 0;
  let rendered = false;
  const { stdin, stdout } = process;

  function render(): void {
    if (rendered) {
      stdout.write(`\x1b[${options.length}A`);
    }
    rendered = true;
    for (let index = 0; index < options.length; index += 1) {
      const option = options[index];
      const pointer = index === cursor ? ">" : " ";
      const check = option.selected ? "[x]" : "[ ]";
      const line = `  ${pointer} ${check} ${option.label}`;
      stdout.write(`\r\x1b[K${index === cursor ? bold(line) : line}\n`);
    }
  }

  return new Promise((resolveSelection) => {
    console.log(`  ${title}`);
    console.log(`  ${dim("up/down navigate, space toggle, enter confirm")}`);
    console.log();
    render();

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf-8");

    function cleanup(): void {
      stdin.setRawMode(false);
      stdin.removeListener("data", onData);
      stdin.pause();
    }

    function onData(key: string): void {
      if (key === "\x03") {
        cleanup();
        process.stdout.write("\n");
        process.exit(1);
      }

      if (key === "\r" || key === "\n") {
        cleanup();
        resolveSelection(options.filter((option) => option.selected));
        return;
      }

      if (key === " ") {
        options[cursor].selected = !options[cursor].selected;
        render();
        return;
      }

      if (key === "\x1b[A" || key === "k") {
        cursor = (cursor - 1 + options.length) % options.length;
        render();
        return;
      }

      if (key === "\x1b[B" || key === "j") {
        cursor = (cursor + 1) % options.length;
        render();
      }
    }

    stdin.on("data", onData);
  });
}

function isAgentName(value: string): value is AgentName {
  return AGENT_NAMES.has(value);
}

function normalizeAgents(values: string[]): AgentName[] {
  const normalized = new Set<AgentName>();

  for (const value of values) {
    const parts = value.split(",").map((part) => part.trim()).filter(Boolean);
    for (const part of parts) {
      if (isAgentName(part)) {
        normalized.add(part);
        continue;
      }
      throw new Error(`unknown agent '${part}'. Use claude, codex, or opencode.`);
    }
  }

  return Array.from(normalized);
}

function formatTargetLabel(target: AgentTarget): string {
  const status = target.detected ? dim("detected") : dim("not detected");
  return `${target.label} ${status} ${dim(target.destination)}`;
}

async function resolveSelectedTargets(agentArgs: string[]): Promise<AgentTarget[]> {
  const rawTargets = getTargets();
  const detectedTargets: AgentTarget[] = [];

  for (const target of rawTargets) {
    const detected = await detectAgent(target);
    detectedTargets.push({ ...target, detected });
  }

  const explicitAgents = normalizeAgents(agentArgs);
  if (explicitAgents.length > 0) {
    return detectedTargets.filter((target) => explicitAgents.includes(target.name));
  }

  const options = detectedTargets.map((target) => ({
    label: formatTargetLabel(target),
    value: target.name,
    selected: target.detected,
  }));
  const selected = await multiSelect("Install the sharehtml agent skill for:", options);
  const selectedNames = new Set(selected.map((option) => option.value));
  return detectedTargets.filter((target) => selectedNames.has(target.name));
}

const installSkillCmd = new Command("install")
  .description("Install the sharehtml agent skill for supported coding agents")
  .option("--agent <agent>", "Install for a specific agent (claude, codex, or opencode)", (value, previous: string[] = []) => {
    previous.push(value);
    return previous;
  }, [])
  .action(async (opts: { agent: string[] }) => {
    try {
      const targets = await resolveSelectedTargets(opts.agent || []);
      if (targets.length === 0) {
        console.log("No agent targets selected.");
        return;
      }

      console.log();
      const sourcePath = getSkillSourcePath();
      for (const target of targets) {
        await rm(target.destination, { recursive: true, force: true });
        await mkdir(resolve(target.destination, ".."), { recursive: true });
        await cp(sourcePath, target.destination, { recursive: true });
        console.log(`  Installed ${bold("sharehtml-collaboration")} for ${target.label}`);
        console.log(`    ${dim(target.destination)}`);
      }
      console.log();
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

export const skillCmd = new Command("skill")
  .description("Install or update the sharehtml agent skill")
  .addCommand(installSkillCmd);
