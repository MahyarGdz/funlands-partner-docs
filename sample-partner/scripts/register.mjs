// Registers the sample partner through the Funlands platform admin API (the backend must be running):
//   admin login → POST /v1/admin/partners (client_direct) → POST …/api-key → POST …/environments (sandbox trust,
//   scopes, webhook) → PUT …/environments/sandbox/status active. Idempotent: skips when already registered.
import { FUNLANDS, FUNLANDS_API, PARTNER, readState, requireState, writeState } from "../lib/config.mjs";

async function call(method, path, token, body) {
  const res = await fetch(`${FUNLANDS_API}${path}`, {
    method,
    headers: { "content-type": "application/json", accept: "application/json", ...(token && { authorization: `Bearer ${token}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
  return json.data ?? json;
}

export async function adminToken() {
  const { admin } = requireState("admin");
  const session = await call("POST", "/v1/login", null, { userName: admin.userName, password: admin.password });
  const token = session.accessToken ?? session.access_token ?? session.token;
  if (typeof token !== "string") throw new Error(`unexpected login response: ${JSON.stringify(Object.keys(session))}`);
  return token;
}

export async function register() {
  const state = readState();
  const token = await adminToken();
  if (state.partner?.environmentId) {
    const env = await call("GET", `/v1/admin/partners/${state.partner.partnerId}/environments/sandbox`, token).catch(() => null);
    if (env?.status === "active") {
      console.log(`partner ${state.partner.partnerKey} already registered (environment ${env.id}, active)`);
      return state.partner;
    }
  }
  const partnerKey = `sample-partner-${Date.now().toString(36)}`;
  const created = await call("POST", "/v1/admin/partners", token, { partnerKey, name: "Sample Partner (demo)", integrationMode: "client_direct" });
  const partnerId = created.id;
  const key = await call("POST", `/v1/admin/partners/${partnerId}/api-key`, token, {});
  const environment = await call("POST", `/v1/admin/partners/${partnerId}/environments`, token, {
    environment: "sandbox",
    apiScopes: PARTNER.scopes,
    trust: {
      issuer: PARTNER.issuer,
      jwksUri: PARTNER.jwksUri,
      launchAudience: FUNLANDS.launchAudience,
      logoutAudience: FUNLANDS.logoutAudience,
      tokenAudience: FUNLANDS.tokenEndpoint,
      signingAlgorithm: "ES256",
      allowedWebOrigins: [PARTNER.webOrigin],
      webhookUri: PARTNER.webhookUri,
    },
  });
  const activated = await call("PUT", `/v1/admin/partners/${partnerId}/environments/sandbox/status`, token, {
    status: "active",
    expectedRevision: environment.revision,
  });
  const partner = {
    partnerKey,
    partnerId,
    apiKey: key.apiKey,
    environmentId: environment.id,
    clientId: environment.clientId,
    status: activated.status,
  };
  writeState({ partner });
  console.log(`partner ${partnerKey} registered: environment ${environment.id} (${activated.status}), client_id ${environment.clientId}`);
  return partner;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  register().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
