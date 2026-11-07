// The sample partner: its web app (a pretend signed-in player who clicks Play), JWKS, webhook receiver, OAuth
// reports client and back-channel logout. HTTPS on https://partner.localhost:4443 (Funlands only trusts https).
import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:https";
import { FUNLANDS, GAME_ORIGIN, PARTNER, PARTNER_ORIGIN, PORTS, paths, requireState } from "../lib/config.mjs";
import { backchannelLogout, FunlandsApiClient, FunlandsApiError, tehranDate, verifySet, SetRejected } from "../lib/funlands-client.mjs";
import { createLaunchForm, partnerJwks } from "../lib/partner-crypto.mjs";
import { renderAppPage } from "./app-page.mjs";

const state = requireState("partner", "game");
const api = new FunlandsApiClient(state.partner.clientId);
const games = [{ id: state.game.id, title: state.game.title }];

// --- players of this partner (in memory): browser cookie → pairwise sub + current partner session id (sid) ------
const players = new Map();
const COOKIE = "sp_uid";
function playerFor(req, res) {
  const cookie = Object.fromEntries((req.headers.cookie ?? "").split(";").map((part) => part.trim().split("=")).filter((kv) => kv.length === 2));
  let uid = cookie[COOKIE];
  if (!uid || !players.has(uid)) {
    uid = randomBytes(16).toString("base64url");
    players.set(uid, { sub: `sp-player-${randomBytes(6).toString("hex")}`, sid: newSid(), nickname: "Sara", ageBand: "13-17", logouts: [] });
    res.setHeader("set-cookie", `${COOKIE}=${uid}; Path=/; HttpOnly; Secure; SameSite=Lax`);
  }
  return players.get(uid);
}
const newSid = () => `sp-sess-${randomUUID()}`;

// --- received webhooks ---------------------------------------------------------------------------------------
const received = [];
const seenEventIds = new Set();
mkdirSync(paths.logs, { recursive: true });

async function receiveWebhook(req, body) {
  const record = { received_at: new Date().toISOString(), content_type: req.headers["content-type"] ?? null };
  try {
    if (!String(record.content_type).startsWith("application/secevent+jwt")) throw new SetRejected(400, "wrong content type");
    const set = await verifySet(body.toString("ascii").trim());
    record.verified = true;
    record.jti = set.claims.jti;
    record.iss = set.claims.iss;
    record.aud = set.claims.aud;
    record.kid = set.header.kid;
    record.events = set.events.map((event) => ({ ...event, duplicate: seenEventIds.has(event.event_id) }));
    for (const event of set.events) seenEventIds.add(event.event_id);
    record.status = 202;
  } catch (error) {
    record.verified = false;
    record.error = error.message;
    record.status = error instanceof SetRejected ? error.status : 500;
  }
  received.unshift(record);
  received.length = Math.min(received.length, 500);
  appendFileSync(paths.webhooks, `${JSON.stringify(record)}\n`);
  console.log(`webhook ${record.status} ${record.verified ? record.events.map((e) => `${e.short_type}(${e.subject?.sub} #${e.player_seq})`).join(", ") : record.error}`);
  return record.status;
}

// --- reports via OAuth -----------------------------------------------------------------------------------------
async function attempt(work) {
  try {
    return { ok: true, body: await work() };
  } catch (error) {
    return { ok: false, status: error.status ?? null, code: error.code ?? null, error: error.message, body: error.body ?? null };
  }
}

async function reports(sub) {
  const today = tehranDate();
  const token = await attempt(async () => {
    const t = await api.accessToken();
    return { token_type: "Bearer", scope: t.scope, expires_in: t.expiresIn };
  });
  const range = { from: today, to: today };
  return {
    range,
    oauth_token: token,
    summary: await attempt(() => api.get("/partner/v1/metrics/summary", range)),
    daily: await attempt(() => api.get("/partner/v1/metrics/daily", range)),
    games: await attempt(() => api.get("/partner/v1/games", range)),
    ...(sub && {
      player: await attempt(() => api.get(`/partner/v1/players/${encodeURIComponent(sub)}`)),
      activity: await attempt(() => api.get(`/partner/v1/players/${encodeURIComponent(sub)}/activity`)),
    }),
  };
}

// --- HTTP plumbing ---------------------------------------------------------------------------------------------
function send(res, status, body, headers = {}) {
  const json = typeof body !== "string";
  res.writeHead(status, {
    "content-type": json ? "application/json; charset=utf-8" : "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(json ? JSON.stringify(body, null, 2) : body);
}

async function readBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// State-changing browser calls must come from this partner's own pages.
const sameOrigin = (req) => req.headers.origin === PARTNER_ORIGIN;

async function handle(req, res) {
  const url = new URL(req.url ?? "/", PARTNER_ORIGIN);
  const route = `${req.method} ${url.pathname}`;
  try {
    if (route === "GET /.well-known/jwks.json") return send(res, 200, partnerJwks(), { "cache-control": "public, max-age=300" });
    if (route === "POST /funlands/events") {
      const status = await receiveWebhook(req, await readBody(req));
      res.writeHead(status).end();
      return;
    }
    if (route === "GET /favicon.ico") return res.writeHead(204).end();
    if (route === "GET /") {
      const player = playerFor(req, res);
      const nonce = randomBytes(16).toString("base64");
      return send(res, 200, renderAppPage({ nonce, player, games, gameOrigin: GAME_ORIGIN, launchUrl: FUNLANDS.launchUrl, partnerKey: state.partner.partnerKey }), {
        // Funlands needs the real Origin on the cross-origin launch POST. Production (https → https) uses
        // strict-origin-when-cross-origin; this demo posts from https to a plain-http loopback game origin, a
        // "downgrade" for which strict-* policies make the browser send `Origin: null` (ORIGIN_NOT_ALLOWED).
        "referrer-policy": "origin-when-cross-origin",
        "content-security-policy": [
          "default-src 'none'", `script-src 'nonce-${nonce}'`, `style-src 'nonce-${nonce}'`, "connect-src 'self'",
          `frame-src ${GAME_ORIGIN}`, `form-action ${GAME_ORIGIN}`, "img-src 'self' data:", "base-uri 'none'", "frame-ancestors 'none'",
        ].join("; "),
      });
    }
    if (route === "GET /api/session") {
      const player = playerFor(req, res);
      return send(res, 200, { sub: player.sub, sid: player.sid, nickname: player.nickname, logouts: player.logouts });
    }
    if (route === "POST /api/launch") {
      if (!sameOrigin(req)) return send(res, 403, { error: "cross-origin" });
      const player = playerFor(req, res);
      const { game } = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      if (!games.some((g) => g.id === game)) return send(res, 404, { error: "unknown game" });
      // Fresh token + verifier for every launch; the page posts them straight into the game frame.
      return send(res, 200, { ...(await createLaunchForm(player, game)), launch_url: FUNLANDS.launchUrl, sub: player.sub, sid: player.sid });
    }
    if (route === "POST /api/logout") {
      if (!sameOrigin(req)) return send(res, 403, { error: "cross-origin" });
      const player = playerFor(req, res);
      const ended = { sub: player.sub, sid: player.sid };
      try {
        const result = await backchannelLogout(ended);
        player.logouts.push({ ...ended, at: new Date().toISOString() });
        player.sid = newSid(); // the partner session is over; the next Play starts a new one
        return send(res, 200, { logged_out: ended, funlands_status: result.status, funlands_body: result.body, next_sid: player.sid });
      } catch (error) {
        return send(res, 502, { error: error.message, code: error.code ?? null, funlands_status: error.status ?? null });
      }
    }
    if (route === "GET /api/webhooks") {
      const sub = url.searchParams.get("sub");
      const list = sub ? received.filter((r) => !r.verified || r.events.some((e) => e.subject?.sub === sub)) : received;
      return send(res, 200, { count: list.length, items: list });
    }
    if (route === "GET /api/reports") {
      const sub = url.searchParams.get("sub") ?? playerFor(req, res).sub;
      return send(res, 200, await reports(sub));
    }
    if (route === "GET /api/events") {
      const sub = url.searchParams.get("sub");
      const items = await api.eventFeed();
      return send(res, 200, { count: items.length, items: sub ? items.filter((item) => item.subject?.sub === sub) : items });
    }
    return send(res, 404, { error: "not found" });
  } catch (error) {
    console.error(route, error);
    return send(res, error instanceof FunlandsApiError ? 502 : 500, { error: error.message, code: error.code ?? null });
  }
}

const tls = { key: readFileSync(paths.partnerKey), cert: readFileSync(paths.partnerCert) };
// Browsers may resolve partner.localhost to ::1 or 127.0.0.1; listen on both loopback addresses only.
for (const host of ["127.0.0.1", "::1"]) {
  createServer(tls, (req, res) => void handle(req, res))
    .on("error", (error) => console.error(`listen ${host}: ${error.message}`))
    .listen(PORTS.partner, host, () => console.log(`sample partner on ${PARTNER_ORIGIN} (${host})`));
}
console.log(`issuer ${PARTNER.issuer}, JWKS ${PARTNER.jwksUri}, webhook ${PARTNER.webhookUri}, client_id ${state.partner.clientId}`);
