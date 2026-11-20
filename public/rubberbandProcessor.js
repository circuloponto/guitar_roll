// AudioWorkletProcessor that streams audio through Rubber Band (WASM) in realtime mode.
// Served verbatim from /public; loaded via AudioContext.audioWorklet.addModule().
//
// The RubberBandInterface class below is vendored from rubberband-wasm@3.3.0
// (node_modules/rubberband-wasm/dist/index.esm.js, GPLv2). AudioWorkletGlobalScope cannot
// resolve bare specifiers, so the glue class is inlined. It MUST match the installed
// rubberband.wasm exports (rb_*, wasm_malloc, _initialize) and import list (clock_time_get),
// otherwise init throws and playback silently falls back to pass-through (pitch then
// follows the tempo). Keep this copy in sync when the upstream dep version changes.
//
// Architecture: the BufferSource upstream plays at playbackRate = tempoMultiplier (time
// stretch by resampling, which also shifts pitch). This worklet keeps time_ratio = 1 and
// applies pitch_scale to cancel (or add to) that shift. Output goes through a FIFO so
// rubberband's bursty output never causes dropouts; the main thread learns the stream's
// latency (in samples) from the 'ready' message and schedules sources that much earlier.
//
// Protocol (main -> worklet):
//   { type: 'init', module, sampleRate, numChannels, initialRatio }
//   { type: 'tempo', ratio }   // pitch_scale
//   { type: 'reset' }          // flush (call on stop)
// worklet -> main: { type: 'ready', startDelaySamples, latencySamples } | { type: 'error', message }

class RubberBandInterface {
    constructor() { }
    static async initialize(module) {
        if (typeof WebAssembly === "undefined") {
            throw new Error("WebAssembly is not supported in this environment!");
        }
        let heap = {};
        const errorHandler = (...params) => {
            console.error("WASI called with params", params);
            return 52;
        };
        let printBuffer = [];
        const wasmInstance = await WebAssembly.instantiate(module, {
            env: {
                emscripten_notify_memory_growth: () => {
                    heap.HEAP8 = new Uint8Array(wasmInstance.exports.memory.buffer);
                    heap.HEAP32 = new Uint32Array(wasmInstance.exports.memory.buffer);
                },
            },
            wasi_snapshot_preview1: {
                proc_exit: (...params) => errorHandler("proc_exit", params),
                fd_read: (...params) => errorHandler("fd_read", params),
                fd_write: (fd, iov, iovcnt, pnum) => {
                    if (fd > 2)
                        return 52;
                    let num = 0;
                    for (let i = 0; i < iovcnt; i++) {
                        const ptr = heap.HEAP32[iov >> 2];
                        const len = heap.HEAP32[(iov + 4) >> 2];
                        iov += 8;
                        for (let j = 0; j < len; j++) {
                            const curr = heap.HEAP8[ptr + j];
                            if (curr === 0 || curr === 10) {
                                
                                printBuffer.length = 0;
                            }
                            else {
                                printBuffer.push(String.fromCharCode(curr));
                            }
                        }
                        num += len;
                    }
                    heap.HEAP32[pnum >> 2] = num;
                    return 0;
                },
                fd_seek: (...params) => errorHandler("fd_seek", params),
                fd_close: (...params) => errorHandler("fd_close", params),
                environ_sizes_get: (penviron_count, penviron_buf_size) => {
                    // heap.HEAP32[penviron_count >> 2] = 0;
                    // heap.HEAP32[penviron_buf_size >> 2] = 0;
                    return 52; // NO_SYS
                },
                environ_get: (...params) => errorHandler("environ_get", params),
                clock_time_get: (id, precision, ptr) => {
                    // Needed by rubberband.wasm; return the worklet clock in nanoseconds.
                    const ns = BigInt(Math.floor(currentTime * 1e9));
                    new DataView(wasmInstance.exports.memory.buffer).setBigUint64(ptr, ns, true);
                    return 0;
                },
            },
        });
        const exports = wasmInstance.exports;
        heap.HEAP8 = new Uint8Array(wasmInstance.exports.memory.buffer);
        heap.HEAP32 = new Uint32Array(wasmInstance.exports.memory.buffer);
        exports._initialize();
        const instance = { heap, exports };
        const ret = new RubberBandInterface();
        ret.wasm = instance;
        return ret;
    }
    malloc(size) {
        return this.wasm.exports.wasm_malloc(size);
    }
    memWrite(destPtr, data) {
        const uint8Array = data instanceof Uint8Array ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        this.wasm.heap.HEAP8.set(uint8Array, destPtr);
    }
    memWritePtr(destPtr, srcPtr) {
        const buf = new Uint8Array(4);
        const view = new DataView(buf.buffer);
        view.setUint32(0, srcPtr, true);
        this.wasm.heap.HEAP8.set(buf, destPtr);
    }
    memReadU8(srcPtr, length) {
        return this.wasm.heap.HEAP8.subarray(srcPtr, srcPtr + length);
    }
    memReadF32(srcPtr, length) {
        const res = this.memReadU8(srcPtr, length * 4);
        return new Float32Array(res.buffer, res.byteOffset, length);
    }
    free(ptr) {
        this.wasm.exports.wasm_free(ptr);
    }
    rubberband_new(sampleRate, channels, options, initialTimeRatio, initialPitchScale) {
        return this.wasm.exports.rb_new(sampleRate, channels, options, initialTimeRatio, initialPitchScale);
    }
    rubberband_delete(state) {
        this.wasm.exports.rb_delete(state);
    }
    rubberband_reset(state) {
        this.wasm.exports.rb_reset(state);
    }
    rubberband_set_time_ratio(state, ratio) {
        this.wasm.exports.rb_set_time_ratio(state, ratio);
    }
    rubberband_set_pitch_scale(state, scale) {
        this.wasm.exports.rb_set_pitch_scale(state, scale);
    }
    rubberband_set_formant_scale(state, scale) {
        this.wasm.exports.rb_set_formant_scale(state, scale);
    }
    rubberband_get_time_ratio(state) {
        return this.wasm.exports.rb_get_time_ratio(state);
    }
    rubberband_get_pitch_scale(state) {
        return this.wasm.exports.rb_get_pitch_scale(state);
    }
    rubberband_get_formant_scale(state) {
        return this.wasm.exports.rb_get_formant_scale(state);
    }
    rubberband_get_preferred_start_pad(state) {
        return this.wasm.exports.rb_get_preferred_start_pad(state);
    }
    rubberband_get_start_delay(state) {
        return this.wasm.exports.rb_get_start_delay(state);
    }
    rubberband_get_latency(state) {
        return this.wasm.exports.rb_get_latency(state);
    }
    rubberband_set_transients_option(state, options) {
        this.wasm.exports.rb_set_transients_option(state, options);
    }
    rubberband_set_detector_option(state, options) {
        this.wasm.exports.rb_set_detector_option(state, options);
    }
    rubberband_set_phase_option(state, options) {
        this.wasm.exports.rb_set_phase_option(state, options);
    }
    rubberband_set_formant_option(state, options) {
        this.wasm.exports.rb_set_formant_option(state, options);
    }
    rubberband_set_pitch_option(state, options) {
        this.wasm.exports.rb_set_pitch_option(state, options);
    }
    rubberband_set_expected_input_duration(state, samples) {
        this.wasm.exports.rb_set_expected_input_duration(state, samples);
    }
    rubberband_get_samples_required(state) {
        return this.wasm.exports.rb_get_samples_required(state);
    }
    rubberband_set_max_process_size(state, samples) {
        this.wasm.exports.rb_set_max_process_size(state, samples);
    }
    rubberband_get_process_size_limit(state) {
        return this.wasm.exports.rb_get_process_size_limit(state);
    }
    rubberband_set_key_frame_map(state, keyframecount, from, to) {
        this.wasm.exports.rb_set_key_frame_map(state, keyframecount, from, to);
    }
    rubberband_study(state, input, samples, final) {
        this.wasm.exports.rb_study(state, input, samples, final);
    }
    rubberband_process(state, input, samples, final) {
        this.wasm.exports.rb_process(state, input, samples, final);
    }
    rubberband_available(state) {
        return this.wasm.exports.rb_available(state);
    }
    rubberband_retrieve(state, output, samples) {
        return this.wasm.exports.rb_retrieve(state, output, samples);
    }
    rubberband_get_channel_count(state) {
        return this.wasm.exports.rb_get_channel_count(state);
    }
    rubberband_calculate_stretch(state) {
        this.wasm.exports.rb_calculate_stretch(state);
    }
    rubberband_set_debug_level(state, level) {
        this.wasm.exports.rb_set_debug_level(state, level);
    }
    rubberband_set_default_debug_level(level) {
        this.wasm.exports.rb_set_default_debug_level(level);
    }
}

const OPT_PROCESS_REALTIME = 1;
const OPT_ENGINE_FASTER = 0;
const OPT_PITCH_HIGH_QUALITY = 33554432;
const BLOCK = 128;
const FIFO_FRAMES = 1 << 16;
const PREFILL_BLOCKS = 2;         // output starts once this many blocks are buffered
const IDLE_AFTER_FRAMES = 22050;  // stop processing after this much trailing silence

class RubberBandProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ready = false;
    this.rb = null;
    this.state = 0;
    this.numChannels = 0;
    this.pendingRatio = null;
    this.chunkCapacity = 4096;
    this.channelArrayPtr = 0;
    this.channelDataPtr = [];
    this.fifo = [];
    this.fifoRead = 0;
    this.fifoCount = 0;
    this.discardRemaining = 0;
    this.started = false;
    this.idle = true;
    this.silentFrames = 0;
    this.port.onmessage = (e) => this._onMessage(e.data);
  }

  _clear() {
    this.fifoRead = 0;
    this.fifoCount = 0;
    this.started = false;
    this.silentFrames = 0;
    this.rb.rubberband_reset(this.state);
    this.discardRemaining = this.rb.rubberband_get_start_delay(this.state) | 0;
  }

  async _onMessage(msg) {
    if (!msg) return;
    if (msg.type === 'init') {
      try {
        this.numChannels = msg.numChannels || 2;
        this.rb = await RubberBandInterface.initialize(msg.module);
        const opts = OPT_PROCESS_REALTIME | OPT_ENGINE_FASTER | OPT_PITCH_HIGH_QUALITY;
        this.state = this.rb.rubberband_new(msg.sampleRate, this.numChannels, opts, 1, msg.initialRatio || 1);
        this.rb.rubberband_set_max_process_size(this.state, BLOCK);
        this.channelArrayPtr = this.rb.malloc(this.numChannels * 4);
        for (let c = 0; c < this.numChannels; c++) {
          const p = this.rb.malloc(this.chunkCapacity * 4);
          this.channelDataPtr.push(p);
          this.rb.memWritePtr(this.channelArrayPtr + c * 4, p);
          this.fifo.push(new Float32Array(FIFO_FRAMES));
        }
        this.discardRemaining = this.rb.rubberband_get_start_delay(this.state) | 0;
        const startDelay = this.discardRemaining;
        // Calibrate: feed silence block by block until output would start; that tick count
        // is the stream latency the main thread must compensate for.
        let latency = 0;
        for (let t = 1; t <= 400; t++) {
          this._pushSilence();
          this._drain();
          if (this.fifoCount >= BLOCK * PREFILL_BLOCKS) { latency = (t - 1) * BLOCK; break; }
        }
        this._clear();
        this.ready = true;
        this.idle = true;
        this.port.postMessage({ type: 'ready', startDelaySamples: startDelay, latencySamples: latency });
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
      try { this._clear(); this.idle = true; } catch {}
    }
  }

  _pushSilence() {
    for (let c = 0; c < this.numChannels; c++) {
      this.rb.memWrite(this.channelDataPtr[c], new Float32Array(BLOCK));
    }
    this.rb.rubberband_process(this.state, this.channelArrayPtr, BLOCK, 0);
  }

  _drain() {
    for (;;) {
      const available = this.rb.rubberband_available(this.state);
      if (!(available > 0)) return;
      const take = Math.min(available, this.chunkCapacity);
      const n = this.rb.rubberband_retrieve(this.state, this.channelArrayPtr, take);
      if (!(n > 0)) return;
      const drop = Math.min(this.discardRemaining, n);
      this.discardRemaining -= drop;
      for (let c = 0; c < this.numChannels; c++) {
        const slice = this.rb.memReadF32(this.channelDataPtr[c], n);
        const ring = this.fifo[c];
        let w = (this.fifoRead + this.fifoCount) % FIFO_FRAMES;
        for (let i = drop; i < n; i++) {
          ring[w] = slice[i];
          w = (w + 1) % FIFO_FRAMES;
        }
      }
      this.fifoCount = Math.min(FIFO_FRAMES, this.fifoCount + (n - drop));
    }
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const frames = output[0].length;

    // Not initialised yet: plain pass-through so nothing goes silent.
    if (!this.ready) {
      for (let c = 0; c < output.length; c++) {
        if (input && input[c]) output[c].set(input[c]); else output[c].fill(0);
      }
      return true;
    }

    const connected = input && input.length > 0 && input[0] && input[0].length > 0;
    if (connected) {
      if (this.idle) { try { this._clear(); } catch {} this.idle = false; }
      this.silentFrames = 0;
    } else {
      if (this.idle) { for (let c = 0; c < output.length; c++) output[c].fill(0); return true; }
      this.silentFrames += frames;
      if (this.silentFrames > IDLE_AFTER_FRAMES && this.fifoCount < frames) {
        try { this._clear(); } catch {}
        this.idle = true;
        for (let c = 0; c < output.length; c++) output[c].fill(0);
        return true;
      }
    }

    if (this.pendingRatio !== null) {
      try { this.rb.rubberband_set_pitch_scale(this.state, this.pendingRatio); } catch {}
      this.pendingRatio = null;
    }

    // Push this block (silence when nothing is connected, which flushes the tail).
    const n = Math.min(frames, this.chunkCapacity);
    for (let c = 0; c < this.numChannels; c++) {
      const src = connected ? (input[c] || input[0]) : null;
      this.rb.memWrite(this.channelDataPtr[c], src ? src.subarray(0, n) : new Float32Array(n));
    }
    this.rb.rubberband_process(this.state, this.channelArrayPtr, n, 0);
    this._drain();

    if (!this.started && this.fifoCount >= frames * PREFILL_BLOCKS) this.started = true;
    if (this.started && this.fifoCount >= frames) {
      for (let c = 0; c < output.length; c++) {
        const ring = this.fifo[Math.min(c, this.numChannels - 1)];
        let r = this.fifoRead;
        for (let i = 0; i < frames; i++) {
          output[c][i] = ring[r];
          r = (r + 1) % FIFO_FRAMES;
        }
      }
      this.fifoRead = (this.fifoRead + frames) % FIFO_FRAMES;
      this.fifoCount -= frames;
    } else {
      for (let c = 0; c < output.length; c++) output[c].fill(0);
    }
    return true;
  }
}

registerProcessor('rubberband-stretch', RubberBandProcessor);
