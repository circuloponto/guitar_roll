// Scrub voice that keeps the music sounding like itself. The playhead position is manual, but the
// sound is made of short windowed grains read at the normal speed (so pitch never changes), laid
// down at a steady rhythm and aligned to each other (WSOLA) so tonal material stays smooth.
// Slow drag = the music stretched out, fast drag = it skips ahead (speed is limited to a sensible
// range, so the audio catches up instead of racing), backwards = grains stepping backwards.
const GRAIN_SEC = 0.09;    // each grain
const MAX_SPEED = 2;       // file seconds per second, either direction
const JUMP_SEC = 0.35;     // farther than this from the pointer: land on it instead of chasing

class ScrubProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.data = null;
    this.sr = 44100;
    this.pos = 0;
    this.target = 0;
    this.active = false;
    this.v = 0;
    this.g = 0;
    this.G = Math.round(GRAIN_SEC * sampleRate);
    this.H = this.G >> 2; // 75% overlap
    this.win = new Float32Array(this.G);
    for (let i = 0; i < this.G; i++) this.win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / this.G)) * 0.5;
    this.grains = [];
    this.sinceSpawn = this.H; // spawn on the first sample
    this.prevStart = null;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'load') {
        this.data = m.data;
        this.sr = m.sr;
      } else if (m.type === 'target') {
        if (m.active) {
          if (!this.active) { this.pos = m.t; this.v = 0; this.prevStart = null; }
          else if (Math.abs(m.t - this.pos) > JUMP_SEC) {
            // Too far to chase: land on the pointer but keep sounding (at the top of the range)
            this.v = (m.t > this.pos ? 1 : -1) * MAX_SPEED;
            this.pos = m.t; // (prevStart is kept so the new grain still lines up with what is playing)
          }
          this.target = m.t;
        }
        this.active = !!m.active;
      }
    };
  }

  // Pick the start of the next grain: near the position we want, but shifted by up to a few ms to
  // the place that best continues the previous grain (waveform similarity).
  pickStart(r) {
    const data = this.data, len = data.length;
    const nom = Math.round(this.pos * this.sr - (this.G * r) / 2);
    if (this.prevStart == null) return nom;
    const ref = this.prevStart + Math.round(this.H * r);
    const range = Math.round(0.006 * this.sr);
    const L = Math.min(Math.round(this.H * r), 512);
    if (ref < 0 || ref + L >= len) return nom;
    let best = nom, bestScore = -Infinity;
    for (let s = nom - range; s <= nom + range; s += 2) {
      if (s < 0 || s + L >= len) continue;
      let dot = 0, en = 1e-9;
      for (let k = 0; k < L; k += 2) { const a = data[s + k]; dot += a * data[ref + k]; en += a * a; }
      const score = dot / Math.sqrt(en);
      if (score > bestScore) { bestScore = score; best = s; }
    }
    return best;
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const L = out[0];
    const R = out[1];
    const data = this.data;
    const n = L.length;
    if (!data) { L.fill(0); if (R) R.fill(0); return true; }
    const dt = 1 / sampleRate;
    const len = data.length;
    const r = this.sr / sampleRate;
    const G = this.G;
    for (let i = 0; i < n; i++) {
      // speed follows the pointer but stays in the sensible range
      const vt = this.active ? Math.max(-MAX_SPEED, Math.min(MAX_SPEED, (this.target - this.pos) * 14)) : 0;
      this.v += (vt - this.v) * 0.002;
      this.pos += this.v * dt;
      const av = Math.abs(this.v);
      const gt = av > 0.03 ? Math.min(1, av * 20) : 0; // full level from a slow crawl, silent when still
      this.g += (gt - this.g) * 0.004;

      if (this.g > 1e-3 && ++this.sinceSpawn >= this.H) {
        this.sinceSpawn = 0;
        const s = this.pickStart(r);
        this.grains.push({ s, age: 0 });
        this.prevStart = s;
      }
      let acc = 0;
      for (let k = this.grains.length - 1; k >= 0; k--) {
        const gr = this.grains[k];
        const x = gr.s + gr.age * r;
        const i0 = Math.floor(x);
        if (i0 >= 0 && i0 < len - 1) {
          const f = x - i0;
          acc += (data[i0] * (1 - f) + data[i0 + 1] * f) * this.win[gr.age];
        }
        if (++gr.age >= G) this.grains.splice(k, 1);
      }
      const s = acc * this.g;
      L[i] = s;
      if (R) R[i] = s;
    }
    return true;
  }
}
registerProcessor('scrub-voice', ScrubProcessor);
