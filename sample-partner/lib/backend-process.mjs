// How the demo starts the Funlands backend: the built main checkout (dist/main.js), the generated .backend.env, and
// the demo-only loopback shim preloaded so the backend can reach the local partner's JWKS and webhook.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BACKEND_DIR, BACKEND_ENV_FILE, paths } from "./config.mjs";

export function readEnvFile(file = BACKEND_ENV_FILE) {
  if (!existsSync(file)) throw new Error(`${file} is missing: run \`npm run setup\` first`);
  const env = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) env[match[1]] = match[2];
  }
  return env;
}

export function backendCommand() {
  const main = join(BACKEND_DIR, "dist", "main.js");
  if (!existsSync(main)) throw new Error(`${main} is missing: build the backend first (cd ${BACKEND_DIR} && pnpm build)`);
  // Only PATH/HOME/locale are inherited, so no stray shell variable changes the backend configuration.
  const inherited = Object.fromEntries(["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR"].filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
  return {
    command: process.execPath,
    args: ["--require", paths.shim, main],
    options: { cwd: BACKEND_DIR, env: { ...inherited, ...readEnvFile() } },
  };
}
