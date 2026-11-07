// Runs the Funlands backend in the foreground with the demo env (PROCESS_ROLE=all: API plus outbox/webhook workers).
import { spawn } from "node:child_process";
import { backendCommand } from "../lib/backend-process.mjs";

const { command, args, options } = backendCommand();
const child = spawn(command, args, { ...options, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code ?? 0));
