// Server-to-server calls a partner makes to Funlands: OAuth (private_key_jwt), reports, events feed, back-channel
// logout, and verification of the signed webhook SETs Funlands sends.
import { createRemoteJWKSet, decodeProtectedHeader, errors, jwtVerify } from "jose";
import { FUNLANDS, PARTNER } from "./config.mjs";
import { createClientAssertion, createLogoutToken } from "./partner-crypto.mjs";

export class FunlandsApiError extends Error {
  constructor(status, code, correlationId, body) {
    super(`Funlands ${status} ${code} correlation_id=${correlationId ?? "-"}`);
    this.status = status;
    this.code = code;
    this.correlationId = correlationId;
    this.body = body;
  }
  static async from(res) {
    const body = await res.json().catch(() => ({}));
    return new FunlandsApiError(res.status, body.code ?? body.error ?? "UNKNOWN", res.headers.get("x-correlation-id") ?? undefined, body);
  }
}

export const API_SCOPE = PARTNER.scopes.join(" ");

export class FunlandsApiClient {
  #token;
  constructor(clientId, scope = API_SCOPE) {
    this.clientId = clientId;
    this.scope = scope;
  }

  /** Access token from /oauth/token, kept in memory and renewed a minute before expiry. */
  async accessToken() {
    if (this.#token && this.#token.expiresAt > Date.now() + 60_000) return this.#token;
    const res = await fetch(FUNLANDS.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        scope: this.scope,
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: await createClientAssertion(this.clientId),
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw await FunlandsApiError.from(res);
    const body = await res.json();
    this.#token = { value: body.access_token, scope: body.scope, expiresIn: body.expires_in, expiresAt: Date.now() + body.expires_in * 1000 };
    return this.#token;
  }

  async get(path, query = {}, retried = false) {
    const url = new URL(path, FUNLANDS.tokenEndpoint);
    for (const [name, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(name, String(value));
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${(await this.accessToken()).value}`, accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 && !retried) {
      this.#token = undefined;
      return this.get(path, query, true);
    }
    if (!res.ok) throw await FunlandsApiError.from(res);
    return res.json();
  }

  /** The whole recovery feed, following next_cursor. */
  async eventFeed(limit = 50) {
    const items = [];
    let cursor;
    for (let page = 0; page < 100; page++) {
      const body = await this.get("/partner/v1/events", { limit, cursor });
      items.push(...body.items);
      if (!body.has_more) return items;
      cursor = body.next_cursor;
    }
    throw new Error("event feed did not end");
  }
}

/** Sends the back-channel logout token; a repeat of the same jti also answers 200, so 5xx/429/network retry. */
export async function backchannelLogout(user) {
  const logoutToken = await createLogoutToken(user);
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(FUNLANDS.logoutUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ logout_token: logoutToken }),
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) return { status: res.status, body: await res.json().catch(() => ({})) };
      const error = await FunlandsApiError.from(res);
      if (res.status < 500 && res.status !== 429) throw error;
      lastError = error;
    } catch (error) {
      if (error instanceof FunlandsApiError && error.status < 500 && error.status !== 429) throw error;
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
  }
  throw lastError ?? new Error("logout not confirmed");
}

// SET verification against the Funlands JWKS from the partner sheet (cached, one refetch per 30 s for unknown kid).
const funlandsJwks = createRemoteJWKSet(new URL(FUNLANDS.jwksUrl), {
  timeoutDuration: 3_000,
  cooldownDuration: 30_000,
  cacheMaxAge: 600_000,
});
const FORBIDDEN_HEADERS = ["jku", "x5u", "jwk", "x5c"];

export class SetRejected extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Verifies one webhook body (a compact SET) and returns its events. Throws SetRejected with the status to answer. */
export async function verifySet(token) {
  let header;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    throw new SetRejected(401, "malformed JWS header");
  }
  if (FORBIDDEN_HEADERS.some((name) => name in header) || !header.kid) throw new SetRejected(401, "forbidden or missing header");
  let verified;
  try {
    verified = await jwtVerify(token, funlandsJwks, {
      algorithms: ["ES256"],
      typ: "secevent+jwt",
      issuer: FUNLANDS.setIssuer,
      audience: PARTNER.issuer,
      requiredClaims: ["iat", "jti", "events"],
      maxTokenAge: "5m",
      clockTolerance: 30,
    });
  } catch (error) {
    if (error instanceof errors.JWKSTimeout) throw new SetRejected(503, "Funlands JWKS timeout");
    if (error instanceof errors.JOSEError) throw new SetRejected(401, `${error.code}: ${error.message}`);
    throw error;
  }
  const events = verified.payload.events;
  if (!events || typeof events !== "object" || Object.keys(events).length === 0) throw new SetRejected(400, "no events");
  return {
    header: verified.protectedHeader,
    claims: verified.payload,
    events: Object.entries(events).map(([type, body]) => {
      if (typeof body?.event_id !== "string" || typeof body.player_seq !== "number") throw new SetRejected(400, "malformed event");
      return { ...body, type, short_type: type.split("/").pop() };
    }),
  };
}

/** YYYY-MM-DD in Asia/Tehran, the local calendar the reports use. */
export function tehranDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
