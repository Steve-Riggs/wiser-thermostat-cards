/*!
 * Hive-style thermostat cards for Home Assistant
 * https://github.com/xtrendmaster/hive-style-thermostat-cards
 * MIT licence. Not affiliated with or endorsed by Hive / Centrica.
 *
 * Cards:
 *   custom:hive-temp-picker    - hold-to-scroll temperature wheel, background follows the temperature
 *   custom:hive-schedule-card  - per-day heating schedule viewer + editor (Scheduler component)
 *   write gate                 - batches temperature changes so Hive's servers don't block them
 *                                (buttons: tap_action fire-dom-event with hive_nudge / hive_set)
 */
const HSTC_VERSION = '1.3.2';
console.info(`%c HIVE-STYLE-THERMOSTAT-CARDS %c v${HSTC_VERSION} `, 'background:#E8642E;color:#fff;font-weight:600', 'background:#4350E6;color:#fff');

// Fonts used by the cards and the example dashboard (DM Serif Display + Inter, SIL OFL).
if (!document.getElementById('hstc-fonts')) {
  const l = document.createElement('link');
  l.id = 'hstc-fonts';
  l.rel = 'stylesheet';
  l.href = 'https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=Inter:wght@300;400;500;600&display=swap';
  document.head.appendChild(l);
}

/* ------------------------------------------------------------------ */
/* Write gate: be gentle with cloud thermostats (Hive)                  */
/*  - waits until you stop tapping/scrolling (2 s), then sends ONE change */
/*  - never more than one change per thermostat every 10 s              */
/*  - shows a small "Setting 19.5 deg" bubble while a change is waiting  */
/* Hive's servers answer bursts of changes with HTTP 403 "Token expired  */
/* or forbidden" for a few minutes; this prevents that.                  */
/* ------------------------------------------------------------------ */
(() => {
  if (window.__hiveGate) return;
  const DEBOUNCE = 2000;
  const GAP = 10000;
  const G = { pending: {}, timers: {}, last: {}, busy: {} };
  window.__hiveGate = G;

  const root = () => document.querySelector('home-assistant');
  const hass = () => (root() ? root().hass : null);
  const toast = (message) => {
    const r = root();
    if (r) r.dispatchEvent(new CustomEvent('hass-notification', { detail: { message }, bubbles: true, composed: true }));
  };

  // ---- pending bubble ----
  const css = document.createElement('style');
  css.textContent = `
#hive-gate-bubble{position:fixed;left:50%;bottom:calc(env(safe-area-inset-bottom) + 118px);transform:translate(-50%,12px);z-index:20;
  display:flex;align-items:center;gap:10px;padding:10px 18px;border-radius:22px;background:rgba(30,30,40,.86);color:#fff;
  font:500 15px Inter,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.25);opacity:0;pointer-events:none;transition:opacity .25s,transform .25s}
#hive-gate-bubble.on{opacity:1;transform:translate(-50%,0)}
#hive-gate-bubble i{width:14px;height:14px;border:2px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;animation:hgspin .8s linear infinite}
@keyframes hgspin{to{transform:rotate(360deg)}}`;
  document.head.appendChild(css);
  let bubble = null;
  const show = (text) => {
    if (!bubble) {
      bubble = document.createElement('div');
      bubble.id = 'hive-gate-bubble';
      bubble.innerHTML = '<i></i><span></span>';
      document.body.appendChild(bubble);
    }
    bubble.querySelector('span').textContent = text;
    requestAnimationFrame(() => bubble.classList.add('on'));
  };
  const hide = () => { if (bubble && !Object.keys(G.pending).length && !Object.values(G.busy).some(Boolean)) bubble.classList.remove('on'); };

  const clamp = (entity, t) => {
    const h = hass();
    const st = h && h.states[entity];
    const lo = st ? parseFloat(st.attributes.min_temp) || 5 : 5;
    const hi = st ? parseFloat(st.attributes.max_temp) || 32 : 32;
    return Math.min(hi, Math.max(lo, Math.round(t * 2) / 2));
  };

  const flush = (entity) => {
    const v = G.pending[entity];
    if (v == null) return;
    const wait = (G.last[entity] || 0) + GAP - Date.now();
    if (wait > 0) { G.timers[entity] = setTimeout(() => flush(entity), wait); return; }
    delete G.pending[entity];
    G.last[entity] = Date.now();
    const h = hass();
    if (!h) { hide(); return; }
    const st = h.states[entity];
    const cur = st ? parseFloat(st.attributes.temperature) : NaN;
    if (v === cur) { hide(); return; }
    G.busy[entity] = true;
    h.callService('climate', 'set_temperature', { entity_id: entity, temperature: v })
      .catch((e) => toast(`Couldn't set ${v}°: ${e && e.message ? e.message : e}`))
      .finally(() => { G.busy[entity] = false; hide(); });
  };

  G.set = (entity, temp) => {
    const v = clamp(entity, temp);
    G.pending[entity] = v;
    show(`Setting ${v.toFixed(1)}°`);
    clearTimeout(G.timers[entity]);
    const wait = Math.max(DEBOUNCE, (G.last[entity] || 0) + GAP - Date.now());
    G.timers[entity] = setTimeout(() => flush(entity), wait);
  };

  G.nudge = (entity, delta) => {
    const h = hass();
    const st = h && h.states[entity];
    if (!st || st.state === 'unavailable') return;
    const base = G.pending[entity] != null ? G.pending[entity] : parseFloat(st.attributes.temperature);
    G.set(entity, (isNaN(base) ? 18 : base) + delta);
  };

  // Dashboard buttons use: tap_action: { action: fire-dom-event, hive_nudge: { entity_id, delta } }
  // If the entity id arrives un-rendered (template text), take it from the button-card that fired the event.
  const resolve = (id, e) => {
    if (id && /^[a-z_]+\.[a-z0-9_]+$/.test(id)) return id;
    for (const n of e.composedPath()) {
      const c = n && (n._config || n.config);
      if (c && typeof c.entity === 'string') return c.entity;
    }
    return null;
  };
  window.addEventListener('ll-custom', (e) => {
    const d = e.detail || {};
    if (d.hive_nudge) { const id = resolve(d.hive_nudge.entity_id, e); if (id) G.nudge(id, parseFloat(d.hive_nudge.delta) || 0); }
    if (d.hive_set) { const id = resolve(d.hive_set.entity_id, e); if (id) G.set(id, parseFloat(d.hive_set.temperature)); }
  });
  window.hiveSetTemp = G.set;
})();

/* ------------------------------------------------------------------ */
/* Shared: temperature -> colour (blue at 5 deg ... orange ... red at 30 deg) */
/* ------------------------------------------------------------------ */
const HIVE_HUE = [[5, 222], [9, 250], [13, 300], [16, 350], [18.5, 376], [22, 368], [30, 358]];
function hiveHue(t) {
  const c = Math.max(5, Math.min(30, t));
  for (let i = 0; i < HIVE_HUE.length - 1; i++) {
    const [a, ha] = HIVE_HUE[i], [b, hb] = HIVE_HUE[i + 1];
    if (c <= b) return ha + (hb - ha) * (c - a) / (b - a);
  }
  return 358;
}
function hiveGradient(t) {
  const h = hiveHue(t);
  return `linear-gradient(180deg,hsl(${(h % 360).toFixed(0)},76%,56%) 0%,hsl(${((h + 14) % 360).toFixed(0)},80%,64%) 100%)`;
}
window.hiveGradient = hiveGradient;

/* ------------------------------------------------------------------ */
/* custom:hive-temp-picker                                             */
/* ------------------------------------------------------------------ */
const ITEM_H = 133;

class HiveTempPicker extends HTMLElement {
  setConfig(c) {
    if (!c || !c.entity) throw new Error('hive-temp-picker: entity is required');
    this._c = Object.assign({ min: 5, max: 30, step: 0.5, name: '', back_path: '', insights_path: '' }, c);
    this._built = false;
    this._pending = null;
  }
  getCardSize() { return 12; }
  static getStubConfig() { return { entity: 'climate.hive_thermostat', name: 'Thermostat' }; }
  set hass(h) {
    this._hass = h;
    const st = h.states[this._c.entity];
    if (!this._built) { this._build(st); return; }
    if (!this._photoUrl) this._applyPhoto();
    const gate = window.__hiveGate;
    if (gate && gate.pending[this._c.entity] != null) return;
    if (st && !this._touching && this._pending == null) {
      const t = parseFloat(st.attributes.temperature);
      if (!isNaN(t) && t !== this._value) this._scrollTo(t, true);
    }
  }
  // Photo behind the colour: photo: <url> wins, otherwise the picture set on the entity's Area (Settings > Areas)
  _areaPicture() {
    const h = this._hass;
    if (!h || this._c.area_photo === false) return null;
    const e = h.entities && h.entities[this._c.entity];
    let a = e && e.area_id;
    if (!a && e && e.device_id && h.devices && h.devices[e.device_id]) a = h.devices[e.device_id].area_id;
    const ar = a && h.areas && h.areas[a];
    return (ar && ar.picture) || null;
  }
  _applyPhoto() {
    if (!this._phEl) return;
    const url = this._c.photo || this._areaPicture();
    if (!url || url === this._photoUrl) return;
    this._photoUrl = url;
    this._phEl.style.backgroundImage = `url("${url}")`;
    this._wrapEl.classList.add('hasph');
  }
  _vals() {
    const a = [];
    for (let v = this._c.max; v >= this._c.min - 1e-9; v -= this._c.step) a.push(Math.round(v * 2) / 2);
    return a;
  }
  _fmt(v) {
    const p = v.toFixed(1).split('.');
    return `<span class="n">${p[0]}</span><span class="s"><span class="r"></span>${p[1] !== '0' ? `<span class="d">.${p[1]}</span>` : ''}</span>`;
  }
  _build(st) {
    this._built = true;
    this._list_vals = this._vals();
    const root = this.shadowRoot || this.attachShadow({ mode: 'open' });
    const name = this._c.name || (st && st.attributes.friendly_name) || '';
    root.innerHTML = `
<style>
  :host { display: block; }
  .wrap { position: relative; height: 100vh; height: 100dvh; overflow: hidden; font-family: Inter, sans-serif; color: #fff; -webkit-user-select: none; user-select: none; }
  .bg { position: absolute; inset: 0; transition: background 0.2s linear; }
  .ph { position: absolute; inset: 0; background-repeat: no-repeat; background-size: cover; background-position: center; }
  .wrap.hasph .bg { opacity: 0.55; }
  .hdr { position: absolute; top: 0; left: 0; right: 0; z-index: 3; display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; padding: calc(env(safe-area-inset-top) + 10px) 16px 0; height: 64px; }
  button { all: unset; cursor: pointer; display: flex; align-items: center; justify-content: center; -webkit-tap-highlight-color: transparent; }
  .back { width: 46px; height: 46px; border-radius: 50%; background: rgba(255,255,255,0.22); box-shadow: inset 0 0 0 1.5px rgba(255,255,255,0.45); }
  .title { font-size: 19px; white-space: nowrap; }
  .pill { justify-self: end; display: flex; width: 84px; height: 44px; border-radius: 22px; background: rgba(255,255,255,0.22); box-shadow: inset 0 0 0 1.5px rgba(255,255,255,0.45); }
  .pill button { flex: 1; }
  ha-icon { --mdc-icon-size: 22px; color: #fff; }
  .back ha-icon { --mdc-icon-size: 24px; }
  .list { position: absolute; inset: 0; z-index: 2; overflow-y: scroll; scroll-snap-type: y mandatory; -webkit-overflow-scrolling: touch; scrollbar-width: none; padding: calc(50vh - ${ITEM_H / 2}px) 0; padding: calc(50dvh - ${ITEM_H / 2}px) 0; box-sizing: border-box; }
  .list::-webkit-scrollbar { display: none; }
  .item { height: ${ITEM_H}px; scroll-snap-align: center; display: flex; align-items: center; justify-content: center; font-family: 'DM Serif Display', serif; color: #fff; line-height: 0.8; opacity: 0.12; will-change: opacity, transform; transition: text-shadow 0.15s; }
  .item.sel { text-shadow: 0 2px 22px rgba(255,255,255,0.45), 0 1px 3px rgba(0,0,0,0.12); }
  .item.sel .r { box-shadow: 0 0 10px rgba(255,255,255,0.5); }
  .n { font-size: 86px; letter-spacing: -2px; }
  .s { display: flex; flex-direction: column; justify-content: space-between; height: 64px; margin-left: 4px; align-self: center; }
  .r { display: block; width: 15px; height: 15px; border: 3px solid #fff; border-radius: 50%; box-sizing: border-box; margin-top: -2px; }
  .d { font-size: 36px; }
</style>
<div class="wrap">
  <div class="ph"></div>
  <div class="bg"></div>
  <div class="hdr">
    <button class="back" aria-label="Back"><ha-icon icon="mdi:chevron-left"></ha-icon></button>
    <div class="title"></div>
    <div class="pill"><button class="chart" aria-label="Insights"><ha-icon icon="mdi:chart-box-outline"></ha-icon></button><button class="gear" aria-label="Settings"><ha-icon icon="mdi:cog-outline"></ha-icon></button></div>
  </div>
  <div class="list">${this._list_vals.map((v, i) => `<div class="item" data-i="${i}">${this._fmt(v)}</div>`).join('')}</div>
</div>`;
    root.querySelector('.title').textContent = name;
    this._bg = root.querySelector('.bg');
    this._phEl = root.querySelector('.ph'); this._wrapEl = root.querySelector('.wrap'); this._applyPhoto();
    this._list = root.querySelector('.list');
    this._items = Array.from(root.querySelectorAll('.item'));
    this._list.addEventListener('scroll', () => this._onScroll(), { passive: true });
    this._list.addEventListener('touchstart', () => { this._touching = true; this._userMoved = true; }, { passive: true });
    ['wheel', 'pointerdown', 'keydown'].forEach((ev) => this._list.addEventListener(ev, () => { this._userMoved = true; }, { passive: true }));
    this._list.addEventListener('touchend', () => { this._touching = false; }, { passive: true });
    this._items.forEach((el) => el.addEventListener('click', () => {
      this._userMoved = true;
      this._scrollTo(this._list_vals[parseInt(el.dataset.i, 10)], true);
    }));
    root.querySelector('.back').addEventListener('click', () => this._leave());
    root.querySelector('.chart').addEventListener('click', () => { if (this._c.insights_path) this._navigate(this._c.insights_path); });
    root.querySelector('.gear').addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('hass-more-info', { detail: { entityId: this._c.entity }, bubbles: true, composed: true }));
    });
    const t = st ? parseFloat(st.attributes.temperature) : NaN;
    this._value = isNaN(t) ? 18.5 : t;
    requestAnimationFrame(() => requestAnimationFrame(() => { this._scrollTo(this._value, false); this._paint(); }));
  }
  connectedCallback() {
    this._userMoved = false;
    clearTimeout(this._applyT);
    this._pending = null;
    if (this._built && this._list) requestAnimationFrame(() => {
      const st = this._hass && this._hass.states[this._c.entity];
      const t = st ? parseFloat(st.attributes.temperature) : NaN;
      if (!isNaN(t)) { this._value = t; this._scrollTo(t, false); }
      this._paint();
    });
  }
  _index(v) {
    const i = Math.round((this._c.max - v) / this._c.step);
    return Math.max(0, Math.min(this._list_vals.length - 1, i));
  }
  _scrollTo(v, smooth) {
    if (this._list) this._list.scrollTo({ top: this._index(v) * ITEM_H, behavior: smooth ? 'smooth' : 'auto' });
  }
  _onScroll() {
    if (!this._raf) this._raf = requestAnimationFrame(() => { this._raf = null; this._paint(); });
    clearTimeout(this._endT);
    this._endT = setTimeout(() => this._settle(), 160);
  }
  _paint() {
    if (!this._list) return;
    const f = this._list.scrollTop / ITEM_H;
    const sel = Math.round(f);
    for (let i = 0; i < this._items.length; i++) {
      const el = this._items[i];
      const d = Math.abs(i - f);
      el.classList.toggle('sel', i === sel);
      if (d > 4) { el.style.opacity = '0.1'; el.style.transform = 'scale(0.82)'; continue; }
      el.style.opacity = String(d <= 1 ? 1 - d * 0.72 : Math.max(0.1, 0.28 - (d - 1) * 0.07));
      el.style.transform = `scale(${d <= 1 ? 1.08 - d * 0.2 : Math.max(0.82, 0.88 - (d - 1) * 0.03)})`;
    }
    this._bg.style.background = hiveGradient(this._c.max - f * this._c.step);
  }
  _settle() {
    if (this._touching) { this._endT = setTimeout(() => this._settle(), 160); return; }
    // Safety: ignore scroll positions the browser set by itself (re-render, reconnect, view change)
    if (!this._userMoved) { this._paint(); return; }
    const v = this._list_vals[this._index(this._c.max - (this._list.scrollTop / ITEM_H) * this._c.step)];
    this._value = v;
    const st = this._hass && this._hass.states[this._c.entity];
    const cur = st ? parseFloat(st.attributes.temperature) : NaN;
    clearTimeout(this._applyT);
    if (isNaN(cur) || !st || st.state === 'unavailable' || st.state === 'unknown') { this._pending = null; return; }
    if (v === cur && !(window.__hiveGate && window.__hiveGate.pending[this._c.entity] != null)) { this._pending = null; return; }
    this._pending = v;
    this._applyT = setTimeout(() => this._apply(), 300);
  }
  _apply() {
    if (this._pending == null || !this._hass) return;
    const v = this._pending;
    this._pending = null;
    this._userMoved = false;
    const st = this._hass.states[this._c.entity];
    if (!st || st.state === 'unavailable' || st.state === 'unknown') return;
    if (window.__hiveGate) { window.__hiveGate.set(this._c.entity, v); return; }
    this._hass.callService('climate', 'set_temperature', { entity_id: this._c.entity, temperature: v }).catch((e) => {
      this.dispatchEvent(new CustomEvent('hass-notification', { detail: { message: `Couldn't set ${v}°: ${e && e.message ? e.message : e}` }, bubbles: true, composed: true }));
    });
  }
  _leave() {
    clearTimeout(this._applyT);
    if (this._userMoved || this._pending != null) this._apply();
    if (this._c.back_path) this._navigate(this._c.back_path); else history.back();
  }
  _navigate(path) {
    history.pushState(null, '', path);
    window.dispatchEvent(new CustomEvent('location-changed', { bubbles: true, composed: true }));
  }
}

/* ------------------------------------------------------------------ */
/* custom:hive-schedule-card (light/dark via --hs-* CSS variables)      */
/* ------------------------------------------------------------------ */
const HS_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const HS_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const HS_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const HS_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const HS_OFF = 7;

function hsToMin(s, isEnd) {
  if (!s) return isEnd ? 1440 : 0;
  const p = String(s).split(':');
  const m = parseInt(p[0], 10) * 60 + parseInt(p[1] || '0', 10);
  return (isEnd && m === 0) ? 1440 : m;
}
function hsFromMin(m) {
  m = ((m % 1440) + 1440) % 1440;
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
}
const hsSleep = (ms) => new Promise((r) => setTimeout(r, ms));

class HiveScheduleCard extends HTMLElement {
  static getStubConfig() { return { entity: 'climate.hive_thermostat', title: 'Thermostat' }; }
  setConfig(c) {
    this._c = Object.assign({
      entity: 'climate.hive_thermostat', title: 'Thermostat', tag: 'hive_heating',
      back_path: '/hive-heating/thermostat', edit_path: '/hive-heating/schedule-edit',
      mode_entity: 'input_boolean.hive_ha_schedule', default_temp: 18.5,
    }, c || {});
    this._day = (new Date().getDay() + 6) % 7;
    this._overlay = null;
    this._sig = '';
  }
  getCardSize() { return 12; }
  set hass(h) {
    this._hass = h;
    if (!this._root) this._init();
    const sig = this._signature();
    if (sig !== this._sig) { this._sig = sig; this._renderMain(); }
  }

  // ---------- data ----------
  _schedules() {
    const tag = this._c.tag;
    return Object.keys(this._hass.states).filter((k) => k.startsWith('switch.')).map((k) => this._hass.states[k])
      .filter((s) => Array.isArray(s.attributes.tags) && s.attributes.tags.includes(tag));
  }
  _covers(s, key) {
    const w = s.attributes.weekdays || [];
    return w.includes(key) || w.includes('daily') ||
      (w.includes('workday') && ['mon', 'tue', 'wed', 'thu', 'fri'].includes(key)) ||
      (w.includes('weekend') && (key === 'sat' || key === 'sun'));
  }
  _schedFor(di) {
    const key = HS_DAYS[(di + 7) % 7];
    const all = this._schedules().filter((s) => this._covers(s, key));
    return all.find((s) => (s.attributes.weekdays || []).length === 1) || all[0] || null;
  }
  _periods(di) {
    const s = this._schedFor(di);
    if (!s) return [];
    const ts = s.attributes.timeslots || [];
    const ac = s.attributes.actions || [];
    const out = [];
    ts.forEach((t, i) => {
      const p = String(t).split(' - ');
      const a = ac.length > 1 ? ac[i] : ac[0];
      const d = (a && (a.data || a.service_data)) || {};
      const temp = parseFloat(d.temperature);
      if (d.hvac_mode === 'off' || isNaN(temp) || temp <= HS_OFF) return;
      out.push({ start: hsToMin(p[0], false), end: hsToMin(p[1], true), temp });
    });
    return out.sort((a, b) => a.start - b.start);
  }
  _signature() {
    const parts = this._schedules().map((s) => s.entity_id + JSON.stringify(s.attributes.weekdays) + JSON.stringify(s.attributes.timeslots) + JSON.stringify(s.attributes.actions) + s.state);
    const th = this._hass.states[this._c.entity];
    const md = this._hass.states[this._c.mode_entity];
    return parts.join('|') + (th ? th.state : '') + (md ? md.state : '') + this._day;
  }

  // ---------- saving ----------
  _slot(start, end, temp) {
    return {
      start: hsFromMin(start), stop: hsFromMin(end),
      conditions: [{ entity_id: this._c.mode_entity, value: 'on', match_type: 'is' }],
      condition_type: 'and', track_conditions: true,
      actions: [{ service: 'climate.set_temperature', entity_id: this._c.entity, service_data: { temperature: temp, hvac_mode: 'heat' } }],
    };
  }
  _buildTimeslots(periods) {
    const ps = periods.slice().sort((a, b) => a.start - b.start);
    const out = [];
    let cur = 0;
    ps.forEach((p) => {
      if (p.start > cur) out.push(this._slot(cur, p.start, HS_OFF));
      out.push(this._slot(p.start, p.end, p.temp));
      cur = p.end;
    });
    if (cur < 1440) out.push(this._slot(cur, 1440, HS_OFF));
    if (!out.length) out.push(this._slot(0, 1439, HS_OFF));
    return out;
  }
  async _saveDay(di, periods) {
    const key = HS_DAYS[di];
    const s = this._schedFor(di);
    const timeslots = this._buildTimeslots(periods);
    if (s && (s.attributes.weekdays || []).length === 1 && s.attributes.weekdays[0] === key) {
      await this._hass.callService('scheduler', 'edit', { entity_id: s.entity_id, timeslots });
      return;
    }
    if (s) {
      // shared schedule (e.g. Tue-Fri): take this day out of it, then give the day its own schedule
      let w = (s.attributes.weekdays || []).slice();
      if (w.includes('daily')) w = HS_DAYS.slice();
      if (w.includes('workday')) w = w.filter((x) => x !== 'workday').concat(['mon', 'tue', 'wed', 'thu', 'fri']);
      if (w.includes('weekend')) w = w.filter((x) => x !== 'weekend').concat(['sat', 'sun']);
      w = w.filter((x) => x !== key);
      if (w.length) await this._hass.callService('scheduler', 'edit', { entity_id: s.entity_id, weekdays: w });
      else await this._hass.callService('scheduler', 'remove', { entity_id: s.entity_id });
    }
    await this._hass.callService('scheduler', 'add', { name: `Heating ${HS_NAMES[di]}`, weekdays: [key], repeat_type: 'repeat', tags: [this._c.tag], timeslots });
  }
  _toast(msg) {
    this.dispatchEvent(new CustomEvent('hass-notification', { detail: { message: msg }, bubbles: true, composed: true }));
  }
  _navigate(path) {
    history.pushState(null, '', path);
    window.dispatchEvent(new CustomEvent('location-changed', { bubbles: true, composed: true }));
  }

  // ---------- rendering ----------
  _init() {
    this._root = this.attachShadow({ mode: 'open' });
    this._root.innerHTML = `
<style>
  :host { display: block; color-scheme: var(--hs-scheme, light); }
  * { box-sizing: border-box; }
  .page { position: relative; min-height: 100vh; min-height: 100dvh; background: var(--hs-bg2, #fff); font-family: Inter, sans-serif; color: var(--hs-text, #2F2F33); padding-bottom: 120px; -webkit-user-select: none; user-select: none; }
  button { all: unset; cursor: pointer; -webkit-tap-highlight-color: transparent; }
  .hdr { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; padding: calc(env(safe-area-inset-top) + 10px) 20px 0; height: calc(env(safe-area-inset-top) + 74px); }
  .round { width: 46px; height: 46px; border-radius: 50%; background: var(--hs-card, #fff); box-shadow: 0 2px 8px rgba(0,0,0,0.10), inset 0 0 0 1px var(--hs-line, #ECECF0); display: flex; align-items: center; justify-content: center; }
  .round ha-icon { --mdc-icon-size: 24px; color: var(--hs-text, #2F2F33); }
  .title { font-size: 19px; white-space: nowrap; }
  .right { justify-self: end; }
  .status { padding: 14px 20px 18px; font-size: 15px; }
  .days { background: var(--hs-pill2, #F2F3FB); display: grid; grid-template-columns: repeat(7, 1fr); padding: 12px 8px; }
  .day { width: 40px; height: 40px; border-radius: 50%; margin: 0 auto; display: flex; align-items: center; justify-content: center; font-size: 18px; }
  .day.sel { background: #4350E6; color: #fff; }
  .day.today:not(.sel) { box-shadow: inset 0 0 0 1.5px #4350E6; color: #4350E6; }
  .list { padding: 16px 22px; }
  .row { display: flex; align-items: center; gap: 26px; padding: 12px 0; width: 100%; }
  .circ { width: 56px; height: 56px; flex: none; border-radius: 50%; border: 3px solid #7B80EA; display: flex; align-items: center; justify-content: center; font-size: 17px; }
  .circ.on { border-color: #E8642E; font-size: 15px; }
  .time { font-size: 19px; }
  .empty { padding: 30px 4px; color: var(--hs-sub, #66666B); font-size: 16px; line-height: 1.5; }
  .fab { position: fixed; right: 22px; bottom: calc(env(safe-area-inset-bottom) + 34px); width: 56px; height: 56px; border-radius: 50%; background: #4350E6; box-shadow: 0 0 0 6px var(--hs-ring, #E5E7FB); display: flex; align-items: center; justify-content: center; z-index: 5; }
  .fab ha-icon { --mdc-icon-size: 26px; color: #fff; }
  .ov { position: fixed; inset: 0; z-index: 20; background: var(--hs-bg2, #fff); display: flex; flex-direction: column; font-family: Inter, sans-serif; color: var(--hs-text, #2F2F33); }
  .ov .body { padding: 8px 20px; flex: 1; overflow-y: auto; }
  .box { border-radius: 18px; background: var(--hs-card, #fff); box-shadow: 0 1px 10px rgba(40,40,80,0.08); overflow: hidden; }
  .field { display: flex; align-items: center; justify-content: space-between; padding: 0 18px; height: 64px; font-size: 18px; }
  .sep { height: 2px; background: var(--hs-line, #F0F0F3); }
  .field input, .field select { -webkit-appearance: none; appearance: none; border: none; background: transparent; color: #4350E6; font: inherit; font-size: 18px; text-align: right; direction: rtl; min-width: 90px; outline: none; }
  .field input::-webkit-date-and-time-value { text-align: right; }
  .err { color: #D9342B; font-size: 14px; padding: 12px 4px; min-height: 20px; }
  .done { margin: 0 24px calc(env(safe-area-inset-bottom) + 24px); height: 54px; border-radius: 14px; background: var(--hs-line, #F6F6F8); color: var(--hs-sub, #A0A0A6); display: flex; align-items: center; justify-content: center; font-size: 19px; }
  .done.ready { background: #4350E6; color: #fff; }
  .sheetbg { position: fixed; inset: 0; z-index: 15; background: rgba(0,0,0,0.25); }
  .sheet { position: fixed; left: 12px; right: 12px; bottom: calc(env(safe-area-inset-bottom) + 12px); z-index: 16; background: var(--hs-card, #fff); border-radius: 20px; overflow: hidden; font-family: Inter, sans-serif; }
  .opt { display: flex; align-items: center; gap: 14px; padding: 18px 20px; font-size: 17px; color: var(--hs-text, #2F2F33); border-bottom: 1px solid var(--hs-line, #F0F0F3); width: 100%; }
  .opt ha-icon { --mdc-icon-size: 22px; color: #4350E6; }
  .opt.cancel { justify-content: center; color: var(--hs-sub, #66666B); border-bottom: none; }
  .chk { display: flex; align-items: center; justify-content: space-between; padding: 0 18px; height: 56px; font-size: 18px; width: 100%; }
  .tick { width: 26px; height: 26px; border-radius: 50%; border: 2px solid var(--hs-sub, #C9CAD6); display: flex; align-items: center; justify-content: center; }
  .tick.on { background: #4350E6; border-color: #4350E6; }
  .tick ha-icon { --mdc-icon-size: 18px; color: #fff; }
</style>
<div class="page">
  <div class="hdr"><button class="round back"><ha-icon icon="mdi:chevron-left"></ha-icon></button><div class="title"></div><div></div></div>
  <div class="status"></div>
  <div class="days"></div>
  <div class="list"></div>
  <button class="fab"><ha-icon icon="mdi:dots-horizontal"></ha-icon></button>
</div>
<div class="layer"></div>`;
    this._root.querySelector('.title').textContent = this._c.title;
    this._root.querySelector('.back').addEventListener('click', () => this._navigate(this._c.back_path));
    this._root.querySelector('.fab').addEventListener('click', () => this._openMenu());
    this._layer = this._root.querySelector('.layer');
  }

  _rows(di) {
    const ps = this._periods(di);
    if (!ps.length) return [];
    const next = this._periods(di + 1);
    const rows = [];
    ps.forEach((p, i) => {
      rows.push({ on: true, idx: i, start: p.start, end: p.end, temp: p.temp, label: `${hsFromMin(p.start)} - ${p.end === 1440 ? '00:00' : hsFromMin(p.end)}` });
      const nxt = ps[i + 1];
      if (nxt) {
        if (nxt.start > p.end) rows.push({ on: false, start: p.end, end: nxt.start, label: `${hsFromMin(p.end)} - ${hsFromMin(nxt.start)}` });
      } else if (p.end < 1440) {
        const nd = (di + 1) % 7;
        const ne = next.length ? next[0].start : 0;
        const lbl = next.length ? `${hsFromMin(ne)} (${HS_SHORT[nd]})` : '00:00';
        rows.push({ on: false, start: p.end, end: 1440, label: `${hsFromMin(p.end)} - ${lbl}` });
      }
    });
    return rows;
  }

  _renderMain() {
    if (!this._root) return;
    const th = this._hass.states[this._c.entity];
    const md = this._hass.states[this._c.mode_entity];
    let status = 'Manual mode – schedule paused';
    if (md && md.state === 'on' && th && th.state === 'heat') status = 'Heating schedule is active';
    else if (th && th.state === 'off') status = 'Heating is off – schedule paused';
    else if (th && th.state === 'auto') status = 'Hive is running its own schedule';
    this._root.querySelector('.status').textContent = status;
    const today = (new Date().getDay() + 6) % 7;
    const days = this._root.querySelector('.days');
    days.innerHTML = HS_LETTERS.map((l, i) => `<button class="day${i === this._day ? ' sel' : ''}${i === today ? ' today' : ''}" data-d="${i}">${l}</button>`).join('');
    days.querySelectorAll('.day').forEach((b) => b.addEventListener('click', () => { this._day = parseInt(b.dataset.d, 10); this._sig = ''; this._renderMain(); }));
    const rows = this._rows(this._day);
    const list = this._root.querySelector('.list');
    if (!rows.length) {
      list.innerHTML = `<div class="empty">No heating on ${HS_NAMES[this._day]}.<br>Tap <b>•••</b> to add a heating period.</div>`;
      return;
    }
    list.innerHTML = rows.map((r, i) => `<button class="row" data-r="${i}"><div class="circ${r.on ? ' on' : ''}">${r.on ? r.temp.toFixed(1) + '°' : 'Off'}</div><div class="time">${r.label}</div></button>`).join('');
    list.querySelectorAll('.row').forEach((b) => b.addEventListener('click', () => {
      const r = rows[parseInt(b.dataset.r, 10)];
      if (r.on) this._openEditor(this._day, r.idx);
      else {
        const s = r.start, e = Math.min(r.end, s + 120);
        this._openEditor(this._day, -1, { start: s, end: e, temp: this._c.default_temp });
      }
    }));
  }

  _closeLayer() { this._layer.innerHTML = ''; this._sig = ''; this._renderMain(); }

  _tempOptions(sel) {
    let o = '';
    for (let t = 5; t <= 30.001; t += 0.5) {
      const v = (Math.round(t * 2) / 2).toFixed(1);
      o += `<option value="${v}"${Math.abs(parseFloat(v) - sel) < 0.01 ? ' selected' : ''}>${v}°</option>`;
    }
    return o;
  }

  _openEditor(di, idx, preset) {
    const periods = this._periods(di);
    const isNew = idx < 0;
    const p = isNew ? preset : periods[idx];
    const orig = { start: p.start, end: p.end, temp: p.temp };
    this._layer.innerHTML = `
<div class="ov">
  <div class="hdr"><button class="round x-back"><ha-icon icon="mdi:chevron-left"></ha-icon></button><div class="title">${HS_NAMES[di]}</div>${isNew ? '<div></div>' : '<button class="round right x-del"><ha-icon icon="mdi:trash-can-outline"></ha-icon></button>'}</div>
  <div class="body">
    <div class="box">
      <label class="field"><span>Start Time</span><input class="x-start" type="time" step="60" value="${hsFromMin(p.start)}"></label>
      <label class="field"><span>End Time</span><input class="x-end" type="time" step="60" value="${hsFromMin(p.end)}"></label>
      <div class="sep"></div>
      <label class="field"><span>Temperature</span><select class="x-temp">${this._tempOptions(p.temp)}</select></label>
    </div>
    <div class="err"></div>
  </div>
  <button class="done${isNew ? ' ready' : ''}">${isNew ? 'Add' : 'Done'}</button>
</div>`;
    const q = (s) => this._layer.querySelector(s);
    const read = () => ({ start: hsToMin(q('.x-start').value, false), end: hsToMin(q('.x-end').value, true), temp: parseFloat(q('.x-temp').value) });
    const changed = () => { const v = read(); return isNew || v.start !== orig.start || v.end !== orig.end || v.temp !== orig.temp; };
    const upd = () => q('.done').classList.toggle('ready', changed());
    ['.x-start', '.x-end', '.x-temp'].forEach((s) => { q(s).addEventListener('input', upd); q(s).addEventListener('change', upd); });
    q('.x-back').addEventListener('click', () => this._closeLayer());
    if (!isNew) q('.x-del').addEventListener('click', async () => {
      const rest = periods.filter((_, i) => i !== idx);
      try { await this._saveDay(di, rest); this._closeLayer(); } catch (e) { q('.err').textContent = `Couldn't save: ${e.message || e}`; }
    });
    q('.done').addEventListener('click', async () => {
      if (!changed()) { this._closeLayer(); return; }
      const v = read();
      if (!(v.end > v.start)) { q('.err').textContent = 'End time must be after the start time.'; return; }
      const others = periods.filter((_, i) => i !== idx);
      const clash = others.find((o) => v.start < o.end && v.end > o.start);
      if (clash) { q('.err').textContent = `Overlaps ${hsFromMin(clash.start)} - ${clash.end === 1440 ? '00:00' : hsFromMin(clash.end)}. Change the times or delete that period first.`; return; }
      q('.done').textContent = 'Saving…';
      try { await this._saveDay(di, others.concat([v])); this._closeLayer(); }
      catch (e) { q('.done').textContent = isNew ? 'Add' : 'Done'; q('.err').textContent = `Couldn't save: ${e.message || e}`; }
    });
  }

  _openMenu() {
    const di = this._day;
    this._layer.innerHTML = `
<div class="sheetbg"></div>
<div class="sheet">
  <button class="opt o-add"><ha-icon icon="mdi:plus-circle-outline"></ha-icon>Add heating period</button>
  <button class="opt o-copy"><ha-icon icon="mdi:content-copy"></ha-icon>Copy ${HS_NAMES[di]} to other days</button>
  <button class="opt o-adv"><ha-icon icon="mdi:tune-variant"></ha-icon>Advanced editor</button>
  <button class="opt cancel o-cancel">Cancel</button>
</div>`;
    const q = (s) => this._layer.querySelector(s);
    q('.sheetbg').addEventListener('click', () => this._closeLayer());
    q('.o-cancel').addEventListener('click', () => this._closeLayer());
    q('.o-adv').addEventListener('click', () => { this._layer.innerHTML = ''; this._navigate(this._c.edit_path); });
    q('.o-add').addEventListener('click', () => {
      const ps = this._periods(di);
      let s = 18 * 60;
      for (let c = 6 * 60; c < 22 * 60; c += 30) { if (!ps.find((p) => c < p.end && c + 60 > p.start)) { s = c; break; } }
      this._openEditor(di, -1, { start: s, end: Math.min(s + 120, 1440), temp: this._c.default_temp });
    });
    q('.o-copy').addEventListener('click', () => this._openCopy(di));
  }

  _openCopy(di) {
    const sel = new Set();
    const draw = () => {
      this._layer.innerHTML = `
<div class="ov">
  <div class="hdr"><button class="round x-back"><ha-icon icon="mdi:chevron-left"></ha-icon></button><div class="title">Copy ${HS_NAMES[di]}</div><div></div></div>
  <div class="body"><div class="box">${HS_NAMES.map((n, i) => i === di ? '' : `<button class="chk" data-d="${i}"><span>${n}</span><span class="tick${sel.has(i) ? ' on' : ''}">${sel.has(i) ? '<ha-icon icon="mdi:check"></ha-icon>' : ''}</span></button>`).join('<div class="sep"></div>').replace(/^<div class="sep"><\/div>|<div class="sep"><\/div>(?=<div class="sep">)/g, '')}</div><div class="err"></div></div>
  <button class="done${sel.size ? ' ready' : ''}">Copy to ${sel.size} day${sel.size === 1 ? '' : 's'}</button>
</div>`;
      const q = (s) => this._layer.querySelector(s);
      q('.x-back').addEventListener('click', () => this._closeLayer());
      this._layer.querySelectorAll('.chk').forEach((b) => b.addEventListener('click', () => { const d = parseInt(b.dataset.d, 10); if (sel.has(d)) sel.delete(d); else sel.add(d); draw(); }));
      q('.done').addEventListener('click', async () => {
        if (!sel.size) return;
        const src = this._periods(di);
        q('.done').textContent = 'Copying…';
        try {
          for (const d of Array.from(sel).sort()) {
            await this._saveDay(d, src);
            await hsSleep(900);
          }
          this._closeLayer();
        } catch (e) { q('.err').textContent = `Couldn't copy: ${e.message || e}`; }
      });
    };
    draw();
  }
}

if (!customElements.get('hive-temp-picker')) customElements.define('hive-temp-picker', HiveTempPicker);
if (!customElements.get('hive-schedule-card')) customElements.define('hive-schedule-card', HiveScheduleCard);
window.customCards = window.customCards || [];
window.customCards.push(
  { type: 'hive-temp-picker', name: 'Hive-style temperature picker', description: 'Hold-to-scroll temperature wheel; the background follows the temperature.', documentationURL: 'https://github.com/xtrendmaster/hive-style-thermostat-cards' },
  { type: 'hive-schedule-card', name: 'Hive-style heating schedule', description: 'Per-day heating schedule viewer and editor for the Scheduler component.', documentationURL: 'https://github.com/xtrendmaster/hive-style-thermostat-cards' },
);
