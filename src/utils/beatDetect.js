// Beat detection for audio sync points (no dependencies).
//
// 1. Onset strength: spectral flux (half-wave rectified change of log magnitude) over a
//    short-time FFT of the mono mix.
// 2. Tempo: autocorrelation of that curve, weighted toward the project's own beat length so
//    the pulse lands on the grid's metrical level (not double / half time).
// 3. Beats: dynamic-programming tracker (Ellis 2007) - maximise onset strength on the beats
//    while keeping the spacing near the tempo, which still lets the tempo drift (rubato).

const FRAME = 1024;
const HOP = 512;

function fftInPlace(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = i + k + len / 2;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

export function onsetStrength(buffer) {
  const sr = buffer.sampleRate;
  const chans = buffer.numberOfChannels;
  const len = buffer.length;
  const data = buffer.getChannelData(0);
  const other = chans > 1 ? buffer.getChannelData(1) : null;
  const frames = Math.max(0, Math.floor((len - FRAME) / HOP));
  const win = new Float64Array(FRAME);
  for (let i = 0; i < FRAME; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1));
  const bins = FRAME / 4; // up to ~Nyquist/2: where most attacks live
  let prev = new Float64Array(bins);
  const flux = new Float64Array(frames);
  const re = new Float64Array(FRAME), im = new Float64Array(FRAME);
  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    for (let i = 0; i < FRAME; i++) {
      const v = other ? (data[off + i] + other[off + i]) * 0.5 : data[off + i];
      re[i] = v * win[i]; im[i] = 0;
    }
    fftInPlace(re, im);
    let sum = 0;
    const cur = new Float64Array(bins);
    for (let k = 1; k < bins; k++) {
      const mag = Math.log1p(100 * Math.hypot(re[k], im[k]) / FRAME * 8);
      cur[k] = mag;
      const d = mag - prev[k];
      if (d > 0) sum += d;
    }
    flux[f] = f === 0 ? 0 : sum;
    prev = cur;
  }
  // remove the slow-moving baseline and normalise
  const out = new Float64Array(frames);
  const w = 8;
  for (let f = 0; f < frames; f++) {
    let s = 0, c = 0;
    for (let j = Math.max(0, f - w); j <= Math.min(frames - 1, f + w); j++) { s += flux[j]; c++; }
    out[f] = Math.max(0, flux[f] - s / c);
  }
  for (let f = 0; f < Math.min(3, frames); f++) out[f] = 0; // the start of the file is always a "jump" from silence
  let m2 = 0;
  for (let f = 0; f < frames; f++) m2 += out[f] * out[f];
  const sd = Math.sqrt(m2 / Math.max(1, frames)) || 1;
  for (let f = 0; f < frames; f++) out[f] /= sd;
  return { novelty: out, frameSec: HOP / sr };
}

// Returns beat times in seconds, or [] when no steady pulse is found.
// gridBeatSec: seconds per beat of the project grid (used to pick the metrical level).
export function detectBeats(buffer, gridBeatSec) {
  const { novelty, frameSec } = onsetStrength(buffer);
  const n = novelty.length;
  if (n < 64) return [];

  // --- tempo by autocorrelation, weighted toward the grid's beat length ---
  const minLag = Math.max(2, Math.round(0.25 / frameSec)); // 240 BPM
  const maxLag = Math.min(n - 1, Math.round(1.5 / frameSec)); // 40 BPM
  let best = 0, bestLag = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let ac = 0;
    for (let i = lag; i < n; i++) ac += novelty[i] * novelty[i - lag];
    ac /= (n - lag);
    const octave = Math.log2((lag * frameSec) / gridBeatSec);
    const weighted = ac * Math.exp(-0.5 * (octave / 0.7) ** 2);
    if (weighted > best) { best = weighted; bestLag = lag; }
  }
  if (!bestLag) return [];
  const period = bestLag;

  // --- dynamic programming beat tracker ---
  const TIGHT = 400;
  const score = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  const lo = Math.max(1, Math.round(period * 0.6));
  const hi = Math.round(period * 1.6);
  for (let t = 0; t < n; t++) {
    let bestPrev = t < period ? 0 : -Infinity; // the first beat may start anywhere early
    let bestIdx = -1;
    for (let tau = lo; tau <= hi; tau++) {
      const p = t - tau;
      if (p < 0) break;
      const cand = score[p] - TIGHT * Math.log(tau / period) ** 2;
      if (cand > bestPrev) { bestPrev = cand; bestIdx = p; }
    }
    score[t] = novelty[t] + (bestPrev === -Infinity ? 0 : bestPrev);
    back[t] = bestIdx;
  }
  // best ending point among the last beat period
  let end = n - 1, endScore = -Infinity;
  for (let t = Math.max(0, n - period); t < n; t++) if (score[t] > endScore) { endScore = score[t]; end = t; }
  const beats = [];
  for (let t = end; t >= 0; t = back[t]) { beats.push(t); if (back[t] < 0) break; }
  beats.reverse();

  // trim beats outside the part that actually has attacks
  const sorted = [...novelty].sort((a, b) => a - b);
  const thresh = sorted[Math.floor(n * 0.99)] * 0.25;
  const strongAt = (t) => { for (let j = Math.max(0, t - 3); j <= Math.min(n - 1, t + 3); j++) if (novelty[j] >= thresh) return true; return false; };
  while (beats.length && !strongAt(beats[0])) beats.shift();
  while (beats.length && !strongAt(beats[beats.length - 1])) beats.pop();

  // snap each beat to the sharpest nearby attack (sub-frame precision by parabola)
  return beats.map((t) => {
    let bt = t;
    for (let j = Math.max(1, t - 3); j <= Math.min(n - 2, t + 3); j++) if (novelty[j] > novelty[bt]) bt = j;
    let frac = 0;
    if (bt > 0 && bt < n - 1) {
      const a = novelty[bt - 1], b = novelty[bt], c = novelty[bt + 1];
      const den = a - 2 * b + c;
      if (den < 0) frac = Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / den));
    }
    // frame centre is half a window after the frame start
    return (bt + frac) * frameSec + (FRAME / 2) / buffer.sampleRate;
  });
}

// Fit one steady tempo to the detected beats (beat k happens at t0 + k * period), robust to
// a few wrong beats, and return the smoothed leftover timing error per beat. The steady tempo
// becomes the audio's own tempo; only the real drift is left for sync points to correct.
export function fitTempo(beats) {
  const n = beats.length;
  if (n < 4) return null;
  let keep = beats.map((_, k) => k);
  let period = 0, t0 = 0;
  for (let pass = 0; pass < 4; pass++) {
    let sk = 0, st = 0, skk = 0, skt = 0;
    keep.forEach((k) => { sk += k; st += beats[k]; skk += k * k; skt += k * beats[k]; });
    const m = keep.length;
    const den = m * skk - sk * sk;
    if (!den) return null;
    period = (m * skt - sk * st) / den;
    t0 = (st - period * sk) / m;
    const res = beats.map((t, k) => Math.abs(t - (t0 + period * k)));
    const sorted = [...res].sort((a, b) => a - b);
    const limit = Math.max(0.03, 3 * sorted[Math.floor(n / 2)]);
    const next = res.map((r, k) => (r <= limit ? k : -1)).filter(k => k >= 0);
    if (next.length < 4 || next.length === keep.length) break;
    keep = next;
  }
  if (!(period > 0.1 && period < 3)) return null;
  // smoothed residual: median of 5, then mean of 3 (kills detection jitter, keeps real drift)
  const raw = beats.map((t, k) => t - (t0 + period * k));
  const med = raw.map((_, k) => {
    const w = raw.slice(Math.max(0, k - 2), Math.min(n, k + 3)).sort((a, b) => a - b);
    return w[Math.floor(w.length / 2)];
  });
  const smooth = med.map((_, k) => {
    const w = med.slice(Math.max(0, k - 1), Math.min(n, k + 2));
    return w.reduce((a, c) => a + c, 0) / w.length;
  });
  return { period, t0, residual: smooth };
}
