// Teach the transcriber from your own transcription.
//
// You write down a stretch of a recording by hand. Everything the pitch model finds in that
// stretch is then compared with what you wrote: a candidate that matches one of your notes is a
// real note (label 1), anything else is a false note (label 0). Each candidate is described by a
// handful of numbers (how strong, how long, how low, whether a pluck sits under it, whether a
// stronger note an octave away looks like its source ...). A small logistic regression learns
// which combinations of those numbers mean "real", and a threshold is picked so that most of what
// is kept is correct: it is better to miss a note than to flood the track with false ones.
//
// Everything stays in this browser (localStorage). More examples make it better; "forget" clears it.

const SAMPLES_KEY = 'guitar-roll-tx-samples';
const MODEL_KEY = 'guitar-roll-tx-model';
const MAX_SAMPLES = 6000;
export const FEATURE_NAMES = [
  'strength', 'relative strength', 'length', 'pitch', 'low note', 'attack under it',
  'onset confidence', 'strength within its chord', 'notes at this attack', 'octave ghost?', 'overtone?',
];

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };

// attacks: sorted attack times (s). Returns [{ ev, x }] with x the feature vector of each event.
export function computeFeatures(events, attacks) {
  const typical = median(events.map(e => e.amp)) || 0.5;
  const hasAttack = (t) => {
    if (!attacks || !attacks.length) return 0;
    let lo = 0, hi = attacks.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (attacks[mid] < t - 0.07) lo = mid + 1; else hi = mid; }
    return lo < attacks.length && attacks[lo] <= t + 0.07 ? 1 : 0;
  };
  // events sorted by start: neighbours at the same attack are found with a sliding window
  const sorted = [...events].sort((a, b) => a.start - b.start);
  const byPitch = new Map();
  for (const e of sorted) { if (!byPitch.has(e.midi)) byPitch.set(e.midi, []); byPitch.get(e.midi).push(e); }
  const near = (midi, e, win) => (byPitch.get(midi) || []).filter(f => f !== e && Math.abs(f.start - e.start) <= win && f.end >= e.start && f.start <= e.end);
  const out = [];
  let lo = 0;
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i];
    while (sorted[lo].start < e.start - 0.06) lo++;
    let groupMax = e.amp, groupN = 0;
    for (let j = lo; j < sorted.length && sorted[j].start <= e.start + 0.06; j++) {
      groupN++;
      if (sorted[j].amp > groupMax) groupMax = sorted[j].amp;
    }
    const ghost = [12, 24].some(up => near(e.midi + up, e, 0.08).some(f => f.amp > e.amp / 0.75)) ? 1 : 0;
    const overtone = [12, 19, 24, 28, 31].some(d => near(e.midi - d, e, 0.08).some(f => e.amp < f.amp * 0.85)) ? 1 : 0;
    out.push({
      ev: e,
      x: [
        e.amp,
        Math.min(3, e.amp / typical),
        Math.log(Math.max(0.03, e.end - e.start)),
        (e.midi - 64) / 24,
        e.midi < 52 ? 1 : 0,
        hasAttack(e.start),
        e.onset ?? 0.5,
        groupMax > 0 ? e.amp / groupMax : 1,
        Math.min(6, groupN) / 6,
        ghost,
        overtone,
      ],
    });
  }
  return out;
}

// truth: [{ start, midi }] (seconds). A candidate is real when a truth note of the same pitch
// starts within tolSec; each truth note can vouch for one candidate.
export function matchToTruth(candidates, truth, tolSec = 0.08) {
  const used = new Set();
  const labels = new Array(candidates.length).fill(0);
  const order = candidates.map((c, i) => i).sort((a, b) => candidates[a].ev.start - candidates[b].ev.start);
  for (const i of order) {
    const { ev } = candidates[i];
    let best = -1, bestD = Infinity;
    truth.forEach((t, k) => {
      if (used.has(k) || t.midi !== ev.midi) return;
      const d = Math.abs(t.start - ev.start);
      if (d <= tolSec && d < bestD) { best = k; bestD = d; }
    });
    if (best >= 0) { used.add(best); labels[i] = 1; }
  }
  const missed = truth.length - used.size; // truth notes the model never found
  return { labels, missed };
}

// ---------------------------------------------------------------------------------------------
// storage

export function loadSamples() {
  try { const s = JSON.parse(localStorage.getItem(SAMPLES_KEY)); return Array.isArray(s) ? s : []; } catch { return []; }
}
export function saveSamples(samples) {
  try { localStorage.setItem(SAMPLES_KEY, JSON.stringify(samples.slice(-MAX_SAMPLES))); } catch { /* ignore */ }
}
export function loadLearned() {
  try { return JSON.parse(localStorage.getItem(MODEL_KEY)); } catch { return null; }
}
export function saveLearned(m) {
  try { if (m) localStorage.setItem(MODEL_KEY, JSON.stringify(m)); else localStorage.removeItem(MODEL_KEY); } catch { /* ignore */ }
}
export function forgetLearning() {
  try { localStorage.removeItem(SAMPLES_KEY); localStorage.removeItem(MODEL_KEY); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------------------------
// learning

const sigmoid = (z) => 1 / (1 + Math.exp(-z));

// samples: [{ x: number[], y: 0|1 }]. Standardise, then L2-regularised logistic regression.
export function trainLogistic(samples, { lambda = 0.02, iterations = 500, rate = 0.3 } = {}) {
  const d = samples[0].x.length;
  const mean = new Array(d).fill(0), std = new Array(d).fill(0);
  for (const s of samples) s.x.forEach((v, j) => { mean[j] += v / samples.length; });
  for (const s of samples) s.x.forEach((v, j) => { std[j] += (v - mean[j]) ** 2 / samples.length; });
  for (let j = 0; j < d; j++) std[j] = Math.sqrt(std[j]) || 1;
  const X = samples.map(s => s.x.map((v, j) => (v - mean[j]) / std[j]));
  const y = samples.map(s => s.y);
  const w = new Array(d).fill(0);
  let b = 0;
  // start from the base rate so the first steps are sensible
  const pos = y.reduce((a, v) => a + v, 0);
  b = Math.log((pos + 1) / (samples.length - pos + 1));
  for (let it = 0; it < iterations; it++) {
    const gw = new Array(d).fill(0);
    let gb = 0;
    for (let i = 0; i < X.length; i++) {
      let z = b;
      for (let j = 0; j < d; j++) z += w[j] * X[i][j];
      const err = sigmoid(z) - y[i];
      for (let j = 0; j < d; j++) gw[j] += err * X[i][j];
      gb += err;
    }
    for (let j = 0; j < d; j++) w[j] -= rate * (gw[j] / X.length + lambda * w[j]);
    b -= rate * (gb / X.length);
  }
  return { mean, std, w, b };
}

export function predict(model, x) {
  let z = model.b;
  for (let j = 0; j < model.w.length; j++) z += model.w[j] * ((x[j] - model.mean[j]) / model.std[j]);
  return sigmoid(z);
}

// precision / recall of keeping candidates with p >= thr, on labelled samples
export function evaluate(model, samples, thr) {
  let tp = 0, fp = 0, fn = 0;
  for (const s of samples) {
    const keep = predict(model, s.x) >= thr;
    if (keep && s.y) tp++; else if (keep) fp++; else if (s.y) fn++;
  }
  return { precision: tp + fp ? tp / (tp + fp) : 1, recall: tp + fn ? tp / (tp + fn) : 0, kept: tp + fp };
}

// the lowest threshold whose precision still reaches `targetPrecision` (more recall that way)
export function chooseThreshold(model, samples, targetPrecision = 0.85) {
  const ps = samples.map(s => ({ p: predict(model, s.x), y: s.y })).sort((a, b) => b.p - a.p);
  let tp = 0, fp = 0, best = 0.5, found = false;
  for (const { p, y } of ps) {
    if (y) tp++; else fp++;
    if (tp / (tp + fp) >= targetPrecision && tp >= 3) { best = p; found = true; }
  }
  return found ? Math.max(0.05, best - 1e-6) : 0.75; // not reachable with this little data: be strict
}

// Train from the stored samples and keep the result. Returns the learned record (or null if
// there is not enough to learn from).
export function retrain(targetPrecision = 0.85) {
  const samples = loadSamples();
  const pos = samples.filter(s => s.y === 1).length;
  if (samples.length < 20 || pos < 5 || pos === samples.length) return null;
  const model = trainLogistic(samples);
  const threshold = chooseThreshold(model, samples, targetPrecision);
  const stats = evaluate(model, samples, threshold);
  const learned = {
    model, threshold, targetPrecision,
    samples: samples.length, positives: pos, precision: stats.precision, recall: stats.recall,
    trainedAt: Date.now(),
  };
  saveLearned(learned);
  return learned;
}

// Keep only the candidates the learned model believes in. `candidates` come from computeFeatures.
export function applyLearned(candidates, learned, strictness = 0) {
  if (!learned) return candidates.map(c => c.ev);
  const thr = Math.min(0.97, Math.max(0.05, learned.threshold + strictness));
  return candidates.filter(c => predict(learned.model, c.x) >= thr).map(c => c.ev);
}
