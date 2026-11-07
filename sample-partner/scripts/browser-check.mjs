// Optional: walks the BROWSER flow in a throwaway headless Chrome over the DevTools protocol (needs Google Chrome;
// set CHROME_PATH otherwise): partner page → Play → game frame bootstraps → a round + score → frame reload asks the
// partner for a relaunch → back-channel logout → the frame shows the session dead. Screenshots in .demo/browser/.
// The throwaway profile accepts the demo's self-signed certificate (CDP Security.setIgnoreCertificateErrors) for this
// session only; nothing is installed or trusted system-wide.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEMO_DIR, PARTNER_ORIGIN } from "../lib/config.mjs";
const out = join(DEMO_DIR, "browser");
mkdirSync(out, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), "fl-demo-chrome-"));
const chrome = spawn(process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "about:blank",
], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(2500);
const portFile = join(profile, "DevToolsActivePort");
for (let i = 0; i < 40 && !existsSync(portFile); i++) await sleep(250);
const port = readFileSync(portFile, "utf8").split("\n")[0];
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0; const pending = new Map(); const consoleLines = [];
ws.addEventListener("message", (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === "Runtime.consoleAPICalled") consoleLines.push(msg.params.args.map((a) => a.value).join(" "));
  if (msg.method === "Runtime.exceptionThrown") consoleLines.push("EXC " + JSON.stringify(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text));
  if (msg.method === "Log.entryAdded") consoleLines.push(`LOG ${msg.params.entry.level} ${msg.params.entry.text}`);
});
const send = (method, params = {}, sessionId) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId && { sessionId }) })); });
let frameSession = null;
ws.addEventListener("message", (m) => { const msg = JSON.parse(m.data); if (msg.method === "Target.attachedToTarget" && msg.params.targetInfo.type === "iframe") { frameSession = msg.params.sessionId; send("Runtime.enable", {}, frameSession); send("Runtime.runIfWaitingForDebugger", {}, frameSession); } });
await send("Security.setIgnoreCertificateErrors", { ignore: true }); await send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false }); await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }); await send("Page.enable"); await send("Runtime.enable"); await send("Log.enable");
const evalMain = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
async function evalFrame(expr) {
  if (!frameSession) return { error: "no frame session" };
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, frameSession);
  return { value: r.result?.result?.value ?? r.result?.exceptionDetails?.text ?? r.error };
}
const shot = async (name) => { const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(join(out, name), Buffer.from(r.result.data, "base64")); };
const frameState = `({url: location.pathname, status: document.getElementById('status')?.textContent, player: document.getElementById('player')?.textContent, log: [...document.querySelectorAll('#log li')].map(l=>l.textContent)})`;

await send("Page.navigate", { url: `${PARTNER_ORIGIN}/` });
await sleep(2500);
console.log("1 partner page:", await evalMain("document.title + ' | ' + document.querySelector('.who').innerText"));
await evalMain("document.querySelector('[id^=play-]').click()");
await sleep(4000);
console.log("2 after Play:", JSON.stringify(await evalFrame(frameState)));
console.log("  notice:", await evalMain("document.getElementById('notice').textContent"));
await evalFrame("document.getElementById('start').click()");
await sleep(1500);
for (let i = 0; i < 5; i++) { await evalFrame("document.getElementById('star').click()"); await sleep(150); }
await sleep(10500);
await evalFrame("document.getElementById('leaderboard').click(); document.getElementById('history').click()");
await sleep(1500);
console.log("3 after round:", JSON.stringify(await evalFrame(frameState)));
await sleep(3000);
await shot("1-playing.png");
console.log("4 webhooks:", await evalMain("document.getElementById('hooks').innerText"));
// reload the game frame: the game has no session and asks the partner for a relaunch
await evalFrame("location.reload()");
await sleep(5000);
console.log("5 after frame reload (relaunch):", JSON.stringify(await evalFrame(frameState)));
await evalMain("document.getElementById('logout').click()");
await sleep(5000);
console.log("6 logout panel:", await evalMain("document.getElementById('logoutOut').textContent"));
console.log("7 game after logout:", JSON.stringify(await evalFrame(frameState)));
await evalMain("document.getElementById('reports').click()");
await sleep(2500);
console.log("8 reports:", (await evalMain("document.getElementById('apiOut').textContent")).slice(0, 400));
await sleep(2000);
console.log("9 webhooks:", await evalMain("document.getElementById('hooks').innerText"));
await shot("2-logged-out.png");
console.log(`screenshots: ${out}`);
chrome.kill();
await sleep(500);
rmSync(profile, { recursive: true, force: true });
process.exit(0);
