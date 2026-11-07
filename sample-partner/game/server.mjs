// The sample game on the Funlands game origin (PARTNER_GAME_ORIGIN = http://localhost:4200).
// It serves the game at /play/{game} and reverse-proxies /v1/* to the backend, so the launch handoff page
// (/v1/partner/launch), /v1/session/bootstrap and the game's API calls are all same-origin, as the backend requires.
import { readFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FUNLANDS_API, GAME_ORIGIN, PARTNER_ORIGIN, PORTS, requireState } from "../lib/config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const state = requireState("partner", "game");
const backend = new URL(FUNLANDS_API);
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer"]);

function proxy(req, res) {
  const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => !HOP_BY_HOP.has(name)));
  headers.host = backend.host; // Origin is forwarded untouched: launch and bootstrap check it exactly
  const upstream = request({ host: backend.hostname, port: backend.port, method: req.method, path: req.url, headers }, (reply) => {
    const out = Object.fromEntries(Object.entries(reply.headers).filter(([name]) => !HOP_BY_HOP.has(name)));
    res.writeHead(reply.statusCode ?? 502, out);
    reply.pipe(res);
  });
  upstream.on("error", (error) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: "UPSTREAM_UNAVAILABLE", message: error.message }));
  });
  req.pipe(upstream);
}

const page = (file) => readFileSync(join(here, file), "utf8");

function handle(req, res) {
  const url = new URL(req.url ?? "/", GAME_ORIGIN);
  if (url.pathname.startsWith("/v1/")) return proxy(req, res);
  const play = /^\/play\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/.exec(url.pathname);
  if (req.method === "GET" && play) {
    // The game page holds no partner credentials: the player's access token carries the partner scope.
    const config = { game: decodeURIComponent(play[1]), partnerOrigin: PARTNER_ORIGIN };
    const html = page("game.html").replace("__CONFIG__", JSON.stringify(config).replace(/</g, "\\u003c"));
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "same-origin",
      "content-security-policy": `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors ${PARTNER_ORIGIN}; base-uri 'none'; form-action 'none'`,
    });
    return res.end(html);
  }
  if (req.method === "GET" && (url.pathname === "/game.js" || url.pathname === "/game.css")) {
    res.writeHead(200, { "content-type": url.pathname.endsWith(".js") ? "text/javascript" : "text/css", "cache-control": "no-store" });
    return res.end(page(url.pathname.slice(1)));
  }
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    return res.end(`Funlands sample game origin. Games open at /play/<game> after a partner launch.\nDemo game: /play/${state.game.id}\n`);
  }
  res.writeHead(404, { "content-type": "text/plain" }).end("not found");
}

for (const host of ["127.0.0.1", "::1"]) {
  createServer(handle)
    .on("error", (error) => console.error(`listen ${host}: ${error.message}`))
    .listen(PORTS.game, host, () => console.log(`sample game origin ${GAME_ORIGIN} (${host}) → proxy /v1/* to ${FUNLANDS_API}`));
}
