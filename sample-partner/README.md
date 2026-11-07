# Funlands sample partner (local demo)

A runnable partner integration against a **locally running Funlands backend**: a partner web app whose signed-in
player clicks Play, the Funlands launch handoff, a sample game that bootstraps a session and calls real game APIs,
signed webhooks, the events feed, OAuth reports, and back-channel logout. Plain Node ESM, two dependencies (`jose`,
`bcryptjs`). It never imports backend code; it talks to the backend over HTTP only.

```
 Browser (signed-in player "Sara")
   │  https://partner.localhost:4443/          ┌──────────────── sample partner (partner/server.mjs, TLS, demo CA) ─┐
   ├─ GET /  (app page) ─────────────────────► │ app page · POST /api/launch (signs ES256 launch token + verifier)  │
   │                                           │ GET /.well-known/jwks.json  · POST /funlands/events (verifies SETs)│
   │                                           │ /api/reports, /api/events (OAuth private_key_jwt client)           │
   │                                           │ POST /api/logout (back-channel logout token)                       │
   │                                           └────────┬───────────────────────────▲───────────────────────────────┘
   │  iframe: form POST launch_token+game+verifier      │ oauth/reports/events/logout│ JWKS fetch + webhook SETs
   ▼  (Origin = partner origin)                         ▼                           │ (https, via demo loopback shim)
 http://localhost:4200  = PARTNER_GAME_ORIGIN    ┌───────────────── Funlands backend (main checkout dist/main.js) ─┐
 ┌─ sample game origin (game/server.mjs) ──┐     │ 127.0.0.1:3910, PROCESS_ROLE=all (API + outbox/webhook workers) │
 │ /v1/*  → reverse proxy ─────────────────┼───► │ /v1/partner/launch → handoff page → /v1/session/bootstrap        │
 │ /play/{game} sample game (game.js)      │     │ /v1/user/game/entry|score, /v1/profile, /oauth/token, /partner/v1│
 └─────────────────────────────────────────┘     └── PostgreSQL 17 :56450 (funlands_partner_demo) · Redis :56390 ──┘
```

## Prerequisites

- Node 20.11+ (tested on 26), `npm install` in this folder.
- The backend checkout at `../funlands_backend` (or `FUNLANDS_BACKEND_DIR`), with `pnpm install` and `pnpm build` done.
- PostgreSQL 17 binaries at `/opt/homebrew/opt/postgresql@17/bin` (`DEMO_PG_BIN`), `redis-server`, `openssl`, `curl`.
- Free ports 3910 (backend), 4443 (partner), 4200 (game), 56450 (PostgreSQL), 56390 (Redis). All overridable with
  `DEMO_*_PORT`, see `lib/config.mjs`.

## Run

```sh
npm install
npm run up        # infra + setup + backend + partner registration + partner + game, all detached
npm run e2e       # headless end-to-end check, PASS/FAIL per step
npm run e2e:browser   # optional: the same flow in a throwaway headless Chrome (screenshots in .demo/browser/)
npm run status
npm run down      # stop game, partner, backend;  npm run down -- --all  also stops PostgreSQL and Redis
```

`npm run up` is idempotent. `node scripts/setup.mjs --reset` recreates the demo database and forgets the registration
(stop the backend first). Logs: `.demo/logs/{backend,partner,game}.log`; pids: `.demo/pids/`; generated ids, admin
login and secrets: `.demo/state.json`; received webhooks: `.demo/webhooks.jsonl`.

### Browser demo

Open **https://partner.localhost:4443/** (Chrome/Firefox resolve `*.localhost` to loopback). The certificate is
issued by a demo CA generated in `.demo/tls/demo-ca.pem`: either click through the warning once ("Advanced →
Proceed"), or trust that CA yourself. Then:

1. **Play**: the partner backend signs a launch token, the page form-posts it into the frame. Funlands answers with
   its handoff page, which bootstraps on the game origin and opens `/play/{game}`; the game shows "session live".
2. **Start round**, click the star for 10 s; the final score is submitted. **My scores** shows the history;
   **Leaderboard** answers 403 (the shared board is platform-only; partner players are refused by design).
3. Webhooks appear on the right within ~1 s (each verified against Funlands' JWKS).
4. **Reports for this player** / **Events feed** call the partner API with an OAuth token (`private_key_jwt`).
5. **Log player out**: the partner sends a back-channel logout token; within 3 s the game frame turns red
   ("session ended") and a `session.ended` webhook arrives. Reloading the game frame without a session makes the game
   ask the partner page for a fresh launch (`funlands:relaunch_requested` → `partner:relaunch_ready`).

## What the e2e steps prove

| Step | Proves |
|---|---|
| 0 | Backend ready; Funlands and partner JWKS published (no private members); game origin up |
| 1–2 | Partner session (pairwise `sub`, `sid`); launch token: ES256, `typ funlands-launch+jwt`, launch audience, ≤120 s, S256 challenge |
| 3 | Launch from an unregistered Origin → 403 `ORIGIN_NOT_ALLOWED` |
| 4 | Launch form POST (HTML) → handoff page framed only by the partner origin, carrying code + verifier + game path |
| 5 | Replay without the verifier → 401 `TOKEN_REPLAYED` |
| 6–7 | Bootstrap on the exact game Origin → session tokens (`no-store`); the code is single use (`BOOTSTRAP_INVALID`) |
| 8 | Game page served at the handoff's game path, frameable by the partner |
| 9 | The session works on the API with the bearer token alone (the token carries the partner scope); a wrong partner key is refused |
| 10 | Game entry, final score, score history; platform leaderboard refused (403) |
| 11 | Webhooks `player.created`, `session.started`, `game.completed` delivered and verified (iss = Funlands base, aud = partner issuer) |
| 12 | Events feed (OAuth `events:read`) has the same `event_id`s in `player_seq` order |
| 13 | OAuth `private_key_jwt` token; summary, daily, games, player and activity reports name this player |
| 14 | Back-channel logout of the `sid` → 200 |
| 15 | Afterwards the access token (profile, game entry) and the refresh token are refused (401) |
| 16 | `session.ended` webhook delivered and verified |

## Setup details

`scripts/setup.mjs`: generates the partner ES256 key (`.demo/partner-keys/`), the Funlands signing key directory
(`PARTNER_SIGNING_KEY_DIR=.demo/funlands-keys`, kid `funlands-demo-1`), the demo TLS CA + `partner.localhost`
certificate; writes `.backend.env`; runs the backend migrations (`pnpm run migration:run`: TypeORM ledger then
MikroORM) on `funlands_partner_demo`; inserts a platform admin (`identity.users.is_admin = true`, bcrypt password;
there is no admin sign-up API, the admin API checks the flag in the database) and one confirmed, active game.
`scripts/register.mjs` logs in as that admin (`POST /v1/login`) and registers the partner: `POST /v1/admin/partners`
(`client_direct`), `POST …/api-key`, `POST …/environments` (sandbox trust: issuer, JWKS URI, the three audiences,
ES256, allowed web origin, webhook URL; scopes `reports:read players:read events:read`) and activates it.

## Demo-only configuration (never use in production)

- **`demo-backend/loopback-partner-shim.cjs`**, preloaded into the backend with `node --require`. Funlands' SSRF-safe
  client only reaches https hosts that resolve to public addresses, and the backend has **no configuration switch**
  to relax that (by design; its own sandbox suite replaces DNS and the socket in-process). The shim does the same at
  the Node module level for hosts in `FUNLANDS_DEMO_LOOPBACK_HOSTS` (must end in `.localhost`): DNS answers a public
  stand-in so the address policy still runs, and the TCP socket goes to 127.0.0.1. https, TLS verification (against
  `NODE_EXTRA_CA_CERTS` = the demo CA), no redirects, size and time limits stay as implemented.
- `.backend.env`: generated secrets, `PARTNER_GAME_ORIGIN=http://localhost:4200` (plain http is accepted only for
  loopback), every HTTP/partner rate limit raised to 10000 (all traffic comes from one IP), `OUTBOX_POLL_INTERVAL_MS=500`.
- The demo CA and certificate, the admin password in `.demo/state.json`, trust auth on the demo PostgreSQL.
- The partner page uses `Referrer-Policy: origin-when-cross-origin` because it posts from https to the plain-http
  loopback game origin; with `strict-origin-when-cross-origin` browsers send `Origin: null` on that downgrade. In
  production (https → https) use `strict-origin-when-cross-origin` as the guide says.
- The backend always listens on `0.0.0.0` (hard-coded); the demo secrets are throwaway, but stop it when done.
