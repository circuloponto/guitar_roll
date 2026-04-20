// AudioWorkletProcessor that streams audio through Rubber Band (WASM) in realtime mode.
// Served verbatim from /public; loaded via AudioContext.audioWorklet.addModule().
//
// The RubberBandInterface class below is vendored from rubberband-wasm@3.3.0
// (node_modules/rubberband-wasm/dist/index.esm.js). AudioWorkletGlobalScope cannot
// resolve bare specifiers or use dynamic import, so we inline the glue class. Keep
// this copy in sync when the upstream dep version changes.
//
// Architecture note: the BufferSource upstream has `playbackRate = tempoMultiplier`, so
// it resamples the audio to play at the target tempo (with a pitch shift as a side-effect).
// This worklet's job is therefore NOT to change time — it's to *undo* that pitch shift.
// We keep rubberband's time_ratio fixed at 1 and use pitch_scale = 1/tempoMultiplier.
//
// Protocol from main thread (via node.port.postMessage):
//   { type: 'init', module: WebAssembly.Module, sampleRate, numChannels, initialRatio }
//   { type: 'tempo', ratio: number }  // pitch_scale = 1/tempoMultiplier = originalBpm/liveBpm
// Reverse direction:
//   { type: 'ready', startDelaySamples: number }

// -------- Vendored RubberBandInterface (rubberband-wasm 3.3.0) --------
class RubberBandInterface {
  constructor() {}
  static async initialize(module) {
    if (typeof WebAssembly === 'undefined') {
      throw new Error('WebAssembly is not supported in this environment!');
    }
    const heap = {};
    const errorHandler = () => 52;
    const printBuffer = [];
    const wasmInstance = await WebAssembly.instantiate(module, {
      env: {
        emscripten_notify_memory_growth: () => {
          heap.HEAP8 = new Uint8Array(wasmInstance.exports.memory.buffer);
          heap.HEAP32 = new Uint32Array(wasmInstance.exports.memory.buffer);
        },
      },
      wasi_snapshot_preview1: {
        proc_exit: errorHandler,
        fd_read: errorHandler,
        fd_write: (fd, iov, iovcnt, pnum) => {
          if (fd > 2) return 52;
          let num = 0;
          for (let i = 0; i < iovcnt; i++) {
            const ptr = heap.HEAP32[iov >> 2];
            const len = heap.HEAP32[(iov + 4) >> 2];
            iov += 8;
            for (let j = 0; j < len; j++) {
              const curr = heap.HEAP8[ptr + j];
              if (curr === 0 || curr === 10) { printBuffer.length = 0; }
              else { printBuffer.push(String.fromCharCode(curr)); }
            }
            num += len;
          }
          heap.HEAP32[pnum >> 2] = num;
          return 0;
        },
        fd_seek: errorHandler,
        fd_close: errorHandler,
        environ_sizes_get: () => 52,
        environ_get: () => 52,
      },
    });
    heap.HEAP8 = new Uint8Array(wasmInstance.exports.memory.buffer);
    heap.HEAP32 = new Uint32Array(wasmInstance.exports.memory.buffer);
    const api = new RubberBandInterface();
    api.wasm = wasmInstance;
    api.heap = heap;
    return api;
  }
  malloc(size) { return this.wasm.exports.malloc(size); }
  free(ptr) { return this.wasm.exports.free(ptr); }
  memWrite(destPtr, data) {
    if (data instanceof Float32Array) {
      new Float32Array(this.wasm.exports.memory.buffer, destPtr, data.length).set(data);
    } else {
      new Uint8Array(this.wasm.exports.memory.buffer, destPtr, data.length).set(data);
    }
  }
  memWritePtr(destPtr, srcPtr) {
    new Uint32Array(this.wasm.exports.memory.buffer, destPtr, 1)[0] = srcPtr;
  }
  memReadU8(srcPtr, length) {
    return new Uint8Array(this.wasm.exports.memory.buffer, srcPtr, length);
  }
  memReadF32(srcPtr, length) {
    return new Float32Array(this.wasm.exports.memory.buffer, srcPtr, length);
  }
  rubberband_new(sampleRate, channels, options, initialTimeRatio, initialPitchScale) {
    return this.wasm.exports.rubberband_new(sampleRate, channels, options, initialTimeRatio, initialPitchScale);
  }
  rubberband_delete(state) { return this.wasm.exports.rubberband_delete(state); }
  rubberband_reset(state) { return this.wasm.exports.rubberband_reset(state); }
  rubberband_set_time_ratio(state, ratio) { return this.wasm.exports.rubberband_set_time_ratio(state, ratio); }
  rubberband_set_pitch_scale(state, scale) { return this.wasm.exports.rubberband_set_pitch_scale(state, scale); }
  rubberband_get_time_ratio(state) { return this.wasm.exports.rubberband_get_time_ratio(state); }
  rubberband_get_pitch_scale(state) { return this.wasm.exports.rubberband_get_pitch_scale(state); }
  rubberband_get_start_delay(state) { return this.wasm.exports.rubberband_get_start_delay(state); }
  rubberband_get_latency(state) { return this.wasm.exports.rubberband_get_latency(state); }
  rubberband_set_expected_input_duration(state, samples) { return this.wasm.exports.rubberband_set_expected_input_duration(state, samples); }
  rubberband_get_samples_required(state) { return this.wasm.exports.rubberband_get_samples_required(state); }
  rubberband_set_max_process_size(state, samples) { return this.wasm.exports.rubberband_set_max_process_size(state, samples); }
  rubberband_study(state, input, samples, final) { return this.wasm.exports.rubberband_study(state, input, samples, final); }
  rubberband_process(state, input, samples, final) { return this.wasm.exports.rubberband_process(state, input, samples, final); }
  rubberband_available(state) { return this.wasm.exports.rubberband_available(state); }
  rubberband_retrieve(state, output, samples) { return this.wasm.exports.rubberband_retrieve(state, output, samples); }
  rubberband_get_channel_count(state) { return this.wasm.exports.rubberband_get_channel_count(state); }
}

// Option bit values (copied from the rubberband-wasm enum so we avoid importing).
const OPT_PROCESS_REALTIME = 1;
const OPT_ENGINE_FASTER = 0;
const OPT_PITCH_HIGH_QUALITY = 33554432;

class RubberBandProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ready = false;                 // wasm + state initialised
    this.passthrough = true;            // set false once rubberband push/pull is wired
    this.rb = null;
    this.state = 0;
    this.numChannels = 0;
    this.pendingRatio = null;
    this.discardRemaining = 0;          // startup-delay compensation (samples)
    this.channelArrayPtr = 0;
    this.channelDataPtr = [];
    this.chunkCapacity = 0;

    this.port.onmessage = (e) => this._onMessage(e.data);
  }

  async _onMessage(msg) {
    if (!msg) return;
    if (msg.type === 'init') {
      try {
        this.numChannels = msg.numChannels || 2;
        this.rb = await RubberBandInterface.initialize(msg.module);
        const opts = OPT_PROCESS_REALTIME | OPT_ENGINE_FASTER | OPT_PITCH_HIGH_QUALITY;
        // time_ratio=1 (we keep 1:1 sample-rate in/out); pitch_scale = 1/tempoMultiplier
        // to correct the pitch shift from the upstream BufferSource's playbackRate.
        this.state = this.rb.rubberband_new(
          msg.sampleRate,
          this.numChannels,
          opts,
          1,
          msg.initialRatio || 1,
        );
        // Allocate a scratch buffer big enough for whatever chunks we hand back and forth.
        // AudioWorklet renders 128 frames per tick; realtime mode usually needs ~128..4096
        // depending on ratio. Reserve a generous upper bound.
        this.chunkCapacity = 8192;
        this.channelArrayPtr = this.rb.malloc(this.numChannels * 4);
        this.channelDataPtr = [];
        for (let c = 0; c < this.numChannels; c++) {
          const p = this.rb.malloc(this.chunkCapacity * 4);
          this.channelDataPtr.push(p);
          this.rb.memWritePtr(this.channelArrayPtr + c * 4, p);
        }
        this.discardRemaining = this.rb.rubberband_get_start_delay(this.state) | 0;
        this.passthrough = false;
        this.ready = true;
        this.port.postMessage({ type: 'ready', startDelaySamples: this.discardRemaining });
      } catch (err) {
        this.port.postMessage({ type: 'error', message: err?.message || String(err) });
      }
      return;
    }
    if (msg.type === 'tempo') {
      this.pendingRatio = msg.ratio;
      return;
    }
    if (msg.type === 'reset' && this.ready) {
      try {
        this.rb.rubberband_reset(this.state);
        this.discardRemaining = this.rb.rubberband_get_start_delay(this.state) | 0;
      } catch {}
    }
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    // No input connected yet (or disconnected) — emit silence, keep alive.
    const hasInput = input && input.length > 0 && input[0] && input[0].length > 0;

    // Pre-rubberband pass-through: useful for initial plumbing verification.
    if (this.passthrough || !this.ready) {
      for (let c = 0; c < output.length; c++) {
        if (hasInput && input[c]) output[c].set(input[c]);
        else output[c].fill(0);
      }
      return true;
    }

    // Apply any pending pitch-scale update before processing this block.
    if (this.pendingRatio !== null) {
      try { this.rb.rubberband_set_pitch_scale(this.state, this.pendingRatio); } catch {}
      this.pendingRatio = null;
    }

    const frames = output[0].length; // always 128 under current spec
    const ch = Math.min(this.numChannels, output.length);

    // Push this block's input into rubberband.
    if (hasInput) {
      const n = Math.min(frames, this.chunkCapacity);
      for (let c = 0; c < ch; c++) {
        const src = input[c] || input[0];
        this.rb.memWrite(this.channelDataPtr[c], src.subarray(0, n));
      }
      this.rb.rubberband_process(this.state, this.channelArrayPtr, n, 0);
    }

    // Pull up to `frames` frames of output.
    let produced = 0;
    const available = this.rb.rubberband_available(this.state);
    if (available > 0) {
      const take = Math.min(frames, available, this.chunkCapacity);
      const n = this.rb.rubberband_retrieve(this.state, this.channelArrayPtr, take);
      produced = n;
      for (let c = 0; c < ch; c++) {
        const slice = this.rb.memReadF32(this.channelDataPtr[c], n);
        // Discard startup-delay samples silently (zero-fill), then pass through.
        let writeIdx = 0;
        let readIdx = 0;
        if (this.discardRemaining > 0) {
          const drop = Math.min(this.discardRemaining, n);
          this.discardRemaining -= drop;
          readIdx = drop;
          // zero-fill the discarded portion in output
          for (let i = 0; i < drop; i++) output[c][writeIdx++] = 0;
        }
        for (; readIdx < n && writeIdx < frames; readIdx++, writeIdx++) {
          output[c][writeIdx] = slice[readIdx];
        }
        for (; writeIdx < frames; writeIdx++) output[c][writeIdx] = 0;
      }
    } else {
      // Nothing available yet — pad with silence this block.
      for (let c = 0; c < output.length; c++) output[c].fill(0);
    }
    return true;
  }
}

registerProcessor('rubberband-stretch', RubberBandProcessor);
