// ============================================================================
// outliner.js: tree view of everything in the scene (Blender-style Outliner)
// ============================================================================
import { state, on } from './physics.js';

const GROUPS = [
  { key: 'entities', title: 'Rigid Bodies', icon: 'body' },
  { key: 'constraints', title: 'Constraints', icon: 'constraint' },
  { key: 'fields', title: 'Force Fields', icon: 'field' },
  { key: 'cloths', title: 'Cloth', icon: 'cloth' },
];

const collapsed = new Set();
let ctx = null;
let root = null;
let scheduled = false;

export function setItemVisible(item, visible) {
  item.visible = visible;
  if (item.setVisible) item.setVisible(visible);
  else item.root.visible = visible;
}

export function initOutliner(context) {
  ctx = context;
  root = document.getElementById('outliner');

  root.addEventListener('click', (ev) => {
    const eye = ev.target.closest('.oeye');
    const row = ev.target.closest('.orow');
    const head = ev.target.closest('.ogroup');
    if (eye && row) {
      const item = find(row.dataset.id);
      if (item) { setItemVisible(item, item.visible === false); render(); }
      return;
    }
    if (row) {
      const item = find(row.dataset.id);
      if (item) ctx.select(item);
    } else if (head) {
      const key = head.dataset.group;
      if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key);
      render();
    }
  });

  root.addEventListener('dblclick', (ev) => {
    const name = ev.target.closest('.oname');
    const row = ev.target.closest('.orow');
    if (!name || !row) return;
    const item = find(row.dataset.id);
    if (!item) return;
    const input = document.createElement('input');
    input.className = 'text orename';
    input.value = item.name;
    input.maxLength = 40;
    name.replaceWith(input);
    input.focus(); input.select();
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      if (commit && input.value.trim()) { item.name = input.value.trim(); if (item.root) item.root.name = item.name; ctx.refreshInspector?.(true); }
      render();
    };
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); });
    input.addEventListener('blur', () => finish(true));
  });

  on('scene', schedule);
  render();
}

function find(id) {
  const n = Number(id);
  for (const g of GROUPS) {
    const hit = state[g.key].find((i) => i.id === n);
    if (hit) return hit;
  }
  return null;
}

/** Re-render on the next animation frame (many scene events can fire in one tick). */
export function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => { scheduled = false; render(); });
}

export function render() {
  if (!root) return;
  const sel = ctx.selected;
  let total = 0;
  const frag = document.createDocumentFragment();

  const top = document.createElement('div');
  top.className = 'otop';
  top.innerHTML = '<span class="oarrow open"></span><span class="oicon scene"></span><span class="oname">Scene Collection</span>';
  frag.appendChild(top);

  for (const g of GROUPS) {
    const items = state[g.key];
    total += items.length;
    if (!items.length) continue;
    const isClosed = collapsed.has(g.key);

    const head = document.createElement('div');
    head.className = 'ogroup';
    head.dataset.group = g.key;
    head.innerHTML = `<span class="oarrow ${isClosed ? '' : 'open'}"></span><span class="oicon ${g.icon}"></span><span class="oname">${g.title}</span><span class="ocount">${items.length}</span>`;
    frag.appendChild(head);

    if (isClosed) continue;
    for (const item of items) {
      const row = document.createElement('div');
      row.className = `orow${item === sel ? ' sel' : ''}${item.visible === false ? ' off' : ''}`;
      row.dataset.id = item.id;
      row.setAttribute('role', 'treeitem');
      const hidden = item.visible === false;
      row.innerHTML = `<span class="oicon ${item.category === 'body' ? (item.isStatic ? 'passive' : 'body') : item.category} k-${item.kind}"></span><span class="oname"></span>` +
        `<button class="oeye" title="${hidden ? 'Show' : 'Hide'} in viewport" aria-label="Toggle visibility">${hidden ? '◌' : '●'}</button>`;
      row.querySelector('.oname').textContent = item.name;
      frag.appendChild(row);
    }
  }

  root.replaceChildren(frag);
  document.getElementById('outliner-count').textContent = total ? `${total} item${total === 1 ? '' : 's'}` : '';
}

/** Cheap selection refresh (no full rebuild). */
export function highlight() {
  if (!root) return;
  const sel = ctx.selected;
  root.querySelectorAll('.orow').forEach((r) => r.classList.toggle('sel', !!sel && Number(r.dataset.id) === sel.id));
  const row = sel && root.querySelector(`.orow[data-id="${sel.id}"]`);
  if (row) row.scrollIntoView({ block: 'nearest' });
}
