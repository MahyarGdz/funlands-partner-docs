// Stops the demo processes started by `npm run up` (game, partner, backend). `--all` also stops PostgreSQL and Redis.
import { join } from "node:path";
import { ROOT } from "../lib/config.mjs";
import { run, stopProcess } from "../lib/proc.mjs";

for (const name of ["game", "partner", "backend"]) console.log(`${name}: ${(await stopProcess(name)) ? "stopped" : "not running"}`);
if (process.argv.includes("--all")) run(process.execPath, [join(ROOT, "scripts", "infra.mjs"), "down"]);
