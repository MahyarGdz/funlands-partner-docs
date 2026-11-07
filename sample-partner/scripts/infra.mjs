// Dedicated demo PostgreSQL 17 and Redis on their own ports (never a shared test Redis or database).
//   node scripts/infra.mjs up | down | status
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATABASE_NAME, PORTS, paths } from "../lib/config.mjs";
import { run } from "../lib/proc.mjs";

const pg = (bin) => join(paths.pgBin, bin);
const env = { ...process.env, LC_ALL: "en_US.UTF-8" };
const redisPidFile = join(paths.pgSocketDir, "redis.pid");

function redisUp() {
  const ping = run("redis-cli", ["-p", String(PORTS.redis), "ping"], { quiet: true, allowFailure: true });
  if (ping.stdout?.trim() === "PONG") return console.log(`redis already up on 127.0.0.1:${PORTS.redis}`);
  run("redis-server", [
    "--port", String(PORTS.redis), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no", "--daemonize", "yes",
    "--pidfile", redisPidFile, "--logfile", join(paths.pgSocketDir, "redis.log"),
  ]);
  console.log(`redis started on 127.0.0.1:${PORTS.redis}`);
}

function postgresUp() {
  if (!existsSync(join(paths.pgData, "PG_VERSION"))) {
    run(pg("initdb"), ["-D", paths.pgData, "-U", "postgres", "--auth=trust", "-E", "UTF8"], { env, quiet: true });
  }
  const status = run(pg("pg_ctl"), ["-D", paths.pgData, "status"], { env, quiet: true, allowFailure: true });
  if (status.status !== 0) {
    run(pg("pg_ctl"), [
      "-D", paths.pgData, "-l", join(paths.pgSocketDir, "pg.log"), "-w",
      "-o", `-p ${PORTS.postgres} -k ${paths.pgSocketDir} -c listen_addresses=127.0.0.1`, "start",
    ], { env, quiet: true });
    console.log(`postgres started on 127.0.0.1:${PORTS.postgres} (data ${paths.pgData})`);
  } else console.log(`postgres already up on 127.0.0.1:${PORTS.postgres}`);
  const exists = run(pg("psql"), ["-h", "127.0.0.1", "-p", String(PORTS.postgres), "-U", "postgres", "-Atc",
    `select 1 from pg_database where datname='${DATABASE_NAME}'`], { quiet: true });
  if (exists.stdout.trim() !== "1") {
    run(pg("psql"), ["-h", "127.0.0.1", "-p", String(PORTS.postgres), "-U", "postgres", "-c", `create database ${DATABASE_NAME}`], { quiet: true });
    console.log(`database ${DATABASE_NAME} created`);
  }
}

function down() {
  run("redis-cli", ["-p", String(PORTS.redis), "shutdown", "nosave"], { quiet: true, allowFailure: true });
  run(pg("pg_ctl"), ["-D", paths.pgData, "-m", "fast", "stop"], { env, quiet: true, allowFailure: true });
  console.log("demo postgres and redis stopped");
}

const command = process.argv[2] ?? "up";
mkdirSync(paths.pgSocketDir, { recursive: true });
if (command === "up") {
  redisUp();
  postgresUp();
} else if (command === "down") down();
else if (command === "status") {
  console.log(run("redis-cli", ["-p", String(PORTS.redis), "ping"], { quiet: true, allowFailure: true }).stdout?.trim() || "redis down");
  console.log(run(pg("pg_ctl"), ["-D", paths.pgData, "status"], { env, quiet: true, allowFailure: true }).stdout.split("\n")[0]);
} else throw new Error(`unknown command ${command}`);
