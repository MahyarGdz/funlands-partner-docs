"use strict";
/**
 * DEMO ONLY. Preloaded into the Funlands backend process (`node --require <this file> dist/main.js`) by
 * scripts/backend.mjs. NEVER use it in staging or production.
 *
 * Funlands' SSRF-safe partner client (JWKS fetch and webhook delivery) only connects to https URLs whose host resolves
 * to public unicast addresses. The backend has no configuration switch that relaxes this, by design, so a partner on
 * this machine is unreachable. The backend's own partner sandbox harness (test/partner-sandbox/loopback-transport.ts)
 * solves the same problem by replacing only DNS and the socket; this shim does the same at the Node module level,
 * without touching backend code:
 *
 *   1. `dns.promises.lookup(<demo host>)` answers a public stand-in address, so the address policy is still evaluated
 *      (and passes) exactly as for a real partner host. Every other host resolves normally.
 *   2. `https.request` to a demo host connects its TCP socket to 127.0.0.1 instead of the stand-in. TLS SNI, the
 *      certificate check (against NODE_EXTRA_CA_CERTS = the demo CA), the Host header, https-only, no redirects, size
 *      and time limits all stay as the backend implements them.
 *
 * Demo hosts come from FUNLANDS_DEMO_LOOPBACK_HOSTS (comma separated) and must end in `.localhost`.
 */
const dnsPromises = require("node:dns/promises");
const https = require("node:https");

const PUBLIC_STAND_IN = { address: "93.184.216.34", family: 4 };
const hosts = new Set(
  (process.env.FUNLANDS_DEMO_LOOPBACK_HOSTS || "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host.length > 0),
);
for (const host of hosts) {
  if (!host.endsWith(".localhost")) throw new Error(`loopback shim: refusing non-.localhost host ${host}`);
}

if (hosts.size > 0) {
  const originalLookup = dnsPromises.lookup;
  dnsPromises.lookup = function demoLookup(hostname, options) {
    if (typeof hostname === "string" && hosts.has(hostname.toLowerCase())) {
      const all = typeof options === "object" && options !== null && options.all === true;
      return Promise.resolve(all ? [PUBLIC_STAND_IN] : PUBLIC_STAND_IN);
    }
    return originalLookup.apply(this, arguments);
  };

  const originalRequest = https.request;
  https.request = function demoRequest(options, ...rest) {
    if (options && typeof options === "object" && !(options instanceof URL)) {
      const hostname = String(options.hostname || options.host || "").toLowerCase();
      if (hosts.has(hostname)) {
        const loopbackLookup = (_name, lookupOptions, callback) => {
          if (lookupOptions && lookupOptions.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
          else callback(null, "127.0.0.1", 4);
        };
        options = { ...options, lookup: loopbackLookup, servername: options.servername || hostname };
      }
    }
    return originalRequest.call(this, options, ...rest);
  };
  process.emitWarning(`DEMO ONLY: partner hosts ${[...hosts].join(", ")} are routed to 127.0.0.1`, { code: "FUNLANDS_DEMO_LOOPBACK" });
}
