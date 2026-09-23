import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { browserTestFixture } from "./browser-test-fixture.e2e.ts";
import { INSPECT_GOAL_CONTROL, GoalControlSchema } from "./observation.ts";

const html = `<!doctype html><meta charset="utf-8"><style>li,p{margin:4px}input{padding:8px}</style><div><span><input id="company" type="text" placeholder="Company"><input id="token" type="hidden"></span><div><ul id="results" hidden><li id="row"><p id="title">Acme</p><p>Acme Services Limited</p></li></ul></div></div><input id="other"><div><input id="ambiguous"><input id="peer"><input type="hidden"></div><script>const input=document.getElementById('company'),token=document.getElementById('token'),results=document.getElementById('results');input.oninput=()=>{token.value='';results.hidden=false};input.onblur=()=>{if(!token.value)input.value=''};document.getElementById('row').onclick=()=>{token.value='company-42';input.value='Acme';results.hidden=true};</script>`;

test(
  "unmarked autocomplete distinguishes typed query, blur reset and applied selection",
  { skip: process.env["RUN_AUTOCOMPLETE_E2E"] !== "1", timeout: 30000 },
  async () => {
    const fixture = await browserTestFixture(() => html);
    const c = fixture.controller;
    try {
      await c.navigate(fixture.origin);
      for (let i = 0; i < 80; i++) {
        if (await c.evaluateJson('Boolean(document.getElementById("company"))')) break;
        await delay(25);
      }
      const inspect = async (id: string) =>
        GoalControlSchema.parse(
          await c.evaluateJson(
            `(${INSPECT_GOAL_CONTROL}).call(document.getElementById(${JSON.stringify(id)}),${JSON.stringify([fixture.origin])})`,
          ),
        );
      assert.equal((await inspect("company")).picker?.selection, "empty");
      await c.evaluateJson(
        "(()=>{const field=document.getElementById('company');field.focus();field.value='Acme';field.dispatchEvent(new Event('input',{bubbles:true}))})()",
      );
      const query = await inspect("company");
      assert.equal(query.picker?.queryText, "Acme");
      assert.notEqual(query.picker?.selection, "value");
      const row = await inspect("row");
      const child = await inspect("title");
      assert.equal(row.picker?.relationship, "local-dom");
      assert.equal(row.picker?.triggerPath, query.picker?.triggerPath);
      assert.equal(row.picker?.optionPath, child.picker?.optionPath);
      assert.equal(row.picker?.optionLabel, "Acme");
      assert.match(row.picker?.optionText ?? "", /Services Limited/);
      await c.evaluateJson("document.getElementById('company').dispatchEvent(new Event('blur'))");
      assert.equal((await inspect("company")).picker?.queryText, "");
      await c.evaluateJson("document.getElementById('row').click()");
      const selected = await inspect("company");
      assert.equal(selected.picker?.selection, "value");
      assert.equal(selected.picker?.committedText, "Acme");
      assert.equal(selected.picker?.queryText, undefined);
      assert.equal(selected.picker?.panelVisible, false);
      assert.equal((await inspect("ambiguous")).picker, undefined);
    } finally {
      await fixture.close();
    }
  },
);
