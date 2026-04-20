// Main-thread wrapper around the rubberband AudioWorkletProcessor (public/rubberbandProcessor.js).
// Responsibilities:
//   - Register the worklet module once per AudioContext.
//   - Fetch + compile the rubberband.wasm once per session and cache the Module.
//   - Create RubberBandWorkletNode instances, ferry the WebAssembly.Module to them via
//     postMessage, and surface a `ready` promise + tempo/reset helpers.
//
// NOTE: Rubber Band is GPL; a commercial licence is required for non-GPL distribution.
import wasmUrl from 'rubberband-wasm/dist/rubberband.wasm?url';

const WORKLET_URL = import.meta.env.BASE_URL + 'rubberbandProcessor.js';
const PROCESSOR_NAME = 'rubberband-stretch';

let compiledModulePromise = null;
const registeredCtxs = new WeakMap(); // ctx -> Promise<void>

function compileWasm() {
  if (!compiledModulePromise) {
    compiledModulePromise = (async () => {
      const res = await fetch(wasmUrl);
      if (!res.ok) throw new Error(`Failed to fetch rubberband.wasm (${res.status})`);
      return WebAssembly.compileStreaming(res);
    })().catch((err) => {
      compiledModulePromise = null; // allow retry on next call
      throw err;
    });
  }
  return compiledModulePromise;
}

export function ensureReady(ctx) {
  if (!ctx) return Promise.resolve(false);
  let p = registeredCtxs.get(ctx);
  if (!p) {
    p = (async () => {
      await ctx.audioWorklet.addModule(WORKLET_URL);
      // Kick off the wasm compile too, so the first createNode call doesn't pay that cost.
      compileWasm().catch(() => {});
    })().catch((err) => {
      registeredCtxs.delete(ctx);
      console.error('[rubberband] ensureReady failed:', err);
      throw err;
    });
    registeredCtxs.set(ctx, p);
  }
  return p;
}

// Create a worklet node and bind it to the rubberband wasm Module. Returns
// { node, ready } where `ready` resolves to { startDelaySamples } once init completes.
export async function createStretchNode(ctx, { numChannels = 2, initialRatio = 1 } = {}) {
  await ensureReady(ctx);
  const module = await compileWasm();
  const node = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [numChannels],
  });
  const ready = new Promise((resolve, reject) => {
    const onMsg = (e) => {
      if (e.data?.type === 'ready') {
        node.port.removeEventListener('message', onMsg);
        resolve({ startDelaySamples: e.data.startDelaySamples });
      } else if (e.data?.type === 'error') {
        node.port.removeEventListener('message', onMsg);
        reject(new Error(e.data.message || 'rubberband worklet init failed'));
      }
    };
    node.port.addEventListener('message', onMsg);
    node.port.start();
  });
  node.port.postMessage({
    type: 'init',
    module,
    sampleRate: ctx.sampleRate,
    numChannels,
    initialRatio,
  });
  return { node, ready };
}

export function setStretchTempo(node, ratio) {
  if (!node || !Number.isFinite(ratio) || ratio <= 0) return;
  node.port.postMessage({ type: 'tempo', ratio });
}

export function resetStretch(node) {
  if (!node) return;
  node.port.postMessage({ type: 'reset' });
}
