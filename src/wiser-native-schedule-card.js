/*
 * Wiser Style Heating - Hive-inspired Wiser-native schedule card.
 * Development prototype: use demo: true until a real Wiser hub has been commissioned.
 * Bundled with src/wiser-schedule-core.js by scripts/build.cjs.
 */
(function () {
  "use strict";
  const Core = globalThis.WiserScheduleCore;
  if (!Core) throw new Error("WiserScheduleCore must be loaded before the schedule card");
  if (customElements.get("wiser-hive-schedule-card")) return;
  const DAYS = Core.DAYS;
  const esc = (input) => String(input ?? "").replace(/[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const formatTemp = (value) => Number(value) === -20 ? "Off" : Number(value) + "°C";
  const prettyError = (error) => error && error.message ? error.message : String(error);

  class WiserHiveScheduleCard extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" });
      this.config = {};
      this._hass = null;
      this._loaded = false;
      this._initializationAttempted = false;
      this._busy = false;
      this._editing = false;
      this._error = "";
      this._notice = "";
      this._day = "Monday";
      this._items = [];
      this._schedule = null;
      this._draft = null;
      this._id = null;
      this._hub = "";
      this._transport = null;
      this.shadowRoot.addEventListener("click", (event) => this._handleClick(event));
      this.shadowRoot.addEventListener("change", (event) => this._handleChange(event));
    }
    setConfig(config) {
      this.config = { ...config };
      if (config.demo !== true && config.demo !== false) this.config.demo = true;
      this._loaded = false;
      this._initializationAttempted = false;
      this._transport = null;
      this._editing = false;
      this._schedule = null;
      this._draft = null;
      if (this.isConnected && this._hass) this._initialize();
    }
    set hass(value) {
      this._hass = value;
      if (!this._initializationAttempted && !this._busy && this.isConnected) this._initialize();
    }
    get hass() { return this._hass; }
    connectedCallback() {
      this._render();
      if (!this._initializationAttempted && this._hass) this._initialize();
    }
    getCardSize() { return 7; }
    static getStubConfig() { return { demo: true }; }

    async _initialize() {
      if (this._busy || !this._hass || this._initializationAttempted) return;
      this._initializationAttempted = true;
      this._busy = true;
      this._error = "";
      this._render();
      try {
        if (this.config.demo) {
          this._hub = "demo";
          this._transport = new Core.DemoTransport();
        } else {
          if (!this._hass.config?.components?.includes("wiser"))
            throw new Error("The Wiser Home Assistant integration is not loaded. Enable demo mode to preview.");
          const probe = new Core.WiserTransport(this._hass, "");
          const hubs = await probe.hubs();
          const selected = this.config.hub || (hubs.length === 1 ? hubs[0] : "");
          if (!selected) throw new Error("More than one Wiser hub found; add hub: YOUR_HUB_NAME to this card.");
          if (!hubs.includes(selected)) throw new Error("Selected Wiser hub was not found: " + selected);
          this._hub = selected;
          this._transport = new Core.WiserTransport(this._hass, selected);
        }
        this._items = await this._transport.list();
        if (!this._items.length) throw new Error("No Wiser heating schedules found on this hub.");
        const preferred = this._id && this._items.some((item) => item.Id === Number(this._id))
          ? this._id : this._items[0].Id;
        await this._read(preferred);
        this._loaded = true;
      } catch (error) {
        this._error = prettyError(error);
        this._loaded = false;
      } finally {
        this._busy = false;
        this._render();
      }
    }

    async _read(id) {
      this._schedule = await this._transport.read(id);
      this._id = Number(id);
      this._draft = Core.copy(this._schedule);
      this._editing = false;
      this._notice = "";
    }

    async _run(task, notice = "") {
      if (this._busy) return;
      this._busy = true;
      this._error = "";
      this._render();
      try {
        await task();
        if (notice) this._notice = notice;
      } catch (error) {
        this._error = prettyError(error);
      } finally {
        this._busy = false;
        this._render();
      }
    }

    _inlineError() {
      // Preserve active input and native time picker instead of replacing innerHTML.
      const errorBox = this.shadowRoot.querySelector?.("#inline-error");
      if (!errorBox) return;
      errorBox.textContent = this._error;
      errorBox.hidden = !this._error;
    }
    _refreshTimePresentation() {
      // Update only derived labels. Never replace the input nodes while the
      // browser's native time/number picker may still own focus.
      if (!this._editing || !this._draft) return;
      const rows = Core.daySlots(this._draft, this._day);
      const boundary = Core.boundaries(this._draft, this._day);
      const endLabels = this.shadowRoot.querySelectorAll("[data-period-end]");
      endLabels.forEach((label) => {
        const index = Number(label.dataset.periodEnd);
        const next = rows[index + 1];
        label.textContent = next
          ? "Until " + next.Time
          : "Until " + boundary.nextDay + " " + boundary.nextTime;
      });
      const carry = this.shadowRoot.querySelector("[data-carryover]");
      if (carry) {
        carry.hidden = !boundary.carryover;
        carry.textContent = boundary.carryover
          ? "00:00–" + boundary.carryover.until + ": " +
            formatTemp(boundary.carryover.setpoint) +
            " carried over from " + boundary.carryover.fromDay + "."
          : "";
      }
    }
    _apply(callback, render = true) {
      try {
        this._draft = callback();
        this._error = "";
        if (render) this._render();
        else this._inlineError();
        return true;
      } catch (error) {
        this._error = prettyError(error);
        if (render) this._render();
        else this._inlineError();
        return false;
      }
    }

    async _handleChange(event) {
      const target = event.target;
      if (!(target instanceof HTMLElement) || this._busy) return;
      if (target.dataset.action === "choose") {
        await this._run(() => this._read(Number(target.value)));
        return;
      }
      if (!this._editing || !this._draft) return;
      if (target.dataset.action === "time" || target.dataset.action === "temperature") {
        const day = target.dataset.day, index = Number(target.dataset.index);
        const patch = target.dataset.action === "time"
          ? { Time: target.value } : { Setpoint: target.value };
        const oldValue = Core.daySlots(this._draft, day)[index][target.dataset.action === "time" ? "Time" : "Setpoint"];
        // 'change', not 'input': do not destroy focus or recreate time/number inputs while editing.
        const ok = this._apply(() => Core.changeSlot(this._draft, day, index, patch), false);
        if (!ok) target.value = String(oldValue);
        else if (target.dataset.action === "time") this._refreshTimePresentation();
      }
    }

    async _handleClick(event) {
      const node = event.target.closest("[data-action]");
      if (!node || this._busy) return;
      const action = node.dataset.action;
      if (action === "day") {
        this._day = node.dataset.day;
        this._render();
        return;
      }
      if (action === "reload") {
        this._loaded = false;
        this._initializationAttempted = false;
        await this._initialize();
        return;
      }
      if (action === "edit") {
        if (!Core.editable(this._schedule)) {
          this._error = "Advanced Wiser schedules are view-only until their full fields are supported.";
        } else {
          this._draft = Core.copy(this._schedule);
          this._editing = true;
          this._error = "";
        }
        this._render();
        return;
      }
      if (action === "cancel") {
        this._draft = Core.copy(this._schedule);
        this._editing = false;
        this._error = "";
        this._render();
        return;
      }
      if (!this._editing) return;
      if (action === "remove") {
        this._apply(() => Core.deleteSlot(this._draft, this._day, Number(node.dataset.index)));
        return;
      }
      if (action === "add") {
        const existing = new Set(Core.daySlots(this._draft, this._day).map((item) => item.Time));
        const time = ["12:00", "15:00", "10:00", "19:00", "05:00", "21:00", "23:30", "01:00"]
          .find((candidate) => !existing.has(candidate));
        const period = Core.daySlots(this._draft, this._day).slice(-1)[0];
        this._apply(() => Core.addSlot(this._draft, this._day, time, Number(period.Setpoint)));
        return;
      }
      if (action === "copy-weekdays" || action === "copy-weekend") {
        const targets = action === "copy-weekdays" ? DAYS.slice(0, 5) : DAYS.slice(5);
        this._apply(() => Core.copyDay(this._draft, this._day, targets.filter((day) => day !== this._day)));
        return;
      }
      if (action === "save") {
        if (!this.config.demo && this.config.allow_live_writes !== true) {
          this._error = "Live writes are disabled. The Wiser schedule API can return cached data; set allow_live_writes: true only after backing up schedules and accepting that concurrent changes can still be overwritten.";
          this._render();
          return;
        }
        await this._run(async () => {
          if (!this.config.demo) {
            // Wiser schedule/id returns integration-cached data, NOT an authoritative live hub fetch.
            // Rechecking here narrows the window for already-observed changes but cannot close the race.
            const observed = await this._transport.read(this._id);
            if (Core.fingerprint(observed) !== Core.fingerprint(this._schedule))
              throw new Error("A Wiser schedule change was observed. Reload before saving.");
            if (Core.assignmentsFingerprint(observed) !== Core.assignmentsFingerprint(this._schedule))
              throw new Error("Wiser room assignments have changed. Reload before saving.");
            const names = Core.assignments(observed).map((room) => room.Name);
            const count = this._items.find((item) => Number(item.Id) === this._id)?.Assignments;
            if (typeof count === "number" && count !== names.length)
              throw new Error("Schedule assignment count differs from cached room names. Reload before saving.");
            const affected = names.length ? names.join(", ") : "none currently shown";
            const message =
              "Confirm Wiser schedule update for: " + affected + ".\n\n" +
              "WARNING: These details come from Home Assistant's Wiser cache, not a fresh hub query. " +
              "A change made in the Wiser app that has not reached HA can be overwritten. " +
              "There is no atomic conflict protection. Continue?";
            if (!window.confirm(message)) return;
          }
          const updated = await this._transport.save(this._schedule, this._draft);
          this._schedule = updated;
          this._draft = Core.copy(updated);
          this._editing = false;
          this._notice = this.config.demo
            ? "Saved to demo memory only — no Wiser heating changed."
            : "Save acknowledged and checked against Wiser integration readback (which may be cached).";
        });
      }
    }

    _render() {
      const schedule = this._editing ? this._draft : this._schedule;
      const configuredName = this.config.title || "Heating";
      const loading = this._busy && !this._schedule;
      const shared = (this._schedule?.Assignments?.length ||
        this._items.find((item) => item.Id === this._id)?.Assignments || 0);
      const rows = schedule ? Core.daySlots(schedule, this._day) : [];
      const boundary = schedule ? Core.boundaries(schedule, this._day) : null;
      const inputs = this._editing;
      const options = this._items.map((entry) =>
        `<option value="${entry.Id}" ${Number(entry.Id) === this._id ? "selected" : ""}>${esc(entry.Name)}</option>`
      ).join("");
      const days = DAYS.map((day) =>
        `<button data-action="day" data-day="${day}" class="day ${day === this._day ? "active" : ""}" aria-pressed="${day === this._day}">${day.slice(0, 3)}</button>`
      ).join("");
      const periods = rows.map((slot, index) => {
        const next = rows[index + 1];
        const until = next ? "Until " + esc(next.Time)
          : "Until " + esc(boundary.nextDay) + " " + esc(boundary.nextTime);
        const time = inputs
          ? `<input aria-label="Start of period ${index + 1}" type="time" data-action="time" data-day="${this._day}" data-index="${index}" value="${esc(slot.Time)}"/>`
          : `<strong>${esc(slot.Time)}</strong>`;
        const temperature = inputs
          ? `<input aria-label="Temperature for period ${index + 1}" type="number" min="5" max="30" step="0.5" data-action="temperature" data-day="${this._day}" data-index="${index}" value="${esc(slot.Setpoint)}"/>`
          : `<span class="temp">${formatTemp(slot.Setpoint)}</span>`;
        return `<div class="period">
          <div class="period-dot"></div>
          <div class="period-time">${time}<small data-period-end="${index}">${until}</small></div>
          <div class="period-value">${temperature}</div>
          ${inputs ? `<button class="remove" aria-label="Remove period" title="Remove period" data-action="remove" data-index="${index}">×</button>` : ""}
        </div>`;
      }).join("");
      this.shadowRoot.innerHTML = `
      <style>
        :host{display:block;--ws-bg:#f7f8fa;--ws-accent:#263b52;--ws-ink:#172234;--ws-muted:#647286;font:inherit;color:var(--ws-ink)}
        *{box-sizing:border-box}button,select,input{font:inherit}
        .shell{border-radius:23px;background:var(--ws-bg);padding:clamp(14px,3vw,28px);box-shadow:0 8px 28px #00000012;max-width:900px;margin:auto}
        .top{display:flex;justify-content:space-between;align-items:center;gap:12px}.eyebrow{font-size:11px;letter-spacing:2px;font-weight:800;color:var(--ws-muted);text-transform:uppercase}
        h2{font:600 clamp(26px,4vw,37px) Georgia,serif;letter-spacing:-.6px;margin:8px 0 4px}
        .status{color:var(--ws-muted);font-size:12px}.demo{background:#ebddc9;color:#7b4b21;border-radius:20px;padding:7px 11px;font-size:11px;font-weight:800}
        .settings{margin-top:20px;background:#fff;border-radius:15px;padding:15px;display:flex;align-items:center;justify-content:space-between;gap:12px;box-shadow:0 1px 5px #00000008}
        .settings label{font-size:12px;color:var(--ws-muted)}select{display:block;margin-top:6px;min-width:200px;max-width:100%;border:0;font-weight:700;color:var(--ws-ink);background:transparent;outline-offset:4px}
        .days{display:grid;grid-template-columns:repeat(7,1fr);gap:5px;margin:20px 0 15px}.day{border:0;cursor:pointer;background:#fff;border-radius:10px;padding:12px 2px;color:var(--ws-muted);font-weight:700}
        .day.active{background:var(--ws-accent);color:white}.day:focus-visible,button:focus-visible{outline:3px solid #6381a0;outline-offset:3px}
        .timeline{border-radius:19px;background:#fff;padding:8px 19px}.period{display:flex;align-items:center;gap:14px;min-height:75px;border-bottom:1px solid #edf0f2;position:relative}
        .period:last-child{border-bottom:none}.period-dot{border:4px solid #e5a36d;width:17px;height:17px;border-radius:50%;flex-shrink:0}
        .period-time{display:flex;flex-direction:column;gap:4px;flex:1;min-width:0}.period-time strong{font-size:18px}.period-time small{font-size:11px;color:var(--ws-muted)}
        .temp{font-size:25px;font-weight:600;color:#ab622d}.period-value input{width:80px}.period input{padding:7px;border:1px solid #c9d0da;border-radius:8px;background:white;max-width:135px}
        .remove{border:0;background:#fbe9e8;color:#b43d38;font-size:24px;border-radius:9px;width:32px;height:36px;cursor:pointer}
        .actions{display:flex;justify-content:flex-end;gap:9px;flex-wrap:wrap;margin-top:16px}button.action{border:0;background:#e5e9ee;color:var(--ws-ink);padding:11px 16px;border-radius:12px;cursor:pointer;font-weight:700;font-size:13px}
        button.primary{background:var(--ws-accent);color:#fff}button:disabled{opacity:.5;cursor:wait}
        .message{margin-top:12px;border-radius:12px;padding:12px;font-size:13px;background:#edf2f6}.error{background:#ffebec;color:#8e2730}
        .warning{background:#fff2d9;color:#6c4d1c;font-size:12px;padding:12px;border-radius:12px;margin-top:14px}
        .carry{background:#e8eff5;color:#344d66;font-size:12px;padding:12px;border-radius:12px;margin:12px 0}
        [hidden]{display:none!important}
        .foot{font-size:11px;color:var(--ws-muted);margin:17px 0 0}
        @media(max-width:560px){.shell{border-radius:14px;padding:13px}.settings{align-items:stretch;flex-direction:column}.days{gap:3px}.day{font-size:12px}.timeline{padding:5px 10px}.period{gap:7px}.period-value input{width:67px}.period input{font-size:13px;padding:5px}.period-time strong{font-size:16px}.temp{font-size:21px}}
      </style>
      <section class="shell">
        <header class="top"><div><div class="eyebrow">Wiser Style Heating</div><h2>${esc(configuredName)}</h2>
        <div class="status">${this.config.demo ? "Interactive preview" : "Wiser hub · " + esc(this._hub || "connecting")}</div></div>
        ${this.config.demo ? '<span class="demo">DEMO</span>' : ""}
        </header>
        ${schedule ? `
          <div class="settings"><label>Room schedule<select data-action="choose" ${this._editing || this._busy ? "disabled" : ""}>${options}</select></label>
            <span class="status">${shared} assigned room${shared === 1 ? "" : "s"}</span></div>
          <nav class="days" aria-label="Days of the week">${days}</nav>
          <div class="carry" data-carryover ${boundary.carryover ? "" : "hidden"}>${boundary.carryover
            ? `00:00–${esc(boundary.carryover.until)}: ${formatTemp(boundary.carryover.setpoint)} carried over from ${esc(boundary.carryover.fromDay)}.`
            : ""}</div>
          <div class="timeline">${periods}</div>
          ${shared > 1 ? '<div class="warning">Shared schedule: saving changes will affect every assigned room. Assignments will be rechecked before confirming.</div>' : ""}
          ${!this.config.demo ? '<div class="warning">Wiser schedule reads may be cached. Live saves are not atomic and are disabled unless allow_live_writes: true is set.</div>' : ""}
          ${!Core.editable(this._schedule) ? '<div class="warning">This advanced Wiser schedule is view-only to protect unsupported fields.</div>' : ""}
          <div class="actions">
            ${inputs ? `
              <button class="action" data-action="copy-weekdays">Copy to weekdays</button>
              <button class="action" data-action="copy-weekend">Copy to weekend</button>
              <button class="action" data-action="add">Add period</button>
              <button class="action" data-action="cancel">Cancel</button>
              <button class="action primary" data-action="save">Save schedule</button>`
            : `<button class="action" data-action="reload">Reload</button>
              <button class="action primary" data-action="edit" ${!Core.editable(this._schedule) ? "disabled" : ""}>Edit schedule</button>`}
          </div>` : (loading ? '<p>Loading heating schedules…</p>' : "")}
        <div id="inline-error" role="alert" class="message error" ${this._error ? "" : "hidden"}>${esc(this._error)}</div>
        ${this._error && !this._loaded ? '<button class="action" data-action="reload">Retry connection</button>' : ""}
        ${this._notice ? `<div role="status" class="message">${esc(this._notice)}</div>` : ""}
        <div class="foot">Schedules are owned by the Wiser hub. ${this.config.demo ? "Demo changes are only held until this card reloads." : "Live readback reflects the Wiser integration cache; recent changes in the Wiser app may not be visible."}</div>
      </section>`;
    }
  }
  customElements.define("wiser-hive-schedule-card", WiserHiveScheduleCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "wiser-hive-schedule-card",
    name: "Wiser Style Heating Schedule",
    description: "Hive-inspired editor for Wiser hub schedules (with demo mode).",
    preview: true
  });
})();
