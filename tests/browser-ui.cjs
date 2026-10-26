"use strict";
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 850 } });
    await page.setContent("<!doctype html><html><body style='margin:0'></body></html>");
    await page.addScriptTag({ path: path.resolve(__dirname, "../dist/wiser-native-schedule-card.js") });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.evaluate(() => {
      const card = document.createElement("wiser-hive-schedule-card");
      card.setConfig({ title: "Heating schedules", demo: true });
      document.body.appendChild(card);
      card.hass = {};
      window.__card = card;
    });
    const card = page.locator("wiser-hive-schedule-card");
    await card.locator("select[data-action='choose']").waitFor();
    assert.match(await card.locator(".shell").innerText(), /00:00–06:30: 16°C carried over from Sunday/);
    assert.match(await card.locator(".shell").innerText(), /Until Tuesday 06:30/);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, "Mobile schedule does not produce page-width overflow");

    await card.locator("button[data-action='edit']").click();
    const firstTemperature = card.locator("input[data-action='temperature'][data-index='0']");
    await page.evaluate(() => {
      window.__originalField = window.__card.shadowRoot.querySelector("input[data-action='temperature'][data-index='0']");
    });
    await firstTemperature.fill("20.5");
    await firstTemperature.press("Tab");
    assert.equal(await page.evaluate(() => window.__originalField.isConnected), true,
      "Typing a temperature and committing it must not replace the active input");
    assert.equal(await firstTemperature.inputValue(), "20.5");

    const firstTime = card.locator("input[data-action='time'][data-index='0']");
    await firstTime.fill("06:15");
    await firstTime.press("Tab");
    assert.equal(await firstTime.inputValue(), "06:15");

    await card.locator("button[data-action='save']").click();
    assert.match(await card.locator(".shell").innerText(), /Saved to demo memory only/);
    assert.match(await card.locator(".shell").innerText(), /06:15/);
    assert.match(await card.locator(".shell").innerText(), /20.5°C/);

    // When the WebSocket is unavailable, repeated hass updates must not retry automatically.
    await page.evaluate(() => {
      let calls = 0;
      window.__counts = { get: () => calls };
      const broken = document.createElement("wiser-hive-schedule-card");
      broken.setConfig({ demo: false, hub: "My hub" });
      document.body.appendChild(broken);
      const hass = { config: { components: ["wiser"] }, callWS: async () => { calls++; throw Error("Hub unreachable"); } };
      broken.hass = hass;
      window.__broken = broken;
      window.__brokenHass = hass;
    });
    const broken = page.locator("wiser-hive-schedule-card").nth(1);
    await broken.locator("button[data-action='reload']").waitFor();
    const initial = await page.evaluate(() => window.__counts.get());
    for (let i = 0; i < 5; i++) await page.evaluate(() => { window.__broken.hass = window.__brokenHass; });
    assert.equal(await page.evaluate(() => window.__counts.get()), initial, "hass updates don't auto-retry");
    await broken.locator("button[data-action='reload']").click();
    await broken.locator("button[data-action='reload']").waitFor();
    assert.equal(await page.evaluate(() => window.__counts.get()), initial + 1, "manual Retry performs one new request");

    // Real-mode save is explicitly disabled without allow_live_writes.
    await page.evaluate(() => {
      const demo = new WiserScheduleCore.DemoTransport();
      const card = document.createElement("wiser-hive-schedule-card");
      card.setConfig({ demo: false, hub: "My hub" });
      document.body.appendChild(card);
      window.__liveTest = { saves: 0 };
      card.hass = {
        config: { components: ["wiser"] },
        callWS: async (message) => {
          if (message.type === "wiser/hubs") return ["My hub"];
          if (message.type === "wiser/schedules") return demo.list();
          if (message.type === "wiser/schedule/id") return demo.read(message.schedule_id);
          if (message.type === "wiser/schedule/save") { window.__liveTest.saves++; return "success"; }
          throw Error("Unexpected message " + message.type);
        }
      };
    });
    const live = page.locator("wiser-hive-schedule-card").nth(2);
    await live.locator("button[data-action='edit']").waitFor();
    await live.locator("button[data-action='edit']").click();
    await live.locator("button[data-action='save']").click();
    assert.match(await live.locator(".shell").innerText(), /Live writes are disabled/);
    assert.equal(await page.evaluate(() => window.__liveTest.saves), 0);

    // Opted-in writes still require a confirmation naming currently observed rooms.
    await page.evaluate(() => {
      const demo = new WiserScheduleCore.DemoTransport();
      demo.schedules[0].Assignments.push({ Id: 3, Name: "Kitchen" });
      window.__shared = { confirms: [], writes: 0 };
      window.confirm = (message) => {
        window.__shared.confirms.push(message);
        return false;
      };
      const card = document.createElement("wiser-hive-schedule-card");
      card.setConfig({ demo: false, hub: "My hub", allow_live_writes: true });
      document.body.appendChild(card);
      card.hass = {
        config: { components: ["wiser"] },
        callWS: async (message) => {
          if (message.type === "wiser/hubs") return ["My hub"];
          if (message.type === "wiser/schedules") return demo.list();
          if (message.type === "wiser/schedule/id") return demo.read(message.schedule_id);
          if (message.type === "wiser/schedule/save") { window.__shared.writes++; return "success"; }
          throw Error("Unexpected message " + message.type);
        }
      };
    });
    const shared = page.locator("wiser-hive-schedule-card").nth(3);
    await shared.locator("button[data-action='edit']").waitFor();
    await shared.locator("button[data-action='edit']").click();
    await shared.locator("button[data-action='save']").click();
    await page.waitForFunction(() => window.__shared.confirms.length === 1);
    const observed = await page.evaluate(() => window.__shared);
    assert.match(observed.confirms[0], /Lobby, Kitchen/);
    assert.match(observed.confirms[0], /cached/);
    assert.equal(observed.writes, 0, "Declined confirmation must prevent any write");
    assert.deepEqual(pageErrors, [], "Browser has no uncaught JavaScript errors");
    console.log("Browser UI checks passed: mobile, overnight, focus, demo, explicit retry, live-save gate, assignment confirmation.");
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
