import { join } from "node:path";
import { FUNLANDS_API, GAME_ORIGIN, PARTNER_ORIGIN, ROOT } from "../lib/config.mjs";
import { pidOf, run } from "../lib/proc.mjs";

for (const name of ["backend", "partner", "game"]) console.log(`${name.padEnd(8)} ${pidOf(name) ? `pid ${pidOf(name)}` : "not running"}`);
run(process.execPath, [join(ROOT, "scripts", "infra.mjs"), "status"]);
console.log(`\npartner app ${PARTNER_ORIGIN}/\ngame origin ${GAME_ORIGIN}/\nbackend     ${FUNLANDS_API}`);
