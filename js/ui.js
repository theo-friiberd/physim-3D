// ============================================================================
// ui.js: Blender-style widgets: drag-to-edit number fields, menus, tabs, toasts
// ============================================================================

const $ = (id) => document.getElementById(id);

// ----------------------------------------------------------------------------
// Number fields: drag sideways to change the value, click to type,
// click the end arrows to nudge. Shift = fine (x0.1), Ctrl = coarse (x10).
// Markup: <div class="nf [slider]" id="nf-x" data-label data-min data-max data-step data-prec data-unit data-value>
// ----------------------------------------------------------------------------
const registry = new Map();

const roundTo = (v, prec) => {
  const k = 10 ** prec;
  return Math.round(v * k) / k;
};

export class NumberField {
  constructor(el) {
    this.el = el;
    const d = el.dataset;
    this.min = d.min !== undefined ? parseFloat(d.min) : -Infinity;
    this.max = d.max !== undefined ? parseFloat(d.max) : Infinity;
    this.step = parseFloat(d.step) || 1;
    this.prec = d.prec !== undefined ? parseInt(d.prec, 10) : 2;
    this.unit = d.unit || '';
    this.label = d.label || '';
    this.slider = el.classList.contains('slider') && isFinite(this.min) && isFinite(this.max);
    this.value = d.value !== undefined ? parseFloat(d.value) : 0;
    this.listeners = [];
    this.editing = false;
    this.drag = null;
    this.disabled = false;

    el.innerHTML = '<div class="nf-fill"></div><span class="nf-arrow l">‹</span><span class="nf-label"></span><span class="nf-val"></span><span class="nf-arrow r">›</span>';
    this.fill = el.querySelector('.nf-fill');
    this.labelEl = el.querySelector('.nf-label');
    this.valEl = el.querySelector('.nf-val');
    el.tabIndex = 0;
    el.setAttribute('role', 'spinbutton');
    el.setAttribute('aria-label', this.label);

    el.addEventListener('pointerdown', (ev) => this.onDown(ev));
    el.addEventListener('pointermove', (ev) => this.onMove(ev));
    el.addEventListener('pointerup', (ev) => this.onUp(ev));
    el.addEventListener('pointercancel', () => this.endDrag());
    el.addEventListener('keydown', (ev) => {
      if (this.editing || this.disabled) return;
      if (ev.key === 'ArrowLeft' || ev.key === 'ArrowDown') { this.set(this.value - this.step * (ev.shiftKey ? 0.1 : 1)); ev.preventDefault(); }
      else if (ev.key === 'ArrowRight' || ev.key === 'ArrowUp') { this.set(this.value + this.step * (ev.shiftKey ? 0.1 : 1)); ev.preventDefault(); }
      else if (ev.key === 'Enter') { this.beginEdit(); ev.preventDefault(); }
    });
    this.render();
  }

  get() { return this.value; }
  on(fn) { this.listeners.push(fn); return this; }
  setDisabled(flag) { this.disabled = flag; this.el.classList.toggle('disabled', flag); }
  show(flag) { this.el.hidden = !flag; }

  /** Set the value. `silent` updates the display without notifying listeners. */
  set(v, silent = false) {
    if (!Number.isFinite(v)) return;
    v = roundTo(Math.min(this.max, Math.max(this.min, v)), this.prec);
    if (silent && this.editing) return;
    const changed = v !== this.value;
    this.value = v;
    this.render();
    if (!silent && changed) for (const fn of this.listeners) fn(v);
  }

  render() {
    this.labelEl.textContent = this.label;
    this.valEl.textContent = `${this.value.toFixed(this.prec)}${this.unit}`;
    if (this.slider) {
      const f = (this.value - this.min) / (this.max - this.min);
      this.fill.style.width = `${Math.min(1, Math.max(0, f)) * 100}%`;
    }
    this.el.setAttribute('aria-valuenow', String(this.value));
  }

  onDown(ev) {
    if (ev.button !== 0 || this.disabled || this.editing) return;
    ev.preventDefault();
    this.el.focus({ preventScroll: true });
    this.el.setPointerCapture(ev.pointerId);
    const rect = this.el.getBoundingClientRect();
    this.drag = { x: ev.clientX, start: this.value, moved: false, rect, lx: ev.clientX - rect.left };
  }

  onMove(ev) {
    const d = this.drag;
    if (!d) return;
    const dx = ev.clientX - d.x;
    if (!d.moved && Math.abs(dx) < 3) return;
    d.moved = true;
    this.el.classList.add('dragging');
    const fine = ev.shiftKey ? 0.1 : ev.ctrlKey ? 10 : 1;
    const v = this.slider
      ? d.start + (dx / d.rect.width) * (this.max - this.min) * (ev.shiftKey ? 0.1 : 1)
      : d.start + dx * this.step * 0.25 * fine;
    this.set(v);
  }

  onUp(ev) {
    const d = this.drag;
    if (!d) return;
    if (this.el.hasPointerCapture(ev.pointerId)) this.el.releasePointerCapture(ev.pointerId);
    this.endDrag();
    if (d.moved) return;
    if (d.lx < 18) this.set(this.value - this.step);
    else if (d.lx > d.rect.width - 18) this.set(this.value + this.step);
    else this.beginEdit();
  }

  endDrag() {
    this.drag = null;
    this.el.classList.remove('dragging');
  }

  beginEdit() {
    if (this.editing || this.disabled) return;
    this.editing = true;
    this.el.classList.add('editing');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'nf-edit';
    input.value = this.value.toFixed(this.prec);
    input.setAttribute('aria-label', this.label);
    this.el.appendChild(input);
    input.focus();
    input.select();

    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      const text = input.value.trim().replace(',', '.');
      this.editing = false;
      this.el.classList.remove('editing');
      input.remove();
      if (commit && text !== '') {
        const v = Number(text);
        if (Number.isFinite(v)) this.set(v);
      }
      this.render();
    };
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') finish(true);
      else if (ev.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('pointerdown', (ev) => ev.stopPropagation());
  }
}

export function initNumberFields() {
  document.querySelectorAll('.nf').forEach((el) => registry.set(el.id, new NumberField(el)));
}

/** Look up a number field by the part of its id after "nf-". */
export function nf(name) {
  const f = registry.get(`nf-${name}`);
  if (!f) throw new Error(`Unknown number field: ${name}`);
  return f;
}

// ----------------------------------------------------------------------------
// Header menus (click to open, hover to switch, nested submenus)
// ----------------------------------------------------------------------------
export function initMenus() {
  const menus = [...document.querySelectorAll('.menu')];
  let open = null;

  const close = () => { if (open) open.classList.remove('open'); open = null; };
  const openMenu = (m) => { if (open === m) return; close(); m.classList.add('open'); open = m; };

  for (const m of menus) {
    const btn = m.querySelector('.menu-btn');
    btn.addEventListener('click', () => (open === m ? close() : openMenu(m)));
    btn.addEventListener('pointerenter', () => { if (open && open !== m) openMenu(m); });
    m.querySelector('.dropdown').addEventListener('click', (ev) => {
      const b = ev.target.closest('button');
      if (b && !b.classList.contains('has-sub')) close();
    });
  }
  document.addEventListener('pointerdown', (ev) => { if (open && !ev.target.closest('.menu')) close(); });
  window.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') close(); });
  window.addEventListener('blur', close);
}

// ----------------------------------------------------------------------------
// Properties tabs
// ----------------------------------------------------------------------------
const PTABS = ['scene', 'physics', 'object'];
let currentTab = 'object';
const tabListeners = [];

export function showPropsTab(name) {
  if (!PTABS.includes(name)) return;
  currentTab = name;
  document.querySelectorAll('.ptab').forEach((b) => {
    const on = b.dataset.ptab === name;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  });
  for (const t of PTABS) $(`ptab-${t}`).hidden = t !== name;
  for (const fn of tabListeners) fn(name);
}
export function currentPropsTab() { return currentTab; }
export function onPropsTab(fn) { tabListeners.push(fn); }

export function initTabs() {
  document.querySelectorAll('.ptab').forEach((b) => b.addEventListener('click', () => showPropsTab(b.dataset.ptab)));
  showPropsTab('object');
}

// ----------------------------------------------------------------------------
// Toasts + loading indicator
// ----------------------------------------------------------------------------
export function toast(message, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  $('toasts').appendChild(el);
  const life = type === 'error' ? 6500 : 3800;
  setTimeout(() => el.classList.add('out'), life);
  setTimeout(() => el.remove(), life + 350);
}

export function loading(on, text = 'Loading…') {
  $('loading').hidden = !on;
  $('loading-text').textContent = text;
}
