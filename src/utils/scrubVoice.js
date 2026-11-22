// Tape-style scrubbing through an AudioWorklet (public/scrubProcessor.js). One voice per
// recording, each holding a mono copy of its audio; the page only sends "the pointer is at this
// file time", and the worklet does the smooth speed-following on the audio thread.
import { getAudioContext, getMasterOut } from './audio';

const URL_ = import.meta.env.BASE_URL + 'scrubProcessor.js';
const modules = new WeakMap();  // ctx -> Promise
const voices = new WeakMap();   // AudioBuffer -> { node, gain, ready }

function ensureModule(ctx) {
  let p = modules.get(ctx);
  if (!p) {
    p = ctx.audioWorklet.addModule(URL_).catch((e) => { modules.delete(ctx); throw e; });
    modules.set(ctx, p);
  }
  return p;
}

// Create (once) the scrub voice for a decoded recording. Safe to call repeatedly.
export function prepareScrub(buffer) {
  if (!buffer) return null;
  let v = voices.get(buffer);
  if (v) return v;
  const ctx = getAudioContext();
  v = { node: null, gain: null, ready: false };
  voices.set(buffer, v);
  ensureModule(ctx).then(() => {
    const node = new AudioWorkletNode(ctx, 'scrub-voice', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    const gain = ctx.createGain();
    node.connect(gain);
    gain.connect(getMasterOut());
    // Mono mixdown, copied once and handed over to the worklet.
    const n = buffer.length, ch = buffer.numberOfChannels;
    const mono = new Float32Array(n);
    for (let c = 0; c < ch; c++) {
      const d = buffer.getChannelData(c);
      for (let i = 0; i < n; i++) mono[i] += d[i] / ch;
    }
    node.port.postMessage({ type: 'load', data: mono, sr: buffer.sampleRate }, [mono.buffer]);
    v.node = node; v.gain = gain; v.ready = true;
  }).catch((e) => { console.warn('[scrub] could not start', e); voices.delete(buffer); });
  return v;
}

// fileTime: seconds into the recording the pointer is over, or null when it isn't over audio.
export function scrubTarget(buffer, fileTime, volume = 1) {
  const ctx = getAudioContext();
  if (ctx.state === 'suspended') ctx.resume(); // a drag is a user gesture, so this is allowed
  const v = voices.get(buffer) || prepareScrub(buffer);
  if (!v || !v.ready) return false;
  v.gain.gain.value = 0.9 * volume;
  v.node.port.postMessage({ type: 'target', t: fileTime ?? 0, active: fileTime != null });
  return true;
}

export function scrubStop(buffer) {
  const v = voices.get(buffer);
  if (v && v.ready) v.node.port.postMessage({ type: 'target', t: 0, active: false });
}
