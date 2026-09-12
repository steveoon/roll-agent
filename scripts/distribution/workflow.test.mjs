/* eslint-disable no-template-curly-in-string -- These literals assert GitHub Actions expressions. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

// Reuse Core's existing YAML dependency; the source resolver itself needs only Node/Git.
const { parse } = createRequire(new URL("../../packages/core/package.json", import.meta.url))(
  "yaml",
);
const workflow = (name) =>
  parse(readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), "utf8"));

test("automatic distribution waits for the canonical release tag and missing-artifact gate", () => {
  const jobs = workflow("release").jobs;
  assert.ok(jobs.standalone_distribution.needs.includes("npm_publish"));
  assert.ok(jobs.standalone_distribution.needs.includes("github_releases"));
  assert.ok(jobs.standalone_distribution.needs.includes("standalone_distribution_gate"));
  assert.equal(
    jobs.standalone_distribution.if,
    "needs.standalone_distribution_gate.outputs.build == 'true'",
  );
  assert.equal(jobs.standalone_distribution_gate.needs, "npm_publish");
  assert.equal(jobs.standalone_distribution_gate.if, "needs.npm_publish.result == 'success'");
});

test("all native builds, assembly and deployment consume the same resolved commit", () => {
  const { jobs } = workflow("distribution");
  const checkout = jobs.resolve_source.steps.find((step) =>
    step.uses?.startsWith("actions/checkout@"),
  );
  assert.equal(
    checkout.with["fetch-depth"],
    0,
    "source resolution needs release tags and ancestry",
  );
  assert.equal(checkout.with["persist-credentials"], false);
  assert.equal(jobs.resolve_source.outputs.source_sha, "${{ steps.source.outputs.source_sha }}");
  for (const name of ["build", "assemble", "deploy"]) {
    const job = jobs[name];
    const dependencies = Array.isArray(job.needs) ? job.needs : [job.needs];
    assert.ok(dependencies.includes("resolve_source"), name);
    const checkouts = job.steps.filter((step) => step.uses?.startsWith("actions/checkout@"));
    assert.equal(checkouts.length, 1, name);
    assert.equal(checkouts[0].with.ref, "${{ needs.resolve_source.outputs.source_sha }}", name);
    assert.equal(checkouts[0].with["persist-credentials"], false, name);
  }
  assert.ok(jobs.assemble.needs.includes("build"));
  assert.ok(jobs.deploy.needs.includes("assemble"));
});

test("publication uses release source; previews and credentials retain their boundaries", () => {
  const distribution = workflow("distribution");
  const jobs = distribution.jobs;
  const source = jobs.resolve_source.steps.find((step) => step.id === "source");
  assert.equal(source.run, "node scripts/distribution/resolve-source.mjs");
  assert.equal(
    source.env.ROLL_DISTRIBUTION_PUBLISH,
    "${{ github.ref == 'refs/heads/main' && (github.event_name != 'workflow_dispatch' || inputs.publish == true) }}",
  );
  assert.equal(distribution.on.workflow_dispatch.inputs.publish.default, false);
  assert.equal(
    jobs.deploy.if,
    "github.ref == 'refs/heads/main' && vars.ROLL_DISTRIBUTION_ENABLED == 'true' && (github.event_name != 'workflow_dispatch' || inputs.publish == true)",
  );
  for (const name of ["resolve_source", "build", "assemble"]) {
    assert.deepEqual(jobs[name].permissions, { contents: "read" });
    assert.doesNotMatch(JSON.stringify(jobs[name]), /secrets\.|id-token/);
  }
});
