import assert from "node:assert/strict";
import test from "node:test";
import {
  OFFICIAL_RELAY_PROFILE,
  RELAY_HOST_OVERRIDE_ENV,
  isOfficialRelayEndpointDecided,
  normalizeRelayHost,
  resolveRelayEndpoint,
} from "./constants.ts";

test("official relay endpoint is decided and secure", () => {
  assert.equal(isOfficialRelayEndpointDecided(), true);
  assert.equal(OFFICIAL_RELAY_PROFILE.id, "roll-cloud-v1");
  const endpoint = resolveRelayEndpoint({});
  assert.equal(endpoint.source, "official");
  assert.equal(endpoint.host, "sponge-mcp.duliday.com");
  assert.equal(endpoint.secure, true);
  assert.equal(
    endpoint.enrollmentUrl,
    "https://sponge-mcp.duliday.com/v1/device-enrollments/redeem",
  );
  assert.equal(endpoint.companionUrl, "wss://sponge-mcp.duliday.com/v1/companion");
});

test("loopback override downgrades to plain schemes", () => {
  for (const host of ["127.0.0.1:8787", "localhost:3000", "[::1]:8080", "127.9.9.9"]) {
    const endpoint = resolveRelayEndpoint({ [RELAY_HOST_OVERRIDE_ENV]: host });
    assert.equal(endpoint.source, "override");
    assert.equal(endpoint.secure, false);
    assert.equal(endpoint.enrollmentUrl, `http://${host}/v1/device-enrollments/redeem`);
    assert.equal(endpoint.companionUrl, `ws://${host}/v1/companion`);
  }
});

test("non-loopback override keeps secure schemes", () => {
  const endpoint = resolveRelayEndpoint({ [RELAY_HOST_OVERRIDE_ENV]: "staging.example.com:8443" });
  assert.equal(endpoint.source, "override");
  assert.equal(endpoint.secure, true);
  assert.equal(endpoint.companionUrl, "wss://staging.example.com:8443/v1/companion");
});

test("hostnames that merely start with 127. are not loopback", () => {
  for (const host of ["127.evil.com", "127.0.0.1.evil.com", "127.300.1.1", "localhost.evil.com"]) {
    const endpoint = resolveRelayEndpoint({ [RELAY_HOST_OVERRIDE_ENV]: host });
    assert.equal(endpoint.secure, true, host);
    assert.equal(endpoint.companionUrl, `wss://${host}/v1/companion`);
  }
  assert.equal(
    resolveRelayEndpoint({ [RELAY_HOST_OVERRIDE_ENV]: "127.0.0.1:65535" }).secure,
    false,
  );
});

test("out-of-range ports fail closed", () => {
  for (const value of ["localhost:0", "localhost:99999", "staging.example.com:65536"]) {
    assert.throws(
      () => resolveRelayEndpoint({ [RELAY_HOST_OVERRIDE_ENV]: value }),
      /ROLL_COMPANION_RELAY_HOST/u,
    );
  }
});

test("invalid overrides fail closed and blank overrides are ignored", () => {
  for (const value of [
    "https://evil.example",
    "evil.example/path",
    "evil example",
    "user@evil.example",
    "evil.example:notaport",
  ]) {
    assert.throws(
      () => resolveRelayEndpoint({ [RELAY_HOST_OVERRIDE_ENV]: value }),
      /ROLL_COMPANION_RELAY_HOST/u,
    );
  }
  assert.equal(resolveRelayEndpoint({ [RELAY_HOST_OVERRIDE_ENV]: "  " }).source, "official");
  assert.equal(normalizeRelayHost(" LOCALHOST:3000 "), "localhost:3000");
});
