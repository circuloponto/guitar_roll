import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { getAllInstruments, playNote } from '../utils/audio';
import { getNoteBuffer } from '../utils/ultrabox';
import {
  isUltrabox, isCustomUltrabox, loadUltrabox, getUltraboxSettings, ultraboxName,
  saveCustomUltrabox, deleteCustomUltrabox, uniqueCustomId,
} from '../utils/ultrabox';

const DEFAULT_ID = 'ub:Retro/square wave';
const TYPES = [[0, 'Chip wave'], [4, 'Drumset'], [1, 'FM (4 operators)'], [11, 'FM (6 operators)'], [2, 'Noise'], [3, 'Spectrum'],
  [5, 'Harmonics'], [6, 'Pulse width'], [7, 'Picked string'], [8, 'Supersaw'], [9, 'Custom chip']];
const FILTER_TYPES = [[0, 'low-pass'], [1, 'high-pass'], [2, 'peak']];

const B = () => window.beepbox;
const names = (list) => list.map((o, i) => [i, typeof o === 'string' ? o : o.name]);

// ---- small controls ----
function Slider({ label, value, min, max, step = 1, text, onChange, disabled }) {
  return (
    <label className="ub-ctl">
      <span className="ub-ctl-name">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))} />
      <span className="ub-ctl-val">{text ?? value}</span>
    </label>
  );
}
function Select({ label, value, options, onChange }) {
  return (
    <label className="ub-ctl">
      <span className="ub-ctl-name">{label}</span>
      <select className="ub-ctl-select" value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}
function Bars({ values, max, onChange, label }) {
  const ref = useRef(null);
  const setFrom = (e) => {
    const r = ref.current.getBoundingClientRect();
    const i = Math.min(values.length - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * values.length)));
    const v = Math.round(Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height)) * max);
    if (values[i] !== v) onChange(i, v);
  };
  const down = (e) => {
    e.preventDefault();
    setFrom(e);
    const move = (ev) => setFrom(ev);
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div className="ub-bars-wrap">
      {label && <span className="ub-ctl-name">{label}</span>}
      <div className="ub-bars" ref={ref} onPointerDown={down}>
        {values.map((v, i) => <div key={i} className="ub-bar"><div style={{ height: `${(v / max) * 100}%` }} /></div>)}
      </div>
    </div>
  );
}

function Check({ label, value, onChange, title }) {
  return (
    <label className="ub-checkrow" title={title}>
      <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

// draw a 64-point waveform (custom chip)
function WaveDraw({ values, onChange }) {
  const ref = useRef(null);
  const n = values.length;
  const setFrom = (e) => {
    const r = ref.current.getBoundingClientRect();
    const i = Math.min(n - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * n)));
    const v = Math.round(Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) * -48 + 24);
    if (values[i] !== v) onChange(i, v);
  };
  const down = (e) => {
    e.preventDefault();
    setFrom(e);
    const move = (ev) => setFrom(ev);
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div className="ub-bars-wrap">
      <span className="ub-ctl-name">Waveform (drag to draw)</span>
      <div className="ub-wave" ref={ref} onPointerDown={down}>
        <svg viewBox={`0 0 ${n} 48`} preserveAspectRatio="none">
          <line x1="0" x2={n} y1="24" y2="24" className="ub-wave-zero" />
          {values.map((v, i) => <rect key={i} x={i} width="0.8" y={Math.min(24, 24 - v)} height={Math.max(0.6, Math.abs(v))} className="ub-wave-bar" />)}
        </svg>
      </div>
    </div>
  );
}

// frequency response of the filter points (drawn with the browser's own biquads, so it is an
// approximation of the engine's filters)
let graphCtx = null;
function FilterGraph({ inst, C, kind }) {
  const note = kind === 'note';
  const simple = note ? inst.noteFilterType : inst.eqFilterType;
  const f = note ? inst.noteFilter : inst.eqFilter;
  const W = 300, H = 70;
  const freqs = useMemo(() => Float32Array.from({ length: 120 }, (_, i) => 20 * 1000 ** (i / 119)), []);
  let path = '';
  try {
    if (!graphCtx) graphCtx = new OfflineAudioContext(1, 1, 44100);
    const total = new Float32Array(freqs.length).fill(1);
    const pts = [];
    if (simple) {
      const cut = note ? inst.noteFilterSimpleCut : inst.eqFilterSimpleCut;
      const peak = note ? inst.noteFilterSimplePeak : inst.eqFilterSimplePeak;
      pts.push({ type: 0, hz: 8000 * 2 ** ((cut - (C.filterSimpleCutRange - 1)) * 0.5), gain: 2 ** (peak * 0.5) });
    } else {
      for (let i = 0; i < f.controlPointCount; i++) {
        const p = f.controlPoints[i];
        pts.push({ type: p.type, hz: C.filterFreqReferenceHz * 2 ** ((p.freq - C.filterFreqReferenceSetting) * C.filterFreqStep), gain: 2 ** ((p.gain - C.filterGainCenter) * C.filterGainStep) });
      }
    }
    pts.forEach((p) => {
      const b = graphCtx.createBiquadFilter();
      b.type = p.type === 0 ? 'lowpass' : p.type === 1 ? 'highpass' : 'peaking';
      b.frequency.value = Math.min(20000, Math.max(20, p.hz));
      if (p.type === 2) b.gain.value = 20 * Math.log10(p.gain); else b.Q.value = Math.max(0, 20 * Math.log10(Math.max(0.1, p.gain)));
      const mag = new Float32Array(freqs.length);
      b.getFrequencyResponse(freqs, mag, new Float32Array(freqs.length));
      mag.forEach((m, i) => { total[i] *= m; });
    });
    path = Array.from(total).map((m, i) => {
      const db = Math.max(-36, Math.min(18, 20 * Math.log10(Math.max(1e-4, m))));
      return `${i ? 'L' : 'M'}${(i / 119) * W},${(H * (18 - db)) / 54}`;
    }).join(' ');
  } catch { /* graph is optional */ }
  return (
    <svg className="ub-graph" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <line x1="0" x2={W} y1={H / 3} y2={H / 3} className="ub-graph-zero" />
      <path d={path} className="ub-graph-line" />
    </svg>
  );
}

function FadeGraph({ inst }) {
  const W = 300, H = 40;
  const fin = Math.min(0.45, inst.getFadeInSeconds() / 2.4);
  const ticks = inst.getFadeOutTicks();
  // fade-out: negative = starts before the end, positive = lengthens the note past its end
  const body = 0.6;
  const x1 = fin * W * body / 0.6;
  const endX = ticks < 0 ? W * (body - Math.min(0.5, (-ticks) / 24) * 0.9) : W * body;
  const tail = ticks > 0 ? Math.min(W * 0.4, W * 0.4 * ticks / 96 + 6) : 6;
  return (
    <svg className="ub-graph" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <path d={`M0,${H} L${x1},2 L${Math.max(x1, endX)},2 L${Math.max(x1, endX) + tail},${H}`} className="ub-graph-fill" />
      <line x1={W * body} x2={W * body} y1="0" y2={H} className="ub-graph-zero" strokeDasharray="3 3" />
    </svg>
  );
}

// the rendered note, drawn as a waveform
function Scope({ id, rev }) {
  const ref = useRef(null);
  useEffect(() => {
    const t = setTimeout(() => {
      const cv = ref.current;
      if (!cv || !id) return;
      try {
        const ctx = graphCtx || (graphCtx = new OfflineAudioContext(1, 1, 44100));
        const buf = getNoteBuffer(ctx, id, 57, 0.5);
        const g = cv.getContext('2d');
        const w = cv.width, h = cv.height;
        g.clearRect(0, 0, w, h);
        if (!buf) return;
        const d = buf.getChannelData(0);
        const len = Math.min(d.length, Math.floor(buf.sampleRate * 0.9));
        const accent = getComputedStyle(cv).getPropertyValue('--accent-hi') || '#b06cff';
        g.strokeStyle = accent.trim() || '#b06cff';
        g.lineWidth = 1;
        g.beginPath();
        for (let x = 0; x < w; x++) {
          const a = Math.floor((x / w) * len), b = Math.floor(((x + 1) / w) * len);
          let mn = 1, mx = -1;
          for (let i = a; i < b; i++) { if (d[i] < mn) mn = d[i]; if (d[i] > mx) mx = d[i]; }
          g.moveTo(x + 0.5, h / 2 - mx * (h / 2) * 1.6);
          g.lineTo(x + 0.5, h / 2 - mn * (h / 2) * 1.6);
        }
        g.stroke();
      } catch { /* optional */ }
    }, 250);
    return () => clearTimeout(t);
  }, [id, rev]);
  return <canvas ref={ref} className="ub-scope" width={300} height={70} />;
}

function FilterEditor({ inst, C, kind, update }) {
  const note = kind === 'note';
  const typeKey = note ? 'noteFilterType' : 'eqFilterType';
  const cutKey = note ? 'noteFilterSimpleCut' : 'eqFilterSimpleCut';
  const peakKey = note ? 'noteFilterSimplePeak' : 'eqFilterSimplePeak';
  const f = note ? inst.noteFilter : inst.eqFilter;
  const hz = (fr) => Math.round(C.filterFreqReferenceHz * 2 ** ((fr - C.filterFreqReferenceSetting) * C.filterFreqStep));
  const db = (g) => ((g - C.filterGainCenter) * C.filterGainStep * 6.02).toFixed(1);
  const points = Array.from({ length: f.controlPointCount }, (_, i) => f.controlPoints[i]);
  return (
    <>
      <FilterGraph inst={inst} C={C} kind={kind} />
      <div className="ub-seg">
        <button className={!inst[typeKey] ? 'on' : ''} onClick={() => update(() => { inst[typeKey] = false; })}>Advanced</button>
        <button className={inst[typeKey] ? 'on' : ''} onClick={() => update(() => { inst[typeKey] = true; })}>Simple</button>
      </div>
      {inst[typeKey] ? (
        <>
          <Slider label="Cutoff" min={0} max={C.filterSimpleCutRange - 1} value={inst[cutKey]} onChange={(v) => update(() => { inst[cutKey] = v; })} />
          <Slider label="Peak" min={0} max={C.filterSimplePeakRange - 1} value={inst[peakKey]} onChange={(v) => update(() => { inst[peakKey] = v; })} />
        </>
      ) : (
        <>
          {points.map((p, i) => (
            <div key={i} className="ub-point">
              <select value={p.type} onChange={(e) => update(() => { p.type = Number(e.target.value); })}>
                {FILTER_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
              <Slider label="Freq" min={0} max={C.filterFreqRange - 1} value={p.freq} text={`${hz(p.freq)} Hz`} onChange={(v) => update(() => { p.freq = v; })} />
              <Slider label="Gain" min={0} max={C.filterGainRange - 1} value={p.gain} text={`${db(p.gain)} dB`} onChange={(v) => update(() => { p.gain = v; })} />
              <button className="ub-x" title="Remove this point" onClick={() => update(() => { f.controlPoints.splice(i, 1); f.controlPointCount--; })}>×</button>
            </div>
          ))}
          {f.controlPointCount < C.filterMaxPoints && (
            <button className="settings-btn-sm" onClick={() => update(() => { f.addPoint(0, Math.round(C.filterFreqRange / 2), C.filterGainCenter); })}>+ Add filter point</button>
          )}
        </>
      )}
    </>
  );
}

// The native instrument editor: it works on the engine's own Instrument object, so every control
// changes exactly what the sound engine renders.
export default function UltraboxEditor({ currentInstrument, onInstrumentChange, visible }) {
  const [ready, setReady] = useState(false);
  const [rev, setRev] = useState(0);
  const [saveName, setSaveName] = useState('');
  const [autoPreview, setAutoPreview] = useState(() => localStorage.getItem('guitar-roll-ub-autopreview') !== '0');
  const [tick, setTick] = useState(0);
  const [drum, setDrum] = useState(0);
  const instRef = useRef(null);
  const loadedId = useRef(null);
  const selfChange = useRef(null);
  const curRef = useRef(currentInstrument);
  curRef.current = currentInstrument;
  const previewTimer = useRef(null);
  const autoRef = useRef(autoPreview);
  autoRef.current = autoPreview;

  const id = isUltrabox(currentInstrument) ? currentInstrument : null;

  useEffect(() => { loadUltrabox().then(() => setReady(true)).catch(() => {}); }, []);

  // load the track's instrument into the editor model
  useEffect(() => {
    if (!ready) return;
    if (selfChange.current && selfChange.current === id) { selfChange.current = null; return; }
    if (!id) { instRef.current = null; loadedId.current = null; setRev(r => r + 1); return; }
    const settings = getUltraboxSettings(id);
    if (!settings) return;
    const b = B();
    const song = {
      format: 'UltraBox', version: 5, scale: 'Free', key: 'C', keyOctave: 0, introBars: 0, loopBars: 1,
      beatsPerBar: 8, ticksPerBeat: 4, beatsPerMinute: 120, reverb: 0, masterGain: 100,
      layeredInstruments: false, patternInstruments: false,
      channels: [{ type: 'pitch', name: '', octaveScrollBar: 0, sequence: [1],
        instruments: [Object.assign({ volume: 0 }, JSON.parse(JSON.stringify(settings)))], patterns: [{ notes: [] }] }],
    };
    const s = new b.Song();
    s.fromJsonObject(song);
    instRef.current = s.channels[0].instruments[0];
    loadedId.current = id;
    setRev(r => r + 1);
  }, [ready, id]);

  const preview = useCallback(() => {
    const cur = curRef.current;
    if (!isUltrabox(cur)) return;
    playNote(1, 3, 0.9, 0.8, cur);
    setTimeout(() => playNote(0, 5, 0.9, 0.8, cur), 380);
  }, []);

  // every change: update the model, store it as the instrument, and (optionally) play a note
  const update = useCallback((mutate) => {
    const inst = instRef.current;
    if (!inst) return;
    mutate();
    const json = inst.toJsonObject();
    delete json.customChipWaveIntegral; // the engine recomputes it from the wave
    const cur = curRef.current;
    if (isCustomUltrabox(cur)) {
      saveCustomUltrabox(cur, ultraboxName(cur), json);
    } else {
      const nid = uniqueCustomId(`${ultraboxName(cur)} (edited)`);
      saveCustomUltrabox(nid, nid.slice('ub:Custom/'.length), json);
      selfChange.current = nid;
      loadedId.current = nid;
      curRef.current = nid;
      onInstrumentChange(nid);
      setTick(x => x + 1);
    }
    setRev(r => r + 1);
    clearTimeout(previewTimer.current);
    if (autoRef.current) previewTimer.current = setTimeout(preview, 350);
  }, [onInstrumentChange, preview]);

  const groups = useMemo(() => {
    const all = getAllInstruments();
    const g = new Map();
    Object.entries(all).filter(([k]) => isUltrabox(k)).forEach(([k, v]) => {
      const name = v.group || 'UltraBox';
      if (!g.has(name)) g.set(name, []);
      g.get(name).push([k, v.label]);
    });
    return [...g.entries()].sort((a, b) => (a[0].includes('My instruments') ? -1 : b[0].includes('My instruments') ? 1 : 0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, currentInstrument]);

  const saveAs = () => {
    const name = saveName.trim();
    const inst = instRef.current;
    if (!name || !inst) return;
    const nid = uniqueCustomId(name);
    saveCustomUltrabox(nid, nid.slice('ub:Custom/'.length), inst.toJsonObject());
    selfChange.current = nid;
    curRef.current = nid;
    onInstrumentChange(nid);
    setSaveName('');
    setTick(x => x + 1);
  };
  const remove = () => {
    if (!isCustomUltrabox(id)) return;
    deleteCustomUltrabox(id);
    onInstrumentChange(DEFAULT_ID);
    setTick(x => x + 1);
  };

  const inst = instRef.current;
  const C = ready ? B().Config : null;

  const header = (
    <div className="ub-head">
      <select className="ub-picker" value={id || ''} onChange={(e) => e.target.value && onInstrumentChange(e.target.value)}>
        {!id && <option value="">Pick an UltraBox instrument…</option>}
        {groups.map(([g, list]) => (
          <optgroup key={g} label={g.replace('UltraBox · ', '')}>
            {list.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </optgroup>
        ))}
      </select>
      <button className="settings-btn" onClick={preview} disabled={!id}>Preview</button>
      <label className="ub-check" title="Play a note after each change">
        <input type="checkbox" checked={autoPreview}
          onChange={(e) => { setAutoPreview(e.target.checked); try { localStorage.setItem('guitar-roll-ub-autopreview', e.target.checked ? '1' : '0'); } catch { /* ignore */ } }} />
        Hear changes
      </label>
      <span className="ub-spacer" />
      <input className="settings-input ub-name" value={saveName} onChange={(e) => setSaveName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') saveAs(); }} placeholder="Save a copy as…" />
      <button className="settings-btn" onClick={saveAs} disabled={!saveName.trim() || !inst}>Save copy</button>
      {isCustomUltrabox(id) && <button className="settings-btn-sm danger" onClick={remove}>Delete</button>}
    </div>
  );

  if (!ready || !inst || !C) {
    return (
      <div className="ub-editor" onKeyDown={(e) => e.stopPropagation()}>
        {header}
        <p className="ub-empty">{ready ? 'Pick an UltraBox instrument to edit its parameters.' : 'Loading the sound engine…'}</p>
      </div>
    );
  }

  void rev;
  const type = inst.type;
  const set = (key) => (v) => update(() => { inst[key] = v; });
  const effectOn = (name) => (inst.effects & (1 << C.effectNames.indexOf(name))) !== 0;
  const toggleEffect = (name) => update(() => { inst.effects ^= 1 << C.effectNames.indexOf(name); });
  const setUnison = (idx) => update(() => {
    const u = C.unisons[idx];
    inst.unison = idx;
    if (u) {
      inst.unisonVoices = u.voices; inst.unisonSpread = u.spread; inst.unisonOffset = u.offset;
      inst.unisonExpression = u.expression; inst.unisonSign = u.sign;
    }
  });
  const setType = (t) => update(() => {
    const vol = inst.volume;
    inst.setTypeAndReset(t, t === 2 || t === 4, false);
    inst.volume = vol;
  });
  const targetsFor = () => {
    const out = [];
    C.instrumentAutomationTargets.forEach((t, ti) => {
      if (t.name === 'none') return;
      for (let k = 0; k < t.maxCount; k++) if (inst.supportsEnvelopeTarget(ti, k)) out.push([`${ti}:${k}`, t.maxCount > 1 ? `${t.name} ${k + 1}` : t.name]);
    });
    return out;
  };
  const envs = Array.from({ length: inst.envelopeCount }, (_, i) => inst.envelopes[i]);
  const unisonSel = <Select label="Unison" value={inst.unison} options={names(C.unisons)} onChange={setUnison} />;
  const fadeOutTicks = C.fadeOutTicks ? C.fadeOutTicks[inst.fadeOut] : inst.fadeOut;
  const fm6 = type === 11;
  const nOps = fm6 ? 6 : 4;

  return (
    <div className="ub-editor" onKeyDown={(e) => e.stopPropagation()}>
      {header}
      <div className="ub-grid">
        <section className="ub-card">
          <h4>Sound</h4>
          <Select label="Type" value={type} options={TYPES.some(([v]) => v === type) ? TYPES : [...TYPES, [type, `type ${type}`]]} onChange={setType} />
          {type === 0 && <Select label="Wave" value={inst.chipWave} options={names(C.chipWaves)} onChange={set('chipWave')} />}
          {type === 2 && <Select label="Noise" value={inst.chipNoise} options={names(C.chipNoises)} onChange={set('chipNoise')} />}
          {type === 0 && (() => {
            const raw = C.rawChipWaves[inst.chipWave];
            const len = raw && raw.samples ? raw.samples.length : 0;
            return (
              <>
                <Check label="Loop controls" value={inst.isUsingAdvancedLoopControls} onChange={(v) => update(() => { inst.isUsingAdvancedLoopControls = v; })} />
                {inst.isUsingAdvancedLoopControls && len > 0 && (
                  <>
                    <Select label="Loop mode" value={inst.chipWaveLoopMode} options={[[0, 'loop'], [1, 'ping-pong'], [2, 'play once'], [3, 'play loop once']]} onChange={set('chipWaveLoopMode')} />
                    <Slider label="Loop start" min={0} max={len} value={Math.min(inst.chipWaveLoopStart, len)} onChange={set('chipWaveLoopStart')} />
                    <Slider label="Loop end" min={0} max={len} value={Math.min(inst.chipWaveLoopEnd, len)} onChange={set('chipWaveLoopEnd')} />
                    <Slider label="Start offset" min={0} max={len} value={Math.min(inst.chipWaveStartOffset, len)} onChange={set('chipWaveStartOffset')} />
                    <Check label="Play backwards" value={inst.chipWavePlayBackwards} onChange={set('chipWavePlayBackwards')} />
                  </>
                )}
              </>
            );
          })()}
          {type === 9 && (
            <WaveDraw values={Array.from(inst.customChipWave)}
              onChange={(i, v) => update(() => { inst.customChipWave[i] = v; })} />
          )}
          {type === 4 && (() => {
            const dr = Math.min(11, drum);
            return (
              <>
                <div className="ub-drums">
                  {Array.from({ length: 12 }, (_, i) => (
                    <button key={i} className={`ub-chip${i === dr ? ' on' : ''}`} onClick={() => setDrum(i)}>{i + 1}</button>
                  ))}
                </div>
                <Bars label={`Drum ${dr + 1} spectrum`} values={Array.from(inst.drumsetSpectrumWaves[dr].spectrum).slice(0, C.spectrumControlPoints)} max={C.spectrumMax}
                  onChange={(i, v) => update(() => { inst.drumsetSpectrumWaves[dr].spectrum[i] = v; })} />
                <Select label="Envelope" value={inst.drumsetEnvelopes[dr]} options={names(C.envelopes)} onChange={(v) => update(() => { inst.drumsetEnvelopes[dr] = v; })} />
              </>
            );
          })()}
          {[0, 2, 9].includes(type) && <Check label="Aliasing" title="Skip the smoothing so the wave sounds crunchy and retro" value={inst.aliases} onChange={set('aliases')} />}
          {type === 3 && (
            <Bars label="Spectrum" values={Array.from(inst.spectrumWave.spectrum).slice(0, C.spectrumControlPoints)} max={C.spectrumMax}
              onChange={(i, v) => update(() => { inst.spectrumWave.spectrum[i] = v; inst.spectrumWave.markCustomWaveDirty?.(); })} />
          )}
          {(type === 5 || type === 7) && (
            <Bars label="Harmonics" values={Array.from(inst.harmonicsWave.harmonics).slice(0, C.harmonicsControlPoints)} max={C.harmonicsMax}
              onChange={(i, v) => update(() => { inst.harmonicsWave.harmonics[i] = v; inst.harmonicsWave.markCustomWaveDirty?.(); })} />
          )}
          {type === 7 && (
            <>
              <Slider label="Sustain" min={0} max={C.stringSustainRange - 1} value={inst.stringSustain} onChange={set('stringSustain')} />
              <Select label="Sustain type" value={inst.stringSustainType} options={[[0, 'bright'], [1, 'acoustic']]} onChange={set('stringSustainType')} />
            </>
          )}
          {(type === 6 || type === 8) && (
            <>
              <Slider label="Pulse width" min={1} max={C.pulseWidthRange} value={inst.pulseWidth} onChange={set('pulseWidth')} />
              <Slider label="Fine width" min={0} max={99} value={inst.decimalOffset} onChange={set('decimalOffset')} />
            </>
          )}
          {type === 8 && (
            <>
              <Slider label="Dynamism" min={0} max={C.supersawDynamismMax} value={inst.supersawDynamism} onChange={set('supersawDynamism')} />
              <Slider label="Spread" min={0} max={C.supersawSpreadMax} value={inst.supersawSpread} onChange={set('supersawSpread')} />
              <Slider label="Shape" min={0} max={C.supersawShapeMax} value={inst.supersawShape} onChange={set('supersawShape')} />
            </>
          )}
          {[0, 5, 7, 9, 6, 2, 3].includes(type) && (
            <>
              {unisonSel}
              <details className="ub-details">
                <summary>Custom unison</summary>
                <Slider label="Voices" min={C.unisonVoicesMin} max={C.unisonVoicesMax} value={inst.unisonVoices} onChange={set('unisonVoices')} />
                <Slider label="Spread" min={C.unisonSpreadMin} max={C.unisonSpreadMax} step={0.01} value={inst.unisonSpread} onChange={set('unisonSpread')} />
                <Slider label="Offset" min={C.unisonOffsetMin} max={C.unisonOffsetMax} step={0.01} value={inst.unisonOffset} onChange={set('unisonOffset')} />
                <Slider label="Expression" min={C.unisonExpressionMin} max={C.unisonExpressionMax} step={0.01} value={inst.unisonExpression} onChange={set('unisonExpression')} />
                <Slider label="Sign" min={C.unisonSignMin} max={C.unisonSignMax} step={0.05} value={inst.unisonSign} onChange={set('unisonSign')} />
              </details>
            </>
          )}
        </section>

        {(type === 1 || type === 11) && (
          <section className="ub-card">
            <h4>FM operators</h4>
            {fm6
              ? <Select label="Algorithm" value={inst.algorithm6Op} options={names(C.algorithms6Op)} onChange={set('algorithm6Op')} />
              : <Select label="Algorithm" value={inst.algorithm} options={names(C.algorithms)} onChange={set('algorithm')} />}
            {fm6
              ? <Select label="Feedback" value={inst.feedbackType6Op} options={names(C.feedbacks6Op)} onChange={set('feedbackType6Op')} />
              : <Select label="Feedback" value={inst.feedbackType} options={names(C.feedbacks)} onChange={set('feedbackType')} />}
            <Slider label="Feedback vol" min={0} max={C.operatorAmplitudeMax} value={inst.feedbackAmplitude} onChange={set('feedbackAmplitude')} />
            {Array.from({ length: nOps }, (_, i) => {
              const op = inst.operators[i];
              return (
                <div key={i} className="ub-op">
                  <span className="ub-op-n">{i + 1}</span>
                  <select value={op.frequency} onChange={(e) => update(() => { op.frequency = Number(e.target.value); })}>
                    {names(C.operatorFrequencies).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                  {fm6 && (
                    <select value={op.waveform} onChange={(e) => update(() => { op.waveform = Number(e.target.value); })}>
                      {names(C.operatorWaves).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  )}
                  <Slider label="Vol" min={0} max={C.operatorAmplitudeMax} value={op.amplitude} onChange={(v) => update(() => { op.amplitude = v; })} />
                </div>
              );
            })}
          </section>
        )}

        {fm6 && (inst.algorithm6Op === 0 || inst.feedbackType6Op === 0) && (
          <section className="ub-card">
            <h4>Custom routing</h4>
            {inst.algorithm6Op === 0 && (() => {
              const ca = inst.customAlgorithm;
              const toggle = (row, m) => update(() => {
                const mb = ca.modulatedBy.map(a => [...a]);
                mb[row] = mb[row].includes(m) ? mb[row].filter(x => x !== m) : [...mb[row], m].sort((a, b) => a - b);
                ca.set(ca.carrierCount, mb);
              });
              return (
                <>
                  <Slider label="Carriers" min={1} max={6} value={ca.carrierCount}
                    onChange={(v) => update(() => { ca.set(v, ca.modulatedBy.map((a, r) => a.filter(m => m > v && m > r + 1))); })} />
                  <span className="ub-ctl-name">Operator (row) is modulated by (column)</span>
                  <div className="ub-matrix">
                    {Array.from({ length: 6 }, (_, r) => (
                      <div key={r} className="ub-matrix-row">
                        <span className="ub-op-n">{r + 1}{r < ca.carrierCount ? '·' : ''}</span>
                        {Array.from({ length: 6 }, (_, c) => {
                          const m = c + 1;
                          const ok = m > r + 1 && m > ca.carrierCount;
                          return <input key={c} type="checkbox" disabled={!ok} checked={ca.modulatedBy[r].includes(m)} onChange={() => toggle(r, m)} />;
                        })}
                      </div>
                    ))}
                  </div>
                </>
              );
            })()}
            {inst.feedbackType6Op === 0 && (() => {
              const cf = inst.customFeedbackType;
              const toggle = (row, m) => update(() => {
                const ix = cf.indices.map(a => [...a]);
                ix[row] = ix[row].includes(m) ? ix[row].filter(x => x !== m) : [...ix[row], m].sort((a, b) => a - b);
                cf.set(ix);
              });
              return (
                <>
                  <span className="ub-ctl-name">Feedback: operator (row) receives (column)</span>
                  <div className="ub-matrix">
                    {Array.from({ length: 6 }, (_, r) => (
                      <div key={r} className="ub-matrix-row">
                        <span className="ub-op-n">{r + 1}</span>
                        {Array.from({ length: 6 }, (_, c) => (
                          <input key={c} type="checkbox" checked={cf.indices[r].includes(c + 1)} onChange={() => toggle(r, c + 1)} />
                        ))}
                      </div>
                    ))}
                  </div>
                </>
              );
            })()}
          </section>
        )}

        <section className="ub-card">
          <h4>Level &amp; fade</h4>
          <Slider label="Volume" min={-C.volumeRange / 2} max={C.volumeRange / 2} value={inst.volume} onChange={set('volume')} />
          <Slider label="Fade in" min={0} max={C.fadeInRange - 1} value={inst.fadeIn}
            text={`${(inst.getFadeInSeconds() * 1000).toFixed(0)} ms`} onChange={set('fadeIn')} />
          <Slider label="Fade out" min={0} max={C.fadeOutTicks ? C.fadeOutTicks.length - 1 : 10} value={inst.fadeOut}
            text={`${fadeOutTicks} ticks`} onChange={set('fadeOut')} />
          <FadeGraph inst={inst} />
        </section>

        <section className="ub-card">
          <h4>Output</h4>
          <Scope id={id} rev={rev} />
          <p className="ub-note">The rendered note (about half a second, middle C-ish).</p>
        </section>

        <section className="ub-card">
          <h4>EQ filter</h4>
          <FilterEditor inst={inst} C={C} kind="eq" update={update} />
        </section>

        <section className="ub-card ub-effects">
          <h4>Effects</h4>
          <div className="ub-chips">
            {C.effectOrder.map((i) => {
              const n = C.effectNames[i];
              return <button key={n} className={`ub-chip${effectOn(n) ? ' on' : ''}`} onClick={() => toggleEffect(n)}>{n}</button>;
            })}
          </div>
          {effectOn('transition type') && (
            <>
              <Select label="Transition" value={inst.transition} options={names(C.transitions)} onChange={set('transition')} />
              <Check label="Clickless" title="Avoid clicks when a note starts" value={inst.clicklessTransition} onChange={set('clicklessTransition')} />
            </>
          )}
          {effectOn('chord type') && (
            <>
              <Select label="Chord" value={inst.chord} options={names(C.chords)} onChange={set('chord')} />
              {inst.chord === 2 && (
                <>
                  <Slider label="Arp speed" min={0} max={50} value={inst.arpeggioSpeed} onChange={set('arpeggioSpeed')} />
                  <Check label="Fast two-note arpeggio" value={inst.fastTwoNoteArp} onChange={set('fastTwoNoteArp')} />
                </>
              )}
            </>
          )}
          {effectOn('vibrato') && (
            <>
              <Select label="Vibrato" value={inst.vibrato} options={[...names(C.vibratos), [C.vibratos.length, 'custom']]} onChange={set('vibrato')} />
              {inst.vibrato === C.vibratos.length && (
                <>
                  <Slider label="Depth" min={0} max={2} step={0.01} value={inst.vibratoDepth} onChange={set('vibratoDepth')} />
                  <Slider label="Speed" min={0} max={30} step={0.1} value={inst.vibratoSpeed} onChange={set('vibratoSpeed')} />
                  <Slider label="Delay" min={0} max={50} step={0.5} value={inst.vibratoDelay} onChange={set('vibratoDelay')} />
                  <Select label="Vibrato type" value={inst.vibratoType} options={names(C.vibratoTypes)} onChange={set('vibratoType')} />
                </>
              )}
            </>
          )}
          {effectOn('pitch shift') && <Slider label="Pitch shift" min={0} max={C.pitchShiftRange - 1} value={inst.pitchShift} text={`${inst.pitchShift - C.pitchShiftCenter} st`} onChange={set('pitchShift')} />}
          {effectOn('detune') && <Slider label="Detune" min={C.detuneMin} max={C.detuneMax} value={inst.detune} text={`${inst.detune - C.detuneCenter} c`} onChange={set('detune')} />}
          {effectOn('panning') && (
            <>
              <Slider label="Pan" min={0} max={C.panMax} value={inst.pan} text={inst.pan === 50 ? 'centre' : inst.pan < 50 ? `L ${50 - inst.pan}` : `R ${inst.pan - 50}`} onChange={set('pan')} />
              <Slider label="Pan delay" min={0} max={20} value={inst.panDelay} onChange={set('panDelay')} />
            </>
          )}
          {effectOn('distortion') && <Slider label="Distortion" min={0} max={C.distortionRange - 1} value={inst.distortion} onChange={set('distortion')} />}
          {effectOn('bitcrusher') && (
            <>
              <Slider label="Crush freq" min={0} max={C.bitcrusherFreqRange - 1} value={inst.bitcrusherFreq} onChange={set('bitcrusherFreq')} />
              <Slider label="Crush bits" min={0} max={C.bitcrusherQuantizationRange - 1} value={inst.bitcrusherQuantization} onChange={set('bitcrusherQuantization')} />
            </>
          )}
          {effectOn('chorus') && <Slider label="Chorus" min={0} max={C.chorusRange - 1} value={inst.chorus} onChange={set('chorus')} />}
          {effectOn('echo') && (
            <>
              <Slider label="Echo sustain" min={0} max={C.echoSustainRange - 1} value={inst.echoSustain} onChange={set('echoSustain')} />
              <Slider label="Echo delay" min={0} max={C.echoDelayRange - 1} value={inst.echoDelay} onChange={set('echoDelay')} />
            </>
          )}
          {effectOn('reverb') && <Slider label="Reverb" min={0} max={C.reverbRange - 1} value={inst.reverb} onChange={set('reverb')} />}
        </section>

        {effectOn('note filter') && (
          <section className="ub-card">
            <h4>Note filter</h4>
            <FilterEditor inst={inst} C={C} kind="note" update={update} />
          </section>
        )}

        <section className="ub-card">
          <h4>Envelopes</h4>
          {envs.map((e, i) => (
            <div key={i} className="ub-env">
              <select value={`${e.target}:${e.index}`}
                onChange={(ev) => { const [t, k] = ev.target.value.split(':').map(Number); update(() => { e.target = t; e.index = k; }); }}>
                {(() => {
                  const opts = targetsFor();
                  const cur = `${e.target}:${e.index}`;
                  return (opts.some(([v]) => v === cur) ? opts : [[cur, C.instrumentAutomationTargets[e.target]?.name || 'none'], ...opts])
                    .map(([v, l]) => <option key={v} value={v}>{l}</option>);
                })()}
              </select>
              <select value={e.envelope} onChange={(ev) => update(() => { e.envelope = Number(ev.target.value); })}>
                {names(C.envelopes).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
              <button className="ub-x" title="Remove this envelope" onClick={() => update(() => { inst.envelopes.splice(i, 1); inst.envelopeCount--; })}>×</button>
            </div>
          ))}
          {inst.envelopeCount < C.maxEnvelopeCount && (
            <button className="settings-btn-sm" onClick={() => update(() => {
              const vol = C.instrumentAutomationTargets.findIndex(t => t.name === 'noteVolume');
              const punch = C.envelopes.findIndex(x => x.name === 'punch');
              inst.addEnvelope(vol, 0, punch < 0 ? 1 : punch);
            })}>+ Add envelope</button>
          )}
          {!envs.length && <p className="ub-note">Envelopes make a parameter change over the length of each note.</p>}
          <Slider label="Env speed" min={0} max={50} value={inst.envelopeSpeed} onChange={set('envelopeSpeed')} />
          <Check label="Discrete envelopes" title="Step the envelopes instead of gliding" value={inst.discreteEnvelope} onChange={set('discreteEnvelope')} />
        </section>
      </div>
    </div>
  );
}
