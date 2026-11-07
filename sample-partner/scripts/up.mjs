// One command: demo infra → setup (keys, TLS, env, migrations, admin, game) → backend (detached) → partner
// registration via the admin API → sample partner and sample game (detached). Logs in .demo/logs, pids in .demo/pids.
import { join } from "node:path";
import { FUNLANDS_API, GAME_ORIGIN, PARTNER_ORIGIN, PORTS, ROOT, paths } from "../lib/config.mjs";
import { backendCommand } from "../lib/backend-process.mjs";
import { run, startDetached, waitFor } from "../lib/proc.mjs";
import { register } from "./register.mjs";

const node = process.execPath;
const step = (text) => console.log(`\n== ${text}`);

step("infra (dedicated PostgreSQL + Redis)");
run(node, [join(ROOT, "scripts", "infra.mjs"), "up"]);

step("setup");
run(node, [join(ROOT, "scripts", "setup.mjs"), ...process.argv.slice(2)]);

step("backend (PROCESS_ROLE=all)");
const backend = backendCommand();
const started = startDetached("backend", backend.command, backend.args, backend.options);
console.log(`backend pid ${started.pid}${started.alreadyRunning ? " (already running; restart with npm run down first to pick up a new env)" : ""}`);
await waitFor("backend /readyz", async () => (await fetch(`${FUNLANDS_API}/readyz`)).ok, 120_000);

step("register partner via admin API");
await register();

step("sample partner and sample game");
for (const [name, script] of [["partner", "partner/server.mjs"], ["game", "game/server.mjs"]]) {
  const proc = startDetached(name, node, [join(ROOT, script)], { cwd: ROOT, env: { ...process.env, NODE_EXTRA_CA_CERTS: paths.caCert } });
  console.log(`${name} pid ${proc.pid}${proc.alreadyRunning ? " (already running)" : ""}`);
}
await waitFor("game origin", async () => (await fetch(`${GAME_ORIGIN}/`)).ok, 20_000);
await waitFor("partner JWKS", async () => {
  const res = run("curl", ["-s", "--cacert", paths.caCert, "--resolve", `partner.localhost:${PORTS.partner}:127.0.0.1`, `${PARTNER_ORIGIN}/.well-known/jwks.json`], { quiet: true, allowFailure: true });
  return res.status === 0 && res.stdout.includes('"keys"');
}, 20_000);

console.log(`
Demo is up.
  Partner app (open in a browser):  ${PARTNER_ORIGIN}/   (demo CA: ${paths.caCert})
  Funlands game origin:             ${GAME_ORIGIN}/
  Funlands backend:                 ${FUNLANDS_API}  (logs: ${join(paths.logs, "backend.log")})
Run the headless check with: npm run e2e      Stop with: npm run down`);
