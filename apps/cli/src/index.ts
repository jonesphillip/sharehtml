#!/usr/bin/env bun
import { Command } from "commander";
import { deployCmd } from "./commands/deploy.js";
import { listCmd } from "./commands/list.js";
import { openCmd } from "./commands/open.js";
import { deleteCmd } from "./commands/delete.js";
import { pullCmd } from "./commands/pull.js";
import { diffCmd } from "./commands/diff.js";
import { commentsCmd } from "./commands/comments.js";
import { skillCmd } from "./commands/skill.js";
import { configCmd } from "./commands/config.js";
import { loginCmd } from "./commands/login.js";
import { shareCmd } from "./commands/share.js";
import { unshareCmd } from "./commands/unshare.js";

const program = new Command();

program
  .name("sharehtml")
  .description("Deploy HTML documents with collaborative commenting")
  .version("0.0.1");

program.addCommand(deployCmd);
program.addCommand(listCmd);
program.addCommand(openCmd);
program.addCommand(deleteCmd);
program.addCommand(pullCmd);
program.addCommand(diffCmd);
program.addCommand(commentsCmd);
program.addCommand(shareCmd);
program.addCommand(unshareCmd);
program.addCommand(skillCmd);
program.addCommand(configCmd);
program.addCommand(loginCmd);

program.parse();
