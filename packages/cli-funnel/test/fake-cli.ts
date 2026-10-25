import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const win = process.platform === "win32";

/** Git for Windows ships `sh`. The runners have it; a developer machine may not have it on PATH. */
function windowsSh(): string {
  const git = join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "usr", "bin", "sh.exe");
  return existsSync(git) ? git : "sh";
}

/** A path as an sh script wants it: forward slashes, which MSYS sh and POSIX sh both accept. */
export const sh = (p: string): string => p.replaceAll("\\", "/");

/**
 * Writes a fake CLI that runs `body` with sh and returns the path to start it with. `base` is the path without an
 * extension. On POSIX the file has a shebang. On Windows it is `base.sh` behind a `base.cmd` wrapper, so the cmd.exe
 * branch of `cliCommand` runs for real. Paths embedded in `body` should go through `sh`.
 */
export function fakeShCli(base: string, body: string): string {
  if (!win) {
    writeFileSync(base, `#!/bin/sh\n${body}\n`);
    chmodSync(base, 0o755);
    return base;
  }
  writeFileSync(`${base}.sh`, `${body}\n`);
  writeFileSync(`${base}.cmd`, `@echo off\r\n"${windowsSh()}" "%~dp0${basename(base)}.sh" %*\r\n`);
  return `${base}.cmd`;
}

/**
 * Writes a fake CLI that runs `source` (CommonJS) with Node and returns the path to start it with. On Windows it is
 * `base.js` behind a `base.cmd` shim in the shape npm writes, so `shimTarget` and the Node branch of `cliCommand`
 * run for real.
 */
export function fakeNodeCli(base: string, source: string): string {
  if (!win) {
    writeFileSync(base, `#!/usr/bin/env node\n${source}\n`);
    chmodSync(base, 0o755);
    return base;
  }
  writeFileSync(`${base}.js`, `${source}\n`);
  writeFileSync(`${base}.cmd`, `@ECHO off\r\nSETLOCAL\r\nSET dp0=%~dp0\r\nSET _prog=node\r\n"%_prog%"  "%dp0%\\${basename(base)}.js" %*\r\n`);
  return `${base}.cmd`;
}
