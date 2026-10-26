"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const Core = require("../src/wiser-schedule-core.js");

const fixture = () => new Core.DemoTransport();
test("demo has eight requested rooms and seven-day schedules", async () => {
  const demo = fixture();
  const list = await demo.list();
  assert.equal(list.length, 8);
  assert.deepEqual(list.map((x) => x.Name), [
    "Lobby", "Living Room/Dining Room", "Kitchen", "Bedroom 1",
    "Bedroom 2", "Bedroom 3", "Office", "Utility room"
  ]);
  const item = await demo.read(1);
  assert.equal(item.ScheduleData.length, 7);
  assert.equal(item.ScheduleData[0].slots[0].Time, "06:30");
  assert.ok(Core.validate(item));
});
test("temperature and time edits preserve other days and original", async () => {
  const original = await fixture().read(1);
  const revised = Core.changeSlot(original, "Monday", 0, { Setpoint: "20.5" });
  assert.equal(revised.ScheduleData[0].slots[0].Setpoint, "20.5");
  assert.equal(original.ScheduleData[0].slots[0].Setpoint, "19");
  assert.equal(revised.ScheduleData[1].slots[0].Setpoint, "19");
  assert.equal(Core.changeSlot(original, "Monday", 0, { Time: "06:00" }).ScheduleData[0].slots[0].Time, "06:00");
});
test("add, remove, and copy a day without touching original", async () => {
  const original = await fixture().read(1);
  const added = Core.addSlot(original, "Monday", "12:00", 18);
  assert.equal(Core.daySlots(added, "Monday").length, 5);
  const removed = Core.deleteSlot(added, "Monday", 2);
  assert.equal(Core.daySlots(removed, "Monday").length, 4);
  const copied = Core.copyDay(original, "Saturday", ["Monday", "Tuesday"]);
  assert.deepEqual(Core.daySlots(copied, "Monday"), Core.daySlots(original, "Saturday"));
  assert.equal(Core.daySlots(original, "Monday").length, 4);
});
test("reject invalid time, temperatures and too many periods", async () => {
  const item = await fixture().read(1);
  assert.throws(() => Core.addSlot(item, "Monday", "25:90", 20), /Invalid time/);
  assert.throws(() => Core.addSlot(item, "Monday", "06:30", 20), /chronological/);
  assert.throws(() => Core.changeSlot(item, "Monday", 0, { Setpoint: "35" }), /temperature/);
  let expanded = item;
  for (const time of ["10:00", "11:00", "12:00", "13:00"])
    expanded = Core.addSlot(expanded, "Monday", time, 19);
  assert.throws(() => Core.addSlot(expanded, "Monday", "14:00", 19), /one and eight/);
  assert.throws(() => Core.deleteSlot({ ...item, ScheduleData: item.ScheduleData.map((d) =>
    d.day === "Monday" ? { ...d, slots: [d.slots[0]] } : d) }, "Monday", 0), /one and eight/);
});
test("advanced passive schedules remain view-only", async () => {
  const item = await fixture().read(1);
  item.PassiveControl = true;
  assert.equal(Core.editable(item), false);
  assert.throws(() => Core.changeSlot(item, "Monday", 0, { Setpoint: 20 }), /view-only/);
});
test("mock Wiser WebSocket uses hub-owned endpoints and checks readback", async () => {
  const demo = fixture();
  const calls = [];
  const hass = { callWS: async (message) => {
    calls.push(message);
    if (message.type === "wiser/hubs") return ["Main Hub"];
    if (message.type === "wiser/schedules") return demo.list();
    if (message.type === "wiser/schedule/id") return demo.read(message.schedule_id);
    if (message.type === "wiser/schedule/save") {
      const old = await demo.read(message.schedule_id);
      await demo.save(old, message.schedule);
      return "success";
    }
    throw Error("Unrecognised endpoint " + message.type);
  } };
  const transport = new Core.WiserTransport(hass, "Main Hub");
  assert.deepEqual(await transport.hubs(), ["Main Hub"]);
  assert.equal((await transport.list()).length, 8);
  const original = await transport.read(1);
  const changed = Core.changeSlot(original, "Monday", 0, { Setpoint: "20" });
  assert.equal((await transport.save(original, changed)).ScheduleData[0].slots[0].Setpoint, "20");
  assert.equal(calls.find((c) => c.type === "wiser/schedule/save").hub, "Main Hub");
  assert.equal(calls.find((c) => c.type === "wiser/schedule/save").schedule_type, "Heating");
  assert.equal(calls.filter((c) => c.type === "wiser/schedule/id").length, 3);
});
test("conflicting remote change blocks save", async () => {
  const demo = fixture();
  const original = await demo.read(1);
  const draft = Core.changeSlot(original, "Monday", 0, { Setpoint: 20 });
  await demo.save(original, Core.changeSlot(original, "Monday", 0, { Setpoint: 22 }));
  const transport = new Core.WiserTransport({
    callWS: async ({ type, schedule_id }) => type === "wiser/schedule/id" ? demo.read(schedule_id)
      : (() => { throw Error("Must not write"); })()
  }, "Main Hub");
  await assert.rejects(() => transport.save(original, draft), /changed elsewhere/);
});
test("incorrect Wiser readback is reported rather than claiming success", async () => {
  const demo = fixture();
  const original = await demo.read(1);
  const draft = Core.changeSlot(original, "Monday", 0, { Setpoint: "20" });
  const transport = new Core.WiserTransport({
    callWS: async ({ type, schedule_id }) => type === "wiser/schedule/id" ? demo.read(schedule_id) : "success"
  }, "Main Hub");
  await assert.rejects(() => transport.save(original, draft), /readback differs/);
});
