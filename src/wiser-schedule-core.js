/*
 * Wiser Style Heating - Wiser-native schedule data and transport.
 * The card communicates with the existing Wiser HA integration, never directly with the boiler.
 * Original project: https://github.com/xtrendmaster/hive-style-thermostat-cards
 * API reference: https://github.com/andyblac/wiser-schedule-card
 * MIT License. See root LICENSE and docs/ATTRIBUTION.md.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.WiserScheduleCore = api;
})(typeof globalThis === "object" ? globalThis : this, function () {
  "use strict";
  const DAYS = Object.freeze(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]);
  const DEMO_ROOMS = Object.freeze([
    ["Lobby", 19], ["Living Room/Dining Room", 21], ["Kitchen", 19],
    ["Bedroom 1", 18], ["Bedroom 2", 18], ["Bedroom 3", 18],
    ["Office", 20], ["Utility room", 17]
  ]);
  const copy = (value) => JSON.parse(JSON.stringify(value));
  const validTime = (value) => typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
  const minutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  const isHeating = (schedule) => String(schedule && schedule.Type).toLowerCase() === "heating";

  function validate(schedule) {
    if (!schedule || !isHeating(schedule)) throw new Error("Only Wiser heating schedules can be edited.");
    if (!Array.isArray(schedule.ScheduleData) || schedule.ScheduleData.length !== 7)
      throw new Error("A Wiser heating schedule requires seven days.");
    const seen = new Set();
    for (const entry of schedule.ScheduleData) {
      if (!DAYS.includes(entry.day) || seen.has(entry.day)) throw new Error("Invalid or repeated schedule day.");
      seen.add(entry.day);
      if (!Array.isArray(entry.slots) || entry.slots.length < 1 || entry.slots.length > 8)
        throw new Error(entry.day + " needs between one and eight periods.");
      let previous = -1;
      for (const slot of entry.slots) {
        if (!validTime(slot.Time)) throw new Error("Invalid time in " + entry.day + ": " + slot.Time);
        const at = minutes(slot.Time);
        if (at <= previous) throw new Error("Periods must be in chronological order with unique start times.");
        previous = at;
        const setpoint = Number(slot.Setpoint);
        const min = Number.isFinite(Number(schedule.MinSetpoint)) && schedule.MinSetpoint != null
          ? Number(schedule.MinSetpoint) : 5;
        const max = Number.isFinite(Number(schedule.MaxSetpoint)) && schedule.MaxSetpoint != null
          ? Number(schedule.MaxSetpoint) : 30;
        if (!Number.isFinite(setpoint) || (setpoint !== -20 && (setpoint < min || setpoint > max)))
          throw new Error("Invalid temperature in " + entry.day + ": " + slot.Setpoint);
      }
    }
    return true;
  }

  function editable(schedule) {
    if (!isHeating(schedule)) return false;
    // Passive control has additional fields that a simple time/temperature editor must not overwrite.
    if (schedule.PassiveControl || schedule.PassiveRange) return false;
    if (schedule.ScheduleData?.some((day) => day.slots?.some((slot) => Number(slot.Setpoint) === -20))) return false;
    if (Math.abs(Number(schedule.Id)) === 1000) return false;
    return true;
  }

  function daySlots(schedule, day) {
    const record = schedule.ScheduleData.find((item) => item.day === day);
    if (!record) throw new Error("Missing " + day);
    return record.slots;
  }

  function changeSlot(schedule, day, index, patch) {
    if (!editable(schedule)) throw new Error("This schedule is view-only in the first version.");
    const draft = copy(schedule);
    const slots = daySlots(draft, day);
    if (!Number.isInteger(index) || index < 0 || index >= slots.length) throw new Error("Unknown period.");
    // Preserve Wiser-specific slot fields, including SpecialTime, rather than creating a bare object.
    if (Object.prototype.hasOwnProperty.call(patch, "Time")) slots[index].Time = String(patch.Time);
    if (Object.prototype.hasOwnProperty.call(patch, "Setpoint"))
      slots[index].Setpoint = String(patch.Setpoint);
    slots.sort((a, b) => minutes(a.Time) - minutes(b.Time));
    validate(draft);
    return draft;
  }

  function addSlot(schedule, day, time, temperature) {
    if (!editable(schedule)) throw new Error("This schedule is view-only in the first version.");
    const draft = copy(schedule);
    const slots = daySlots(draft, day);
    slots.push({ Time: String(time), Setpoint: String(temperature), SpecialTime: "" });
    slots.sort((a, b) => minutes(a.Time) - minutes(b.Time));
    validate(draft);
    return draft;
  }

  function deleteSlot(schedule, day, index) {
    if (!editable(schedule)) throw new Error("This schedule is view-only in the first version.");
    const draft = copy(schedule);
    const slots = daySlots(draft, day);
    if (!Number.isInteger(index) || index < 0 || index >= slots.length) throw new Error("Unknown period.");
    slots.splice(index, 1);
    validate(draft);
    return draft;
  }

  function copyDay(schedule, source, targets) {
    if (!editable(schedule)) throw new Error("This schedule is view-only in the first version.");
    const draft = copy(schedule);
    const slots = copy(daySlots(draft, source));
    for (const day of targets) {
      if (!DAYS.includes(day)) throw new Error("Unknown target day.");
      daySlots(draft, day).splice(0, daySlots(draft, day).length, ...copy(slots));
    }
    validate(draft);
    return draft;
  }

  function fingerprint(schedule) {
    // Ignore volatile assignments and UI-only metadata when checking for concurrent schedule changes.
    return JSON.stringify({
      Id: Number(schedule.Id),
      Name: schedule.Name,
      Type: schedule.Type,
      ScheduleData: DAYS.map((day) => ({ day, slots: daySlots(schedule, day) }))
    });
  }

  class WiserTransport {
    constructor(hass, hub) {
      if (!hass || typeof hass.callWS !== "function") throw new Error("Home Assistant WebSocket API unavailable.");
      this.hass = hass;
      this.hub = hub || "";
    }
    ws(type, props = {}) { return this.hass.callWS({ type, hub: this.hub, ...props }); }
    hubs() { return this.hass.callWS({ type: "wiser/hubs" }); }
    async list() {
      const rows = await this.ws("wiser/schedules", { schedule_type: "Heating" });
      return rows.filter((row) => String(row.Type).toLowerCase() === "heating");
    }
    read(id) { return this.ws("wiser/schedule/id", { schedule_type: "Heating", schedule_id: Number(id) }); }
    async save(original, draft) {
      if (!editable(original) || !editable(draft)) throw new Error("This schedule cannot be edited safely.");
      if (Number(original.Id) !== Number(draft.Id)) throw new Error("Schedule identity mismatch.");
      validate(draft);
      const before = await this.read(original.Id);
      if (fingerprint(before) !== fingerprint(original))
        throw new Error("The schedule was changed elsewhere. Reload before saving to avoid overwriting it.");
      const result = await this.ws("wiser/schedule/save", {
        schedule_type: "Heating", schedule_id: Number(draft.Id), schedule: draft
      });
      if (result !== "success" && result !== true) throw new Error("Wiser did not acknowledge the schedule update.");
      const after = await this.read(draft.Id);
      if (fingerprint(after) !== fingerprint(draft))
        throw new Error("Save returned, but the Wiser readback differs. Check the hub before trying again.");
      return after;
    }
  }

  function makeDemoSchedules() {
    return DEMO_ROOMS.map(([name, comfort], index) => ({
      Id: index + 1, Name: name, Type: "Heating", SubType: "", MinSetpoint: 5, MaxSetpoint: 30,
      Assignments: [{ Id: index + 1, Name: name }],
      ScheduleData: DAYS.map((day, dayIndex) => ({
        day, slots: (dayIndex < 5
          ? [["06:30", comfort], ["08:30", 16], ["17:00", comfort], ["22:30", 16]]
          : [["08:00", comfort], ["23:00", 16]])
          .map(([Time, Setpoint]) => ({ Time, Setpoint: String(Setpoint), SpecialTime: "" }))
      }))
    }));
  }

  class DemoTransport {
    constructor() { this.schedules = makeDemoSchedules(); this.hub = "demo"; }
    async hubs() { return ["demo"]; }
    async list() {
      return this.schedules.map((s) => ({
        Id: s.Id, Name: s.Name, Type: s.Type, Assignments: s.Assignments.length
      }));
    }
    async read(id) {
      const schedule = this.schedules.find((s) => s.Id === Number(id));
      if (!schedule) throw new Error("Demo schedule not found.");
      return copy(schedule);
    }
    async save(original, draft) {
      validate(draft);
      const current = await this.read(original.Id);
      if (fingerprint(current) !== fingerprint(original)) throw new Error("Demo schedule changed. Reload it.");
      this.schedules = this.schedules.map((s) => s.Id === draft.Id ? copy(draft) : s);
      return this.read(draft.Id);
    }
  }

  return { DAYS, DEMO_ROOMS, copy, validate, editable, daySlots, changeSlot, addSlot,
    deleteSlot, copyDay, fingerprint, WiserTransport, DemoTransport };
});
