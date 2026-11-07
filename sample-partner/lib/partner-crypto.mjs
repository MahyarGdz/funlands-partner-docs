// Partner-side token work, exactly as the Funlands contract requires (ES256, one key per kid, JWKS published).
import { createHash, createPrivateKey, createPublicKey, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SignJWT } from "jose";
import { FUNLANDS, PARTNER, paths } from "./config.mjs";

let cached;
function signingKey() {
  if (cached) return cached;
  const key = createPrivateKey(readFileSync(join(paths.partnerKeys, `${PARTNER.kid}.pem`), "utf8"));
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1")
    throw new Error("partner signing key must be EC P-256");
  cached = { kid: PARTNER.kid, key };
  return cached;
}

/** Public JWKS: only kty/crv/x/y plus kid/alg/use, never d. */
export function partnerJwks() {
  const { kid, key } = signingKey();
  const { kty, crv, x, y } = createPublicKey(key).export({ format: "jwk" });
  return { keys: [{ kty, crv, x, y, kid, alg: "ES256", use: "sig" }] };
}

/** RFC 7636 verifier (43 chars) and its S256 challenge. */
export function newVerifier() {
  return randomBytes(32).toString("base64url");
}
export function challengeFor(verifier) {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * Launch token: typ funlands-launch+jwt, aud = launch audience, sub = pairwise player id, sid = partner session,
 * game = the form's game, launch_challenge = S256(verifier), exp - iat <= 120 s, fresh jti.
 */
export async function createLaunchForm(user, game) {
  const { kid, key } = signingKey();
  const bootstrapVerifier = newVerifier();
  const now = nowSeconds();
  const launchToken = await new SignJWT({
    sid: user.sid,
    game,
    launch_challenge: challengeFor(bootstrapVerifier),
    locale: "fa-IR",
    ...(user.ageBand && { age_band: user.ageBand }),
    ...(user.nickname && { nickname: user.nickname }),
  })
    .setProtectedHeader({ alg: "ES256", typ: "funlands-launch+jwt", kid })
    .setIssuer(PARTNER.issuer)
    .setAudience(FUNLANDS.launchAudience)
    .setSubject(user.sub)
    .setIssuedAt(now)
    .setExpirationTime(now + 120)
    .setJti(randomUUID())
    .sign(key);
  return { launch_token: launchToken, game, bootstrap_verifier: bootstrapVerifier };
}

/** Back-channel logout token: typ logout+jwt, aud = logout audience, sid (+ sub), the OIDC logout event, no nonce. */
export async function createLogoutToken(user) {
  const { kid, key } = signingKey();
  const now = nowSeconds();
  return new SignJWT({ sid: user.sid, events: { "http://schemas.openid.net/event/backchannel-logout": {} } })
    .setProtectedHeader({ alg: "ES256", typ: "logout+jwt", kid })
    .setIssuer(PARTNER.issuer)
    .setAudience(FUNLANDS.logoutAudience)
    .setSubject(user.sub)
    .setIssuedAt(now)
    .setExpirationTime(now + 120)
    .setJti(randomUUID())
    .sign(key);
}

/** private_key_jwt client assertion for /oauth/token: iss = sub = client_id, aud = token endpoint, 60 s. */
export async function createClientAssertion(clientId) {
  const { kid, key } = signingKey();
  const now = nowSeconds();
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", typ: "JWT", kid })
    .setIssuer(clientId)
    .setSubject(clientId)
    .setAudience(FUNLANDS.tokenEndpoint)
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
    .setJti(randomUUID())
    .sign(key);
}
