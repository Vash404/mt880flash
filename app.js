'use strict';

const STORE_KEY = 'flashcontatore.v1';
const DEVICE_KEY = 'flashcontatore.deviceId';

const TYPES = {
  short:    { label: 'Flash corto',   unit: '×' },
  long:     { label: 'Flash lungo',   unit: '×' },
  extended: { label: 'Flash esteso',  unit: '×' },
  pause:    { label: 'Pausa',         unit: 's' },
};

const DEFAULT_STATE = {
  timings: { short: 400, long: 3000, extended: 6000, gap: 600, countdown: 3 },
  source: 'torch',
  activeId: 'seq-180',
  sequences: [{
    id: 'seq-180',
    name: '1.8.0 – Energia attiva',
    steps: [
      { type: 'long',  n: 1,  label: 'Sveglia contatore' },
      { type: 'pause', n: 1,  label: 'Attesa risveglio' },
      { type: 'short', n: 1,  label: 'Vai su Data' },
      { type: 'long',  n: 1,  label: 'Entra nel menu Data' },
      { type: 'short', n: 22, label: 'Scorri fino a 1.8.0' },
    ],
  }],
};

// --- stato / salvataggio ---

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (Array.isArray(s.sequences) && s.sequences.length) {
        return { ...structuredClone(DEFAULT_STATE), ...s, timings: { ...DEFAULT_STATE.timings, ...s.timings } };
      }
    }
  } catch { /* se il localStorage è rotto riparto dai default, pazienza */ }
  return structuredClone(DEFAULT_STATE);
}

let state = loadState();

function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { }
}

function activeSeq() {
  return state.sequences.find(s => s.id === state.activeId) || state.sequences[0];
}

function newId() {
  return 'seq-' + Math.random().toString(36).slice(2, 9);
}

// --- utility ---

const $ = sel => document.querySelector(sel);

// sleep che si può interrompere col tasto STOP (prima non si fermava più, che palle)
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    function onAbort() { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function fmtTime(ms) {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

// trasforma i passi in una lista di flash singoli con i tempi, così il ciclo è semplice
function expand(seq) {
  const t = state.timings;
  const plan = [];
  seq.steps.forEach((step, stepIndex) => {
    if (step.type === 'pause') {
      plan.push({ stepIndex, i: 1, n: 1, on: 0, off: Math.max(0, step.n) * 1000 });
      return;
    }
    const n = Math.max(0, Math.floor(step.n));
    for (let i = 1; i <= n; i++) {
      plan.push({ stepIndex, i, n, on: t[step.type], off: t.gap });
    }
  });
  return plan;
}

function totalMs(plan) {
  return plan.reduce((a, p) => a + p.on + p.off, 0);
}

// --- flash / schermo ---

const Torch = {
  stream: null,
  track: null,

  async open() {
    if (this.track) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Fotocamera non accessibile: apri il sito in HTTPS con Chrome.');
    }
    let saved = null;
    try { saved = localStorage.getItem(DEVICE_KEY); } catch { }

    const attempts = [];
    if (saved) attempts.push({ deviceId: { exact: saved } });
    attempts.push({ facingMode: { ideal: 'environment' } });
    for (const video of attempts) {
      if (await this._try(video)) return;
    }
    // non va con la fotocamera di default su certi telefoni con 3-4 fotocamere dietro,
    // il flash è attaccato solo a una... quindi le provo tutte finché ne trovo una. ora funziona
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
    for (const d of devices) {
      if (d.deviceId && await this._try({ deviceId: { exact: d.deviceId } })) return;
    }
    throw new Error('Nessuna fotocamera con flash controllabile dal browser.');
  },

  async _try(video) {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    } catch (e) {
      if (e.name === 'NotAllowedError') throw new Error('Permesso fotocamera negato.');
      return false;
    }
    const track = stream.getVideoTracks()[0];
    let caps = track.getCapabilities?.() || {};
    if (!caps.torch) {
      // a volte torch non c'è subito, bisogna aspettare un attimo. mah
      await sleep(400);
      caps = track.getCapabilities?.() || {};
    }
    if (!caps.torch) {
      stream.getTracks().forEach(t => t.stop());
      return false;
    }
    this.stream = stream;
    this.track = track;
    // mi salvo quale fotocamera ha funzionato così la prossima volta è più veloce
    try { localStorage.setItem(DEVICE_KEY, track.getSettings().deviceId || ''); } catch { }
    // senza attaccare lo stream a un <video> il flash non si accendeva. porca miseria mezz'ora persa qui
    const preview = $('#preview');
    preview.srcObject = stream;
    preview.play().catch(() => {});
    return true;
  },

  async set(on) {
    // ci mette un po' ad accendersi (tipo 100ms), per questo il buio tra i flash non va messo troppo basso
    await this.track.applyConstraints({ advanced: [{ torch: on }] });
  },

  close() {
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = this.track = null;
    $('#preview').srcObject = null;
  },
};

const Screen = {
  async open() { $('#screenFlash').hidden = false; },
  async set(on) { $('#screenFlash').classList.toggle('on', on); },
  close() {
    $('#screenFlash').classList.remove('on');
    $('#screenFlash').hidden = true;
  },
};

function lightSource() {
  return state.source === 'screen' ? Screen : Torch;
}

// --- esecuzione sequenza ---

let runCtl = null;

async function withLight(fn) {
  const light = lightSource();
  const ctl = new AbortController();
  runCtl = ctl;
  let wakeLock = null;
  setRunning(true);
  try {
    // se lo schermo si spegne a metà sequenza si ferma tutto, quindi lo tengo acceso
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { }
    setStatus('Accendo la fotocamera…', '', 0);
    await light.open();
    await light.set(false);
    await fn(light, ctl.signal);
    navigator.vibrate?.([80, 60, 80]);
  } catch (e) {
    if (e.name === 'AbortError') setStatus('Interrotto', '', null);
    else setStatus('Errore', e.message || String(e), null);
    return;
  } finally {
    // IMPORTANTE: spegnere sempre, una volta con STOP mi è rimasto il flash acceso fisso, mannaggia
    try { await light.set(false); } catch { }
    light.close();
    wakeLock?.release().catch(() => {});
    runCtl = null;
    setRunning(false);
    highlightStep(-1);
  }
}

async function pulse(light, on, off, signal) {
  if (on > 0) {
    await light.set(true);
    await sleep(on, signal);
    await light.set(false);
  }
  await sleep(off, signal);
}

function runSequence() {
  const seq = activeSeq();
  const plan = expand(seq);
  if (!plan.length) return setStatus('Sequenza vuota', 'Aggiungi almeno un passo.', null);
  const total = totalMs(plan);

  withLight(async (light, signal) => {
    for (let c = state.timings.countdown; c > 0; c--) {
      setStatus(`Punta il flash sul sensore… ${c}`, 'Tieni fermo il telefono', 0);
      await sleep(1000, signal);
    }
    let elapsed = 0;
    for (const p of plan) {
      const step = seq.steps[p.stepIndex];
      highlightStep(p.stepIndex);
      const what = step.label || TYPES[step.type].label;
      const count = step.type === 'pause' ? '' : ` — ${p.i}/${p.n}`;
      setStatus(`Passo ${p.stepIndex + 1}/${seq.steps.length}: ${what}${count}`,
        `Tempo residuo ~${fmtTime(total - elapsed)}`, elapsed / total);
      await pulse(light, p.on, p.off, signal);
      elapsed += p.on + p.off;
    }
    setStatus('Fatto ✔', `${seq.name}`, 1);
  });
}

function runTest(type) {
  const ms = state.timings[type];
  withLight(async (light, signal) => {
    setStatus(`Prova: ${TYPES[type].label}`, `${ms} ms`, 0);
    await pulse(light, ms, 0, signal);
    setStatus('Prova completata', `${TYPES[type].label} da ${ms} ms`, 1);
  });
}

// --- interfaccia: stato ---

function setRunning(running) {
  const btn = $('#runBtn');
  btn.textContent = running ? 'STOP' : 'AVVIA';
  btn.classList.toggle('running', running);
  document.querySelectorAll('[data-test]').forEach(b => { b.disabled = running; });
}

function setStatus(text, sub, progress) {
  $('#status').hidden = false;
  $('#statusText').textContent = text;
  $('#statusSub').textContent = sub;
  if (progress !== null) $('#progressBar').style.width = `${Math.round(progress * 100)}%`;
}

function highlightStep(index) {
  document.querySelectorAll('.step').forEach((el, i) => el.classList.toggle('active', i === index));
}

// --- interfaccia: editor sequenze ---

function renderSeqSelect() {
  const sel = $('#seqSelect');
  sel.replaceChildren(...state.sequences.map(s => new Option(s.name || '(senza nome)', s.id)));
  sel.value = activeSeq().id;
}

function renderSummary() {
  const plan = expand(activeSeq());
  const flashes = plan.filter(p => p.on > 0).length;
  $('#seqSummary').textContent = `${flashes} flash · durata ~${fmtTime(totalMs(plan))}`;
}

function renderSteps() {
  const seq = activeSeq();
  $('#seqName').value = seq.name;
  const list = $('#steps');
  list.replaceChildren(...seq.steps.map((step, i) => {
    const li = document.createElement('li');
    li.className = 'step';
    li.dataset.index = i;

    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = i + 1;

    const type = document.createElement('select');
    type.className = 'type';
    type.dataset.field = 'type';
    for (const [k, v] of Object.entries(TYPES)) type.add(new Option(v.label, k));
    type.value = step.type;

    const count = document.createElement('label');
    count.className = 'count';
    const n = document.createElement('input');
    n.type = 'number';
    n.inputMode = 'decimal';
    n.min = step.type === 'pause' ? '0' : '1';
    n.step = step.type === 'pause' ? '0.1' : '1';
    n.value = step.n;
    n.dataset.field = 'n';
    const unit = document.createElement('span');
    unit.textContent = TYPES[step.type].unit;
    count.append(n, unit);

    const label = document.createElement('input');
    label.className = 'label';
    label.type = 'text';
    label.placeholder = 'Descrizione (opzionale)';
    label.value = step.label || '';
    label.dataset.field = 'label';

    const tools = document.createElement('div');
    tools.className = 'tools';
    for (const [act, txt, title] of [['up', '↑', 'Sposta su'], ['down', '↓', 'Sposta giù'], ['del', '✕', 'Elimina']]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn-small' + (act === 'del' ? ' danger' : '');
      b.dataset.act = act;
      b.textContent = txt;
      b.title = title;
      tools.append(b);
    }

    li.append(num, type, count, label, tools);
    return li;
  }));
}

function renderAll() {
  renderSeqSelect();
  renderSteps();
  renderSummary();
  document.querySelectorAll('[data-timing]').forEach(inp => { inp.value = state.timings[inp.dataset.timing]; });
  $('#sourceSelect').value = state.source;
}

function changed({ steps = false } = {}) {
  save();
  if (steps) renderSteps();
  renderSummary();
}

// --- importa / esporta ---

function sanitizeSequence(obj) {
  if (!obj || !Array.isArray(obj.steps)) throw new Error('Formato non valido: manca "steps".');
  return {
    id: newId(),
    name: String(obj.name || 'Importata').slice(0, 60),
    steps: obj.steps.map(s => {
      if (!TYPES[s.type]) throw new Error(`Tipo di passo sconosciuto: ${s.type}`);
      const n = Number(s.n);
      if (!Number.isFinite(n) || n < 0) throw new Error('Numero non valido in un passo.');
      return { type: s.type, n, label: String(s.label || '').slice(0, 80) };
    }),
  };
}

function exportText(seq) {
  return JSON.stringify({ name: seq.name, steps: seq.steps }, null, 1);
}

// btoa da solo non va con le lettere accentate, per quello passo da TextEncoder
function encodeLink(seq) {
  const json = JSON.stringify({ name: seq.name, steps: seq.steps });
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(json)));
  return `${location.origin}${location.pathname}#seq=${encodeURIComponent(b64)}`;
}

function decodeLink(hash) {
  const m = hash.match(/seq=([^&]+)/);
  if (!m) return null;
  const bin = atob(decodeURIComponent(m[1]));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))));
}

function importSequence(obj) {
  const seq = sanitizeSequence(obj);
  state.sequences.push(seq);
  state.activeId = seq.id;
  save();
  renderAll();
  return seq;
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

// --- eventi ---

$('#runBtn').addEventListener('click', () => {
  if (runCtl) runCtl.abort();
  else runSequence();
});

document.querySelectorAll('[data-test]').forEach(b => b.addEventListener('click', () => {
  if (!runCtl) runTest(b.dataset.test);
}));

$('#seqSelect').addEventListener('change', e => {
  state.activeId = e.target.value;
  save();
  renderSteps();
  renderSummary();
});

$('#seqName').addEventListener('input', e => {
  activeSeq().name = e.target.value;
  save();
  const opt = $('#seqSelect').selectedOptions[0];
  if (opt) opt.textContent = e.target.value || '(senza nome)';
});

$('#newSeqBtn').addEventListener('click', () => {
  const seq = { id: newId(), name: 'Nuova sequenza', steps: [{ type: 'long', n: 1, label: 'Sveglia contatore' }] };
  state.sequences.push(seq);
  state.activeId = seq.id;
  save();
  renderAll();
});

$('#dupSeqBtn').addEventListener('click', () => {
  const src = activeSeq();
  const seq = { ...structuredClone(src), id: newId(), name: `${src.name} (copia)` };
  state.sequences.push(seq);
  state.activeId = seq.id;
  save();
  renderAll();
});

// confirm() non mi piaceva, faccio premere due volte Elimina
let delArmed = null;
$('#delSeqBtn').addEventListener('click', e => {
  const btn = e.currentTarget;
  if (state.sequences.length <= 1) {
    btn.textContent = 'È l\'ultima';
    setTimeout(() => { btn.textContent = 'Elimina'; }, 1500);
    return;
  }
  if (!delArmed) {
    btn.textContent = 'Conferma?';
    delArmed = setTimeout(() => { btn.textContent = 'Elimina'; delArmed = null; }, 2500);
    return;
  }
  clearTimeout(delArmed);
  delArmed = null;
  btn.textContent = 'Elimina';
  state.sequences = state.sequences.filter(s => s.id !== state.activeId);
  state.activeId = state.sequences[0].id;
  save();
  renderAll();
});

document.querySelectorAll('[data-add]').forEach(b => b.addEventListener('click', () => {
  const type = b.dataset.add;
  activeSeq().steps.push({ type, n: 1, label: '' });
  changed({ steps: true });
}));

$('#steps').addEventListener('input', e => {
  const li = e.target.closest('.step');
  if (!li) return;
  const step = activeSeq().steps[+li.dataset.index];
  const field = e.target.dataset.field;
  if (field === 'n') {
    const v = parseFloat(e.target.value);
    if (!Number.isFinite(v) || v < 0) return;
    step.n = step.type === 'pause' ? v : Math.max(1, Math.round(v));
  } else if (field === 'label') {
    step.label = e.target.value;
  } else if (field === 'type') {
    step.type = e.target.value;
    if (step.type !== 'pause') step.n = Math.max(1, Math.round(step.n));
    return changed({ steps: true });
  }
  changed();
});

$('#steps').addEventListener('click', e => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const steps = activeSeq().steps;
  const i = +btn.closest('.step').dataset.index;
  const act = btn.dataset.act;
  if (act === 'del') steps.splice(i, 1);
  else {
    const j = act === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= steps.length) return;
    [steps[i], steps[j]] = [steps[j], steps[i]];
  }
  changed({ steps: true });
});

document.querySelectorAll('[data-timing]').forEach(inp => inp.addEventListener('change', () => {
  const v = Number(inp.value);
  const min = Number(inp.min), max = Number(inp.max);
  if (!Number.isFinite(v)) { inp.value = state.timings[inp.dataset.timing]; return; }
  const clamped = Math.min(max, Math.max(min, v));
  inp.value = clamped;
  state.timings[inp.dataset.timing] = clamped;
  changed();
}));

$('#sourceSelect').addEventListener('change', e => { state.source = e.target.value; save(); });

$('#exportBtn').addEventListener('click', async () => {
  const text = exportText(activeSeq());
  $('#ioText').value = text;
  $('#ioMsg').textContent = await copy(text) ? 'Copiata negli appunti.' : 'Seleziona e copia il testo qui sopra.';
});

$('#linkBtn').addEventListener('click', async () => {
  const link = encodeLink(activeSeq());
  $('#ioText').value = link;
  $('#ioMsg').textContent = await copy(link) ? 'Link copiato: chi lo apre importa la sequenza.' : 'Copia il link qui sopra.';
});

$('#importBtn').addEventListener('click', () => {
  const raw = $('#ioText').value.trim();
  try {
    const obj = raw.includes('#seq=') ? decodeLink(raw.slice(raw.indexOf('#'))) : JSON.parse(raw);
    const seq = importSequence(obj);
    $('#ioMsg').textContent = `Importata "${seq.name}".`;
  } catch (e) {
    $('#ioMsg').textContent = `Import fallito: ${e.message}`;
  }
});

// --- avvio ---

function checkSupport() {
  const badge = $('#support');
  const hasCam = !!navigator.mediaDevices?.getUserMedia;
  const torchKnown = navigator.mediaDevices?.getSupportedConstraints?.().torch;
  if (!window.isSecureContext || !hasCam) {
    badge.textContent = 'serve HTTPS';
    badge.className = 'badge ko';
  } else if (torchKnown) {
    badge.textContent = 'flash supportato';
    badge.className = 'badge ok';
  } else {
    badge.textContent = 'flash non garantito';
    badge.className = 'badge';
  }
}

if (location.hash.includes('seq=')) {
  try {
    const seq = importSequence(decodeLink(location.hash));
    setStatus('Sequenza importata dal link', seq.name, null);
  } catch { /* link rotto, lo ignoro */ }
  history.replaceState(null, '', location.pathname + location.search);
}

renderAll();
checkSupport();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
