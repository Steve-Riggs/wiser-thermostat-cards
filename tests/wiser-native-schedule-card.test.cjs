"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

function mountCard() {
  const registry = new Map();
  class FakeHTMLElement {
    constructor() {
      this.isConnected = true;
      this.shadowRoot = null;
    }
    attachShadow() {
      const root = { innerHTML: "", addEventListener() {} };
      this.shadowRoot = root;
      return root;
    }
  }
  const globals = {
    HTMLElement: FakeHTMLElement,
    customElements: {
      get(name) { return registry.get(name); },
      define(name, constructor) { registry.set(name, constructor); }
    },
    window: { customCards: [] },
    console
  };
  globals.globalThis = globals;
  const source = fs.readFileSync(path.resolve(__dirname, "../dist/wiser-native-schedule-card.js"), "utf8");
  vm.runInNewContext(source, globals, { filename: "wiser-native-schedule-card.js" });
  return { Card: registry.get("wiser-hive-schedule-card"), globals };
}

test("built card registers with Home Assistant and defaults safely to demo", async () => {
  const { Card, globals } = mountCard();
  assert.equal(typeof Card, "function");
  assert.equal(globals.window.customCards.length, 1);
  const card = new Card();
  card.setConfig({ title: "Heating <script>alert(1)</script>" });
  card.hass = {};
  await new Promise(setImmediate);
  assert.equal(card._loaded, true);
  assert.equal(card._schedule.Name, "Lobby");
  assert.match(card.shadowRoot.innerHTML, /Interactive preview/);
  assert.match(card.shadowRoot.innerHTML, /Heating &lt;script&gt;/);
  assert.doesNotMatch(card.shadowRoot.innerHTML, /<script>alert/);
  assert.match(card.shadowRoot.innerHTML, /DEMO/);
});
test("demo UI editing and save never invoke Home Assistant", async () => {
  const { Card } = mountCard();
  const card = new Card();
  card.setConfig({ demo: true });
  let calls = 0;
  card.hass = { callWS() { calls++; throw Error("Should not talk to hub in demo mode"); } };
  await new Promise(setImmediate);
  const send = (action, index) => card._handleClick({
    target: { closest() { return { dataset: { action, index } }; } }
  });
  await send("edit");
  assert.equal(card._editing, true);
  card._apply(() => globalFixtureChange(card._draft));
  await send("save");
  assert.equal(card._editing, false);
  assert.equal(card._schedule.ScheduleData[0].slots[0].Setpoint, "20");
  assert.equal(calls, 0);
  assert.match(card.shadowRoot.innerHTML, /Saved to demo memory only/);
});
function globalFixtureChange(schedule) {
  const output = JSON.parse(JSON.stringify(schedule));
  output.ScheduleData[0].slots[0].Setpoint = "20";
  return output;
}
test("real mode fails closed without installed Wiser integration", async () => {
  const { Card } = mountCard();
  const card = new Card();
  card.setConfig({ demo: false });
  card.hass = { config: { components: [] } };
  await new Promise(setImmediate);
  assert.equal(card._loaded, false);
  assert.match(card.shadowRoot.innerHTML, /Wiser Home Assistant integration is not loaded/);
});
