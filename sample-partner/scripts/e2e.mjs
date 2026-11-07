// Headless end-to-end run against the RUNNING demo (start it first with `npm run up`). It drives the same HTTP the
// browser does — partner app API → Funlands launch (HTML handoff) → bootstrap → game APIs → webhooks / feed /
// reports → back-channel logout — and prints PASS/FAIL per step. Exit code 1 on the first failure.
import { spawnSync } from "node:child_process";
import { decodeJwt, decodeProtectedHeader } from "jose";
import { FUNLANDS, FUNLANDS_API, GAME_ORIGIN, PARTNER, PARTNER_ORIGIN, paths, requireState } from "../lib/config.mjs";

// Node must trust the demo CA to talk to https://partner.localhost; re-exec once with it.
if (!process.env.NODE_EXTRA_CA_CERTS) {
  const result = spawnSync(process.execPath, process.argv.slice(1), { stdio: "inherit", env: { ...process.env, NODE_EXTRA_CA_CERTS: paths.caCert } });
  process.exit(result.status ?? 1);
}

const state = requireState("partner", "game");
const GAME = state.game.id;
const results = [];
let cookie = "";

class StepFailed extends Error {}
const expect = (condition, message) => {
  if (!condition) throw new StepFailed(message);
};
async function step(name, work) {
  const started = Date.now();
  try {
    const evidence = await work();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}  (${Date.now() - started} ms)${evidence ? `\n      ${evidence}` : ""}`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(`FAIL  ${name}\n      ${error.message}`);
    summary();
    process.exit(1);
  }
}
function summary() {
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} steps passed${passed === results.length ? " — END TO END OK" : ""}`);
}

async function http(url, { method = "GET", headers = {}, body, form } = {}) {
  const init = { method, headers: { ...headers }, redirect: "manual" };
  if (form) {
    init.headers["content-type"] = "application/x-www-form-urlencoded";
    init.body = new URLSearchParams(form).toString();
  } else if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, text, json };
}
// The partner app's browser API, with its session cookie and its own Origin.
async function partner(path, options = {}) {
  const res = await http(`${PARTNER_ORIGIN}${path}`, { ...options, headers: { origin: PARTNER_ORIGIN, cookie, ...options.headers } });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  return res;
}
const codeOf = (res) => res.json?.code ?? res.json?.error ?? res.json?.data?.code;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function poll(label, read, ready, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (ready(value)) return value;
    await sleep(1_000);
  }
  throw new StepFailed(`${label} not reached in ${timeoutMs / 1000}s; last: ${JSON.stringify(value).slice(0, 600)}`);
}

console.log(`Funlands sample partner e2e\n  backend ${FUNLANDS_API}\n  game origin ${GAME_ORIGIN}\n  partner ${PARTNER_ORIGIN} (${state.partner.partnerKey})\n  game ${GAME}\n`);

let player, form, handoff, tokens, playSessionId, gameHeaders;
const score = 40 + Math.floor(Math.random() * 50) * 10;

await step("0  stack is up: backend ready, Funlands JWKS, partner JWKS, game origin", async () => {
  expect((await http(`${FUNLANDS_API}/readyz`)).status === 200, "backend /readyz not 200");
  const jwks = await http(FUNLANDS.jwksUrl);
  expect(jwks.json?.keys?.length > 0, "Funlands JWKS has no keys");
  const partnerJwks = await http(PARTNER.jwksUri);
  expect(partnerJwks.json?.keys?.[0]?.kid === PARTNER.kid && !("d" in partnerJwks.json.keys[0]), "partner JWKS wrong");
  expect((await http(`${GAME_ORIGIN}/`)).status === 200, "game origin down");
  return `Funlands kid ${jwks.json.keys.map((k) => k.kid).join(",")}; partner kid ${partnerJwks.json.keys[0].kid}`;
});

await step("1  partner app: signed-in player with pairwise sub and partner session sid", async () => {
  const res = await partner("/api/session");
  expect(res.status === 200 && res.json.sub && res.json.sid, `session ${res.status}`);
  player = res.json;
  return `sub ${player.sub}, sid ${player.sid}`;
});

await step("2  partner backend signs a launch token (ES256, typ funlands-launch+jwt, exp-iat<=120, S256 challenge)", async () => {
  const res = await partner("/api/launch", { method: "POST", body: { game: GAME } });
  expect(res.status === 200, `launch form ${res.status} ${res.text}`);
  form = res.json;
  const header = decodeProtectedHeader(form.launch_token);
  const claims = decodeJwt(form.launch_token);
  expect(header.alg === "ES256" && header.typ === "funlands-launch+jwt" && header.kid === PARTNER.kid, "bad header");
  expect(claims.aud === FUNLANDS.launchAudience && claims.iss === PARTNER.issuer && claims.sub === player.sub && claims.sid === player.sid, "bad claims");
  expect(claims.exp - claims.iat <= 120 && claims.game === GAME, "bad lifetime/game");
  return `kid ${header.kid}, aud ${claims.aud}, lifetime ${claims.exp - claims.iat}s, jti ${claims.jti}`;
});

await step("3  Funlands refuses a launch from an unregistered Origin (ORIGIN_NOT_ALLOWED)", async () => {
  const other = (await partner("/api/launch", { method: "POST", body: { game: GAME } })).json;
  const res = await http(FUNLANDS.launchUrl, {
    method: "POST",
    headers: { origin: "https://evil.localhost", accept: "application/json" },
    form: { launch_token: other.launch_token, game: GAME, bootstrap_verifier: other.bootstrap_verifier },
  });
  expect(res.status === 403 && codeOf(res) === "ORIGIN_NOT_ALLOWED", `got ${res.status} ${codeOf(res)}`);
  return `403 ${codeOf(res)}`;
});

await step("4  launch: form POST to the game origin returns the handoff page (frame-ancestors = partner origin)", async () => {
  const res = await http(FUNLANDS.launchUrl, {
    method: "POST",
    headers: { origin: PARTNER_ORIGIN, accept: "text/html" },
    form: { launch_token: form.launch_token, game: form.game, bootstrap_verifier: form.bootstrap_verifier },
  });
  expect(res.status === 200, `launch ${res.status} ${res.text.slice(0, 300)}`);
  const csp = res.headers.get("content-security-policy") ?? "";
  expect(csp.includes(`frame-ancestors ${PARTNER_ORIGIN}`), `CSP ${csp}`);
  const block = /<script type="application\/json" id="funlands-launch">([^<]*)<\/script>/.exec(res.text);
  expect(block, "no handoff data block");
  handoff = JSON.parse(block[1]);
  expect(handoff.verifier === form.bootstrap_verifier && handoff.gamePath === `/play/${GAME}`, "handoff data mismatch");
  expect(handoff.partnerOrigin === PARTNER_ORIGIN && handoff.bootstrapPath === "/v1/session/bootstrap", "handoff targets mismatch");
  return `bootstrap code ${handoff.code.slice(0, 8)}…, game path ${handoff.gamePath}, request ${handoff.requestId}`;
});

await step("5  replaying the launch token without its verifier is refused (TOKEN_REPLAYED)", async () => {
  const res = await http(FUNLANDS.launchUrl, {
    method: "POST",
    headers: { origin: PARTNER_ORIGIN, accept: "application/json" },
    form: { launch_token: form.launch_token, game: form.game, bootstrap_verifier: "x".repeat(43) },
  });
  expect(res.status === 401 && codeOf(res) === "TOKEN_REPLAYED", `got ${res.status} ${codeOf(res)}`);
  return `401 ${codeOf(res)}`;
});

await step("6  bootstrap on the game origin (code + verifier, exact Origin) opens a game session", async () => {
  const res = await http(`${GAME_ORIGIN}${handoff.bootstrapPath}`, {
    method: "POST",
    headers: { origin: GAME_ORIGIN, accept: "application/json" },
    body: { code: handoff.code, bootstrap_verifier: handoff.verifier },
  });
  expect(res.status === 200 && typeof res.json?.access_token === "string", `bootstrap ${res.status} ${res.text}`);
  expect(res.headers.get("cache-control")?.includes("no-store"), "bootstrap response must be no-store");
  tokens = res.json;
  gameHeaders = { authorization: `Bearer ${tokens.access_token}`, origin: GAME_ORIGIN };
  return `token_type ${tokens.token_type}, expires_in ${tokens.expires_in}s, refresh token issued`;
});

await step("7  the bootstrap code is single use (BOOTSTRAP_INVALID on reuse)", async () => {
  const res = await http(`${GAME_ORIGIN}${handoff.bootstrapPath}`, {
    method: "POST",
    headers: { origin: GAME_ORIGIN },
    body: { code: handoff.code, bootstrap_verifier: handoff.verifier },
  });
  expect(res.status === 400 && codeOf(res) === "BOOTSTRAP_INVALID", `got ${res.status} ${codeOf(res)}`);
  return `400 ${codeOf(res)}`;
});

await step("8  game page is served at the handoff's game path on the game origin", async () => {
  const res = await http(`${GAME_ORIGIN}${handoff.gamePath}`);
  expect(res.status === 200 && res.text.includes("Star Runner") && res.text.includes(GAME), `game page ${res.status}`);
  const csp = res.headers.get("content-security-policy") ?? "";
  expect(csp.includes(`frame-ancestors ${PARTNER_ORIGIN}`), "game page must be frameable by the partner");
  return `200 text/html, ${res.text.length} bytes`;
});

await step("9  game session works with the bearer token only; a wrong partner key is refused", async () => {
  const profile = await http(`${GAME_ORIGIN}/v1/profile`, { headers: gameHeaders });
  expect(profile.status === 200, `profile ${profile.status} ${profile.text.slice(0, 200)}`);
  const wrong = await http(`${GAME_ORIGIN}/v1/profile`, { headers: { ...gameHeaders, "x-partner-api-key": "fk_not_this_partner" } });
  expect(wrong.status === 401 || wrong.status === 403, `wrong key ${wrong.status} ${codeOf(wrong)}`);
  const p = profile.json.data;
  return `profile 200 with no partner key (user ${p.id ?? p._id ?? p.userId}, userName ${p.userName}); wrong x-partner-api-key → ${wrong.status} ${codeOf(wrong)}`;
});

await step(`10 game entry + final score ${score} + score history; platform leaderboard refused to partner players`, async () => {
  const entry = await http(`${GAME_ORIGIN}/v1/user/game/entry`, { method: "POST", headers: gameHeaders, body: { gameId: GAME } });
  expect(entry.status === 200, `entry ${entry.status} ${entry.text.slice(0, 300)}`);
  playSessionId = entry.json.data?.playSessionId ?? entry.json.data?.play_session_id;
  expect(playSessionId, `no playSessionId in ${entry.text.slice(0, 300)}`);
  const submitted = await http(`${GAME_ORIGIN}/v1/user/game/score`, {
    method: "POST",
    headers: gameHeaders,
    body: { gameId: GAME, score, playSessionId, endSession: true, clientKey: `final-${playSessionId}` },
  });
  expect(submitted.status === 200, `score ${submitted.status} ${submitted.text.slice(0, 300)}`);
  const history = await http(`${GAME_ORIGIN}/v1/user/game/${GAME}/score-history`, { headers: gameHeaders });
  expect(history.status === 200 && history.text.includes(String(score)), `history ${history.status} ${history.text.slice(0, 300)}`);
  const board = await http(`${GAME_ORIGIN}/v1/userLeaderboard/${GAME}`, { headers: gameHeaders });
  expect(board.status === 403, `leaderboard expected 403 for a partner player, got ${board.status}`);
  return `play session ${playSessionId}; score 200; history has ${score}; leaderboard 403 ${codeOf(board)} (platform board, by design)`;
});

const wanted = ["player.created", "session.started", "game.completed"];
const typesFor = (items) => new Set(items.filter((r) => r.verified).flatMap((r) => r.events).filter((e) => e.subject?.sub === player.sub).map((e) => e.short_type));
let hookEvents = [];

await step("11 webhooks: signed SETs delivered to the partner and verified against Funlands JWKS", async () => {
  const res = await poll(
    "webhooks player.created + session.started + game.completed",
    () => partner(`/api/webhooks?sub=${encodeURIComponent(player.sub)}`),
    (r) => wanted.every((type) => typesFor(r.json?.items ?? []).has(type)),
  );
  const rejected = res.json.items.filter((r) => !r.verified);
  expect(rejected.length === 0, `rejected webhooks: ${JSON.stringify(rejected).slice(0, 400)}`);
  hookEvents = res.json.items.flatMap((r) => r.events).filter((e) => e.subject.sub === player.sub);
  const sample = res.json.items[0];
  expect(sample.iss === FUNLANDS.setIssuer && sample.aud === PARTNER.issuer, `iss/aud ${sample.iss} ${sample.aud}`);
  return `${hookEvents.map((e) => `${e.short_type}#${e.player_seq}`).join(", ")}; iss ${sample.iss}, aud ${sample.aud}, kid ${sample.kid}`;
});

await step("12 events feed (OAuth events:read) has the same events in player_seq order", async () => {
  const res = await partner(`/api/events?sub=${encodeURIComponent(player.sub)}`);
  expect(res.status === 200, `feed ${res.status} ${res.text.slice(0, 300)}`);
  const items = res.json.items;
  const types = items.map((item) => item.type.split("/").pop());
  expect(wanted.every((type) => types.includes(type)), `feed types ${types}`);
  const seqs = items.map((item) => item.player_seq);
  expect(seqs.every((seq, i) => i === 0 || seq > seqs[i - 1]), `player_seq not increasing: ${seqs}`);
  const feedIds = new Set(items.map((item) => item.event_id));
  expect(hookEvents.every((event) => feedIds.has(event.event_id)), "a webhook event_id is missing from the feed");
  return items.map((item) => `${item.type.split("/").pop()}#${item.player_seq}`).join(", ");
});

await step("13 reports API (OAuth private_key_jwt): token, summary, games, the player and its activity", async () => {
  const res = await partner(`/api/reports?sub=${encodeURIComponent(player.sub)}`);
  expect(res.status === 200, `reports ${res.status}`);
  const r = res.json;
  for (const key of ["oauth_token", "summary", "daily", "games", "player", "activity"])
    expect(r[key]?.ok, `${key} failed: ${JSON.stringify(r[key]).slice(0, 300)}`);
  expect(r.oauth_token.body.scope.split(" ").sort().join(" ") === "events:read players:read reports:read", `scope ${r.oauth_token.body.scope}`);
  const playerBody = JSON.stringify(r.player.body);
  expect(playerBody.includes(player.sub), "player report does not name the sub");
  return `scope "${r.oauth_token.body.scope}" (${r.oauth_token.body.expires_in}s); player ${playerBody.slice(0, 160)}; summary ${JSON.stringify(r.summary.body).slice(0, 160)}`;
});

await step("14 partner logs the player out (back-channel logout token for sid)", async () => {
  const res = await partner("/api/logout", { method: "POST" });
  expect(res.status === 200 && res.json.funlands_status === 200, `logout ${res.status} ${res.text}`);
  expect(res.json.logged_out.sid === player.sid, "wrong sid logged out");
  return `Funlands answered ${res.json.funlands_status} ${JSON.stringify(res.json.funlands_body)} for sid ${res.json.logged_out.sid}`;
});

await step("15 the game session is dead: API call and refresh refused", async () => {
  const profile = await http(`${GAME_ORIGIN}/v1/profile`, { headers: gameHeaders });
  expect(profile.status === 401, `profile after logout ${profile.status}`);
  const entry = await http(`${GAME_ORIGIN}/v1/user/game/entry`, { method: "POST", headers: gameHeaders, body: { gameId: GAME } });
  expect(entry.status === 401, `entry after logout ${entry.status}`);
  const refresh = await http(`${GAME_ORIGIN}/v1/auth/session/refresh`, {
    method: "POST",
    body: { refreshToken: tokens.refresh_token },
  });
  expect(refresh.status === 401, `refresh after logout ${refresh.status}`);
  return `profile 401 ${codeOf(profile)}, game entry 401 ${codeOf(entry)}, refresh 401 ${codeOf(refresh)}`;
});

await step("16 session.ended webhook delivered and verified", async () => {
  await poll(
    "session.ended webhook",
    () => partner(`/api/webhooks?sub=${encodeURIComponent(player.sub)}`),
    (r) => typesFor(r.json?.items ?? []).has("session.ended"),
  );
  return "session.ended received";
});

summary();
