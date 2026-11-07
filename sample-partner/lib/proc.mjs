// Small helpers to start detached demo processes with pid files and to wait for ports.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./config.mjs";

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: options.quiet ? "pipe" : "inherit", encoding: "utf8", ...options });
  if (result.status !== 0 && !options.allowFailure)
    throw new Error(`${command} ${args.join(" ")} failed (${result.status})${result.stderr ? `: ${result.stderr}` : ""}`);
  return result;
}

export function pidOf(name) {
  const file = join(paths.pids, `${name}.pid`);
  if (!existsSync(file)) return null;
  const pid = Number(readFileSync(file, "utf8").trim());
  return isAlive(pid) ? pid : null;
}

export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Starts `command` detached, stdout/stderr appended to .demo/logs/<name>.log, pid in .demo/pids/<name>.pid. */
export function startDetached(name, command, args, options = {}) {
  const existing = pidOf(name);
  if (existing) return { pid: existing, alreadyRunning: true };
  mkdirSync(paths.logs, { recursive: true });
  mkdirSync(paths.pids, { recursive: true });
  const log = openSync(join(paths.logs, `${name}.log`), "a");
  const child = spawn(command, args, { detached: true, stdio: ["ignore", log, log], ...options });
  child.unref();
  writeFileSync(join(paths.pids, `${name}.pid`), String(child.pid));
  return { pid: child.pid, alreadyRunning: false };
}

export async function stopProcess(name) {
  const pid = pidOf(name);
  rmSync(join(paths.pids, `${name}.pid`), { force: true });
  if (!pid) return false;
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 100 && isAlive(pid); i++) await sleep(100);
  if (isAlive(pid)) process.kill(pid, "SIGKILL");
  return true;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(label, check, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}
