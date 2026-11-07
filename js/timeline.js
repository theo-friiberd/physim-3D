// ============================================================================
// timeline.js: bottom timeline (ruler, playhead, frame counter, perf readouts)
// ============================================================================
import { state, FIXED_DT } from './physics.js';
import { nf } from './ui.js';

const $ = (id) => document.getElementById(id);
let ctx = null;
let endHandled = false;
let statTimer = 0;
let frames = 0;
let accum = 0;

const NICE = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

function buildRuler() {
  const end = nf('end').get();
  const step = NICE.find((s) => end / s <= 40) || 10000;
  const major = step * (step === 1 ? 10 : 2);
  let html = '';
  for (let f = 0; f <= end; f += step) {
    const left = (f / end) * 100;
    const isMajor = f % major === 0;
    html += `<i class="tick${isMajor ? ' major' : ''}" style="left:${left}%"></i>`;
    if (isMajor) html += `<span class="tlabel" style="left:${left}%">${f}</span>`;
  }
  $('ruler').querySelectorAll('.tick, .tlabel').forEach((n) => n.remove());
  $('ruler').insertAdjacentHTML('afterbegin', html);
}

export function initTimeline(context) {
  ctx = context;
  nf('end').on(() => { endHandled = false; buildRuler(); });
  buildRuler();
}

/** Call once per rendered frame with the real elapsed time in seconds. */
export function updateTimeline(dt) {
  const end = nf('end').get();
  const f = state.frame;
  $('tl-frame').textContent = String(f);
  $('tl-time').textContent = `${(f * FIXED_DT).toFixed(2)} s`;
  $('playhead').style.left = `${Math.min(1, f / end) * 100}%`;

  // end-of-range behaviour
  if (f < end) endHandled = false;
  else if (!endHandled && state.running) {
    endHandled = true;
    const mode = $('tl-endmode').value;
    if (mode === 'loop') { ctx.reset(); ctx.setRunning(true); }
    else if (mode === 'pause') ctx.setRunning(false);
  }

  // perf readouts ~4x per second
  frames++;
  accum += dt;
  statTimer += dt;
  if (statTimer >= 0.25) {
    $('tl-fps').textContent = String(Math.round(frames / accum));
    $('tl-step').textContent = `${state.stepMs.toFixed(2)} ms`;
    const particles = state.cloths.reduce((n, c) => n + c.particles.length, 0);
    $('tl-bodies').textContent = String(state.entities.length + particles);
    $('tl-contacts').textContent = String(state.contacts);
    frames = 0; accum = 0; statTimer = 0;
  }
}
