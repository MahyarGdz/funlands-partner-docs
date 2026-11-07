# Funlands partner integration

Documentation and a reference implementation for partners that show Funlands games inside their own apps.

**Read online:** https://mahyargdz.github.io/funlands-partner-docs/

| What | Where |
|---|---|
| Developer documentation (Persian, with samples in NestJS, Express, FastAPI, Django, Laravel, PHP, Go, Spring, .NET and cURL) | [`index.html`](index.html) · [PDF](funlands-partner-developer-docs.pdf) |
| Integration guide (Persian, the contract in plain terms) | [`guide/`](guide/index.html) · [PDF](guide/funlands-partner-integration-guide.pdf) |
| Reference partner and sample game | [`sample-partner/`](sample-partner/) |

## How the integration works

1. Your backend signs a short-lived launch token (ES256) for the signed-in player and publishes its public keys as JWKS.
2. Your page posts the launch token to the Funlands **game origin**. Funlands verifies it and opens a game session for that player.
3. The game calls the Funlands API with that session. For `client_direct` partners, every call also carries your `x-partner-api-key`.
4. Funlands sends signed webhooks (`player.created`, `session.started`, `game.completed`, `session.ended`, `player.deleted`) and serves an events feed for anything you missed.
5. Your server reads reports with an OAuth `private_key_jwt` client and can end a player's session at once with a back-channel logout token.

The exact hosts, keys, client ids and scopes for each environment come in the partner sheet the Funlands team sends you. Every domain and key in these documents is an example.

## The reference implementation

`sample-partner/` is the code the Funlands team uses to test the whole flow end to end: a partner web app, its launch signing, JWKS, webhook verification, OAuth reports and logout, plus a small game page that bootstraps a session and calls real game APIs.

- To learn the integration, read `sample-partner/partner/` (your side) and `sample-partner/game/` (the game side). `sample-partner/lib/partner-crypto.mjs` has the signing and verification code.
- Running it end to end (`npm run up`, `npm run e2e`) needs a local Funlands backend, which only the Funlands team has. Partners test against the Funlands sandbox with the values from their partner sheet.
- `sample-partner/demo-backend/` and the demo TLS setup exist only so a local backend can reach a local partner. Never use them in production.

## Contact

Send questions, sandbox access requests and anything that does not match these documents to the Funlands backend team. If the documents and the API disagree, the API is right; please tell us so we can fix the documents.
