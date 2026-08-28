import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COMPANION_RELAY_HOST_OVERRIDE_ENV,
  OFFICIAL_RELAY_ENDPOINT_UNDECIDED_MESSAGE,
  OFFICIAL_RELAY_PROFILE,
  isOfficialRelayEndpointDecided,
  requireCompanionRelayEndpoint,
  requireOfficialRelayCompanionUrl,
  requireOfficialRelayEnrollmentUrl,
  resolveCompanionRelayEndpoint,
} from "./constants.ts";

function withOverride(host: string): NodeJS.ProcessEnv {
  return { [COMPANION_RELAY_HOST_OVERRIDE_ENV]: host };
}

test("the Relay endpoint fails closed while no host is configured", () => {
  if (OFFICIAL_RELAY_PROFILE.host !== null) {
    // Once the official host ships, the compiled-in value must stay a secure remote endpoint.
    const endpoint = requireCompanionRelayEndpoint({});
    assert.equal(endpoint.overridden, false);
    assert.equal(endpoint.loopback, false);
    assert.equal(endpoint.companionUrl.startsWith("wss://"), true);
    return;
  }

  assert.equal(resolveCompanionRelayEndpoint({}), null);
  assert.equal(isOfficialRelayEndpointDecided({}), false);
  assert.throws(
    () => requireOfficialRelayEnrollmentUrl({}),
    new RegExp(OFFICIAL_RELAY_ENDPOINT_UNDECIDED_MESSAGE),
  );
  assert.throws(() => requireOfficialRelayCompanionUrl({}), /not decided yet/u);
});

test("a loopback override is the only endpoint allowed to use plaintext transport", () => {
  for (const host of ["127.0.0.1:8787", "localhost:8787", "[::1]:8787", "127.7.7.7"]) {
    const endpoint = requireCompanionRelayEndpoint(withOverride(host));

    assert.equal(endpoint.overridden, true);
    assert.equal(endpoint.loopback, true);
    assert.equal(endpoint.host, host);
    assert.equal(endpoint.enrollmentUrl, `http://${host}/v1/device-enrollments/redeem`);
    assert.equal(endpoint.companionUrl, `ws://${host}/v1/companion`);
  }
});

test("a remote override keeps TLS", () => {
  const endpoint = requireCompanionRelayEndpoint(withOverride("Relay.Example.Com:8443"));

  assert.equal(endpoint.loopback, false);
  assert.equal(endpoint.host, "relay.example.com:8443");
  assert.equal(
    endpoint.enrollmentUrl,
    "https://relay.example.com:8443/v1/device-enrollments/redeem",
  );
  assert.equal(endpoint.companionUrl, "wss://relay.example.com:8443/v1/companion");
});

test("the frozen Relay paths are never rewritten by an override", () => {
  const endpoint = requireCompanionRelayEndpoint(withOverride("127.0.0.1:8787"));

  assert.equal(new URL(endpoint.enrollmentUrl).pathname, "/v1/device-enrollments/redeem");
  assert.equal(new URL(endpoint.companionUrl).pathname, "/v1/companion");
});

test("a malformed override is rejected instead of silently reinterpreted", () => {
  for (const host of [
    "https://relay.example.test",
    "ws://127.0.0.1:8787",
    "127.0.0.1:8787/v1/companion",
    "127.0.0.1:8787?ticket=1",
    "user:secret@relay.example.test",
    "relay.example.test/",
    "not a host",
  ]) {
    assert.throws(
      () => requireCompanionRelayEndpoint(withOverride(host)),
      new RegExp(COMPANION_RELAY_HOST_OVERRIDE_ENV),
      `expected ${host} to be rejected`,
    );
  }
});

test("a blank override falls back to the compiled-in endpoint", () => {
  assert.equal(
    resolveCompanionRelayEndpoint(withOverride("   ")),
    resolveCompanionRelayEndpoint({}),
  );
});
