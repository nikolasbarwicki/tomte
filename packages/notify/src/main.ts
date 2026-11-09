#!/usr/bin/env bun
import { homedir } from "node:os";

import { run } from "./cli.ts";

process.exitCode = await run(process.argv.slice(2), {
  env: process.env,
  cwd: process.cwd(),
  home: process.env.HOME ?? homedir(),
  out: (line) => console.log(line),
  err: (line) => console.error(line),
});
