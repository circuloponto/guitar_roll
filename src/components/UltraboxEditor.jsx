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
const CLIP_KEY = 'guitar-roll-ub-clipboard';

const B = () => window.beepbox;
const names = (list) => list.map((o, i) => [i, typeof o === 'string' ? o : o.name]);

// ---- the UltraBox instrument column: label on the left, control on the right ----
function Row({ label, children, className = '' }) {
  return (
    <div className={`ubx-row ${className}`}>
      <span className="ubx-label">{label}</span>
      <div className="ubx-ctl">{children}</div>
    </div>
  );
}
function Slide({ value, min, max, step = 1, onChange, title, carrier }) {
  return (
    <input
      type="range" className={`ubx-slider${carrier ? ' carrier' : ''}`} min={min} max={max} step={step} value={value} title={title ?? String(value)}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  );
}
function Sel({ value, options, onChange, groups, className = '' }) {
  return (
    <select className={`ubx-select ${className}`} value={value} onChange={(e) => onChange(e.target.value)}>
      {groups
        ? groups.map(([g, list]) => (<optgroup key={g} label={g}>{list.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</optgroup>))
        : options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
}
function Seg({ options, value, onChange }) {
  return (
    <div className="ubx-seg">
      {options.map(([v, l]) => <button key={String(v)} className={value === v ? 'on' : ''} onClick={() => onChange(v)}>{l}</button>)}
    </div>
  );
}
function Tick({ label, value, onChange, title }) {
  return (
    <label className="ubx-tick" title={title}>
      <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}
function Pill({ children, onClick, title, on }) {
  return <button className={`ubx-pill${on ? ' on' : ''}`} onClick={onClick} title={title}>{children}</button>;
}
function SecHead({ title, children }) {
  return <div className="ubx-sechead"><span>{title}</span><div>{children}</div></div>;
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
function responsePath(inst, C, kind, W, H) {
  const note = kind === 'note';
  const simple = note ? inst.noteFilterType : inst.eqFilterType;
  const f = note ? inst.noteFilter : inst.eqFilter;
  const freqs = Float32Array.from({ length: 120 }, (_, i) => 20 * 1000 ** (i / 119));
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
  return Array.from(total).map((m, i) => {
    const db = Math.max(-36, Math.min(18, 20 * Math.log10(Math.max(1e-4, m))));
    return `${i ? 'L' : 'M'}${(i / 119) * W},${(H * (18 - db)) / 54}`;
  }).join(' ');
}

// The EQ / note filter graph: the curve, with a draggable dot for every filter point.
// Drag a dot to move it, double-click empty space to add one, right-click a dot to remove it.
function FilterGraph({ inst, C, kind, update }) {
  const note = kind === 'note';
  const f = note ? inst.noteFilter : inst.eqFilter;
  const ref = useRef(null);
  const [sel, setSel] = useState(null);
  const W = 240, H = 72;
  const simple = note ? inst.noteFilterType : inst.eqFilterType;
  let path = '';
  try { path = responsePath(inst, C, kind, W, H); } catch { /* the curve is optional */ }
  const px = (p) => ({ x: (p.freq / (C.filterFreqRange - 1)) * W, y: ((C.filterGainRange - 1 - p.gain) / (C.filterGainRange - 1)) * H });
  const points = simple ? [] : Array.from({ length: f.controlPointCount }, (_, i) => ({ i, p: f.controlPoints[i] }));
  const local = (e) => { const r = ref.current.getBoundingClientRect(); return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H }; };
  const toFG = (x, y) => ({
    freq: Math.max(0, Math.min(C.filterFreqRange - 1, Math.round((x / W) * (C.filterFreqRange - 1)))),
    gain: Math.max(0, Math.min(C.filterGainRange - 1, Math.round((1 - y / H) * (C.filterGainRange - 1)))),
  });
  const hit = (x, y) => points.find(({ p }) => { const q = px(p); return Math.hypot(q.x - x, q.y - y) < 8; });
  const down = (e) => {
    if (simple) return;
    const { x, y } = local(e);
    const h = hit(x, y);
    if (e.button === 2) { if (h) { e.preventDefault(); update(() => { f.controlPoints.splice(h.i, 1); f.controlPointCount--; }); setSel(null); } return; }
    if (!h) { setSel(null); return; }
    setSel(h.i);
    e.preventDefault();
    const move = (ev) => {
      const l = local(ev); const v = toFG(l.x, l.y);
      update(() => { f.controlPoints[h.i].freq = v.freq; f.controlPoints[h.i].gain = v.gain; });
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  const dbl = (e) => {
    if (simple) return;
    const { x, y } = local(e);
    if (hit(x, y) || f.controlPointCount >= C.filterMaxPoints) return;
    const v = toFG(x, y);
    update(() => { f.addPoint(2, v.freq, v.gain); });
    setSel(f.controlPointCount - 1);
  };
  const colours = ['var(--accent-hi)', 'var(--amber)', 'var(--fg)'];
  const cur = sel != null && !simple && sel < f.controlPointCount ? f.controlPoints[sel] : null;
  return (
    <div className="ubx-graphwrap">
      <svg ref={ref} className="ubx-graph" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"
        onPointerDown={down} onDoubleClick={dbl} onContextMenu={(e) => e.preventDefault()}>
        <line x1="0" x2={W} y1={H / 3} y2={H / 3} className="ubx-graph-zero" />
        <path d={path} className="ubx-graph-line" />
        {points.map(({ i, p }) => { const q = px(p); return <circle key={i} cx={q.x} cy={q.y} r={sel === i ? 5 : 4} fill={colours[p.type]} stroke="#000" strokeWidth="1" vectorEffect="non-scaling-stroke" />; })}
      </svg>
      {cur && (
        <div className="ubx-pointbar">
          <Sel value={cur.type} options={FILTER_TYPES} onChange={(v) => update(() => { cur.type = Number(v); })} />
          <Pill onClick={() => { update(() => { f.controlPoints.splice(sel, 1); f.controlPointCount--; }); setSel(null); }} title="Remove this point">×</Pill>
        </div>
      )}
    </div>
  );
}

// the fade in / fade out shape: drag the two markers
function FadeEditor({ inst, C, update }) {
  const ref = useRef(null);
  const W = 240, H = 40;
  const nOut = C.fadeOutTicks ? C.fadeOutTicks.length : 11;
  const inX = (inst.fadeIn / (C.fadeInRange - 1)) * W * 0.4;
  const outX = W * 0.5 + (inst.fadeOut / (nOut - 1)) * W * 0.5;
  const noteEnd = W * 0.75;
  const drag = (which) => (e) => {
    e.preventDefault(); e.stopPropagation();
    const move = (ev) => {
      const r = ref.current.getBoundingClientRect();
      const x = ((ev.clientX - r.left) / r.width) * W;
      if (which === 'in') update(() => { inst.fadeIn = Math.max(0, Math.min(C.fadeInRange - 1, Math.round((x / (W * 0.4)) * (C.fadeInRange - 1)))); });
      else update(() => { inst.fadeOut = Math.max(0, Math.min(nOut - 1, Math.round(((x - W * 0.5) / (W * 0.5)) * (nOut - 1)))); });
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  const ticks = C.fadeOutTicks ? C.fadeOutTicks[inst.fadeOut] : inst.fadeOut;
  return (
    <svg ref={ref} className="ubx-graph ubx-fade" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <path d={`M0,${H - 3} L${inX},4 L${outX},4 L${W - 4},${H - 3} Z`} className="ubx-fade-fill" />
      <line x1={noteEnd} x2={noteEnd} y1="0" y2={H} className="ubx-graph-zero" strokeDasharray="3 3" />
      <rect x={inX - 3} y="0" width="6" height={H} className="ubx-handle" onPointerDown={drag('in')}>
        <title>{`Fade in: ${(inst.getFadeInSeconds() * 1000).toFixed(0)} ms`}</title>
      </rect>
      <rect x={outX - 3} y="0" width="6" height={H} className="ubx-handle" onPointerDown={drag('out')}>
        <title>{`Fade out: ${ticks} ticks`}</title>
      </rect>
    </svg>
  );
}

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

export default function UltraboxEditor({ currentInstrument, onInstrumentChange }) {
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


  // build an editable instrument from stored parameters
  const buildInst = (settings) => {
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
    return s.channels[0].instruments[0];
  };
  // from a non-UltraBox instrument: make a new instrument of the chosen base type and use it
  const startFromType = (t) => {
    const base = getUltraboxSettings(DEFAULT_ID);
    if (!base || !ready) return;
    const i = buildInst(base);
    i.setTypeAndReset(t, t === 2 || t === 4, false);
    const nid = uniqueCustomId('New instrument');
    saveCustomUltrabox(nid, nid.slice('ub:Custom/'.length), i.toJsonObject());
    selfChange.current = null;
    onInstrumentChange(nid);
    setTick(x => x + 1);
  };
  const [clipMsg, setClipMsg] = useState('');
  const copyInstrument = async () => {
    const inst0 = instRef.current;
    if (!inst0) return;
    const text = JSON.stringify(inst0.toJsonObject());
    try { localStorage.setItem(CLIP_KEY, text); } catch { /* ignore */ }
    try { await navigator.clipboard.writeText(text); } catch { /* the in-app copy still works */ }
    setClipMsg('Copied');
    setTimeout(() => setClipMsg(''), 1200);
  };
  const pasteInstrument = async () => {
    let text = '';
    try { text = await navigator.clipboard.readText(); } catch { /* fall back to the in-app copy */ }
    let obj = null;
    const tryParse = (t) => { try { const o = JSON.parse(t); return o && typeof o === 'object' && o.type ? o : null; } catch { return null; } };
    obj = tryParse(text) || tryParse(localStorage.getItem(CLIP_KEY) || '');
    if (!obj) { setClipMsg('Nothing to paste'); setTimeout(() => setClipMsg(''), 1200); return; }
    instRef.current = buildInst(obj);
    update(() => {});
    setClipMsg('Pasted');
    setTimeout(() => setClipMsg(''), 1200);
  };
  const [openEffects, setOpenEffects] = useState(false);
  const [openPan, setOpenPan] = useState(false);
  const [openEnv, setOpenEnv] = useState(false);
  const [openUnison, setOpenUnison] = useState(false);

  const header = (
    <div className="ub-head">
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

  // the preset picker also holds the base instrument types, like UltraBox's "Type" menu
  const typeGroups = [['Instrument types', TYPES.map(([v, l]) => [`type:${v}`, l])], ...groups.map(([g, list]) => [g.replace('UltraBox · ', ''), list])];

  if (!ready || !inst || !C) {
    return (
      <div className="ub-editor" onKeyDown={(e) => e.stopPropagation()}>
        {header}
        <div className="ubx">
          <Row label="Type:">
            <Sel
              value={id || ''}
              groups={[['Pick an instrument', [['', 'Pick an UltraBox instrument…']]], ...typeGroups]}
              onChange={(v) => {
                if (!v) return;
                if (v.startsWith('type:')) startFromType(Number(v.slice(5)));
                else onInstrumentChange(v);
              }}
            />
          </Row>
        </div>
        <p className="ub-empty">{ready ? 'Pick an UltraBox instrument to edit its parameters.' : 'Loading the sound engine…'}</p>
      </div>
    );
  }

  void rev;
  const type = inst.type;
  const set = (key) => (v) => update(() => { inst[key] = v; });
  const setN = (key) => (v) => update(() => { inst[key] = Number(v); });
  const effBit = (name) => 1 << C.effectNames.indexOf(name);
  const effectOn = (name) => (inst.effects & effBit(name)) !== 0;
  const toggleEffect = (name) => update(() => { inst.effects ^= effBit(name); });
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
  const fm6 = type === 11;
  const nOps = fm6 ? 6 : 4;
  const carriers = fm6 ? (inst.algorithm6Op === 0 ? inst.customAlgorithm.carrierCount : (C.algorithms6Op[inst.algorithm6Op]?.carrierCount ?? 1)) : (C.algorithms[inst.algorithm]?.carrierCount ?? 1);
  const panOn = effectOn('panning');
  const simpleEq = inst.eqFilterType;
  const simpleNote = inst.noteFilterType;
  const showUnison = [0, 5, 7, 9, 6, 2, 3].includes(type);
  const typeValue = isUltrabox(id) ? id : '';

  return (
    <div className="ub-editor" onKeyDown={(e) => e.stopPropagation()}>
      {header}
      <div className="ub-body">
        <div className="ubx">
          <div className="ubx-copypaste">
            <button className="ubx-bigbtn" onClick={copyInstrument}>{clipMsg === 'Copied' ? 'Copied' : 'Copy'}</button>
            <button className="ubx-bigbtn" onClick={pasteInstrument}>{clipMsg === 'Pasted' || clipMsg === 'Nothing to paste' ? clipMsg : 'Paste'}</button>
          </div>

          <Row label="Type:">
            <Sel value={typeValue} groups={typeGroups}
              onChange={(v) => { if (v.startsWith('type:')) setType(Number(v.slice(5))); else if (v) onInstrumentChange(v); }} />
          </Row>

          <Row label="Volume:" className="ubx-numrow">
            <input className="ubx-num" type="number" min={-C.volumeRange / 2} max={C.volumeRange / 2} value={inst.volume}
              onChange={(e) => { const v = Math.max(-C.volumeRange / 2, Math.min(C.volumeRange / 2, Math.round(Number(e.target.value) || 0))); update(() => { inst.volume = v; }); }} />
            <Slide min={-C.volumeRange / 2} max={C.volumeRange / 2} value={inst.volume} onChange={set('volume')} title={`Volume ${inst.volume}`} />
          </Row>
          <Row label="Pan:" className="ubx-numrow">
            <input className="ubx-num" type="number" min={0} max={C.panMax} value={inst.pan}
              onChange={(e) => { const v = Math.max(0, Math.min(C.panMax, Math.round(Number(e.target.value) || 0))); update(() => { inst.pan = v; inst.effects |= effBit('panning'); }); }} />
            <Pill onClick={() => setOpenPan(o => !o)} title="Pan delay">▾</Pill>
            <Slide min={0} max={C.panMax} value={inst.pan} onChange={(v) => update(() => { inst.pan = v; inst.effects |= effBit('panning'); })} title={panOn ? `Pan ${inst.pan}` : 'Move to turn panning on'} />
          </Row>
          {openPan && (
            <Row label="Pan Delay:"><Slide min={0} max={20} value={inst.panDelay} onChange={(v) => update(() => { inst.panDelay = v; inst.effects |= effBit('panning'); })} /></Row>
          )}

          <Row label="EQ Filt.Type:">
            <Seg value={simpleEq ? 'simple' : 'advanced'} options={[['simple', 'simple'], ['advanced', 'advanced']]} onChange={(v) => update(() => { inst.eqFilterType = v === 'simple'; })} />
          </Row>
          {simpleEq ? (
            <>
              <Row label="Filter Cut:"><Slide min={0} max={C.filterSimpleCutRange - 1} value={inst.eqFilterSimpleCut} onChange={set('eqFilterSimpleCut')} /></Row>
              <Row label="Filter Peak:"><Slide min={0} max={C.filterSimplePeakRange - 1} value={inst.eqFilterSimplePeak} onChange={set('eqFilterSimplePeak')} /></Row>
            </>
          ) : (
            <Row label="EQ Filt:" className="ubx-graphrow">
              <Pill title="Add a filter point" onClick={() => { if (inst.eqFilter.controlPointCount < C.filterMaxPoints) update(() => { inst.eqFilter.addPoint(0, Math.round(C.filterFreqRange / 2), C.filterGainCenter); }); }}>+</Pill>
              <FilterGraph inst={inst} C={C} kind="eq" update={update} />
            </Row>
          )}

          <Row label="Fade:" className="ubx-graphrow"><FadeEditor inst={inst} C={C} update={update} /></Row>

          {/* what this instrument type is made of */}
          {type === 0 && (
            <>
              <Row label="Wave:"><Sel value={inst.chipWave} options={names(C.chipWaves)} onChange={setN('chipWave')} /></Row>
              {(() => {
                const raw = C.rawChipWaves[inst.chipWave];
                const len = raw && raw.samples ? raw.samples.length : 0;
                return (
                  <>
                    <Row label="Loop Controls:"><Tick label="" value={inst.isUsingAdvancedLoopControls} onChange={(v) => update(() => { inst.isUsingAdvancedLoopControls = v; })} /></Row>
                    {inst.isUsingAdvancedLoopControls && len > 0 && (
                      <>
                        <Row label="Loop Mode:"><Sel value={inst.chipWaveLoopMode} options={[[0, 'loop'], [1, 'ping-pong'], [2, 'play once'], [3, 'play loop once']]} onChange={setN('chipWaveLoopMode')} /></Row>
                        <Row label="Loop Start:"><Slide min={0} max={len} value={Math.min(inst.chipWaveLoopStart, len)} onChange={set('chipWaveLoopStart')} /></Row>
                        <Row label="Loop End:"><Slide min={0} max={len} value={Math.min(inst.chipWaveLoopEnd, len)} onChange={set('chipWaveLoopEnd')} /></Row>
                        <Row label="Offset:"><Slide min={0} max={len} value={Math.min(inst.chipWaveStartOffset, len)} onChange={set('chipWaveStartOffset')} /></Row>
                        <Row label="Backwards:"><Tick label="" value={inst.chipWavePlayBackwards} onChange={set('chipWavePlayBackwards')} /></Row>
                      </>
                    )}
                  </>
                );
              })()}
            </>
          )}
          {type === 2 && <Row label="Noise:"><Sel value={inst.chipNoise} options={names(C.chipNoises)} onChange={setN('chipNoise')} /></Row>}
          {type === 9 && (
            <Row label="Wave:" className="ubx-graphrow">
              <WaveDraw values={Array.from(inst.customChipWave)} onChange={(i, v) => update(() => { inst.customChipWave[i] = v; })} />
            </Row>
          )}
          {type === 3 && (
            <Row label="Spectrum:" className="ubx-graphrow">
              <Bars values={Array.from(inst.spectrumWave.spectrum).slice(0, C.spectrumControlPoints)} max={C.spectrumMax}
                onChange={(i, v) => update(() => { inst.spectrumWave.spectrum[i] = v; })} />
            </Row>
          )}
          {(type === 5 || type === 7) && (
            <Row label="Harmonics:" className="ubx-graphrow">
              <Bars values={Array.from(inst.harmonicsWave.harmonics).slice(0, C.harmonicsControlPoints)} max={C.harmonicsMax}
                onChange={(i, v) => update(() => { inst.harmonicsWave.harmonics[i] = v; })} />
            </Row>
          )}
          {type === 7 && (
            <>
              <Row label="Sustain:"><Slide min={0} max={C.stringSustainRange - 1} value={inst.stringSustain} onChange={set('stringSustain')} /></Row>
              <Row label="Sustain Type:"><Sel value={inst.stringSustainType} options={[[0, 'bright'], [1, 'acoustic']]} onChange={setN('stringSustainType')} /></Row>
            </>
          )}
          {(type === 6 || type === 8) && (
            <>
              <Row label="Pulse Width:"><Slide min={1} max={C.pulseWidthRange} value={inst.pulseWidth} onChange={set('pulseWidth')} /></Row>
              <Row label="Fine Width:"><Slide min={0} max={99} value={inst.decimalOffset} onChange={set('decimalOffset')} /></Row>
            </>
          )}
          {type === 8 && (
            <>
              <Row label="Dynamism:"><Slide min={0} max={C.supersawDynamismMax} value={inst.supersawDynamism} onChange={set('supersawDynamism')} /></Row>
              <Row label="Spread:"><Slide min={0} max={C.supersawSpreadMax} value={inst.supersawSpread} onChange={set('supersawSpread')} /></Row>
              <Row label="Shape:"><Slide min={0} max={C.supersawShapeMax} value={inst.supersawShape} onChange={set('supersawShape')} /></Row>
            </>
          )}
          {type === 4 && (() => {
            const dr = Math.min(11, drum);
            return (
              <>
                <Row label="Drum:">
                  <div className="ubx-drums">{Array.from({ length: 12 }, (_, i) => <Pill key={i} on={i === dr} onClick={() => setDrum(i)}>{i + 1}</Pill>)}</div>
                </Row>
                <Row label="Spectrum:" className="ubx-graphrow">
                  <Bars values={Array.from(inst.drumsetSpectrumWaves[dr].spectrum).slice(0, C.spectrumControlPoints)} max={C.spectrumMax}
                    onChange={(i, v) => update(() => { inst.drumsetSpectrumWaves[dr].spectrum[i] = v; })} />
                </Row>
                <Row label="Envelope:"><Sel value={inst.drumsetEnvelopes[dr]} options={names(C.envelopes)} onChange={(v) => update(() => { inst.drumsetEnvelopes[dr] = Number(v); })} /></Row>
              </>
            );
          })()}
          {[0, 2, 9].includes(type) && <Row label="Aliasing:"><Tick label="" value={inst.aliases} onChange={set('aliases')} /></Row>}
          {showUnison && (
            <>
              <Row label="Unison:">
                <Pill onClick={() => setOpenUnison(o => !o)} title="Custom unison">▾</Pill>
                <Sel value={inst.unison} options={names(C.unisons)} onChange={(v) => setUnison(Number(v))} />
              </Row>
              {openUnison && (
                <>
                  <Row label="Voices:"><Slide min={C.unisonVoicesMin} max={C.unisonVoicesMax} value={inst.unisonVoices} onChange={set('unisonVoices')} /></Row>
                  <Row label="Spread:"><Slide min={C.unisonSpreadMin} max={C.unisonSpreadMax} step={0.01} value={inst.unisonSpread} onChange={set('unisonSpread')} /></Row>
                  <Row label="Offset:"><Slide min={C.unisonOffsetMin} max={C.unisonOffsetMax} step={0.01} value={inst.unisonOffset} onChange={set('unisonOffset')} /></Row>
                  <Row label="Expression:"><Slide min={C.unisonExpressionMin} max={C.unisonExpressionMax} step={0.01} value={inst.unisonExpression} onChange={set('unisonExpression')} /></Row>
                  <Row label="Sign:"><Slide min={C.unisonSignMin} max={C.unisonSignMax} step={0.05} value={inst.unisonSign} onChange={set('unisonSign')} /></Row>
                </>
              )}
            </>
          )}

          {(type === 1 || type === 11) && (
            <>
              <Row label="Algorithm:">
                {fm6
                  ? <Sel value={inst.algorithm6Op} options={names(C.algorithms6Op)} onChange={setN('algorithm6Op')} />
                  : <Sel value={inst.algorithm} options={names(C.algorithms)} onChange={setN('algorithm')} />}
              </Row>
              <div className="ubx-optable">
                <div className="ubx-ophead"><span>Freq:</span><span>Volume:</span></div>
                {Array.from({ length: nOps }, (_, i) => {
                  const op = inst.operators[i];
                  return (
                    <div key={i} className="ubx-op">
                      <span className="ubx-opn">{i + 1}</span>
                      <Sel value={op.frequency} options={names(C.operatorFrequencies)} onChange={(v) => update(() => { op.frequency = Number(v); })} className="ubx-opfreq" />
                      {fm6 && <Sel value={op.waveform} options={names(C.operatorWaves)} onChange={(v) => update(() => { op.waveform = Number(v); })} className="ubx-opwave" />}
                      <Slide min={0} max={C.operatorAmplitudeMax} value={op.amplitude} carrier={i < carriers} onChange={(v) => update(() => { op.amplitude = v; })} title={`Volume ${op.amplitude}`} />
                    </div>
                  );
                })}
              </div>
              <Row label="Feedback:">
                {fm6
                  ? <Sel value={inst.feedbackType6Op} options={names(C.feedbacks6Op)} onChange={setN('feedbackType6Op')} />
                  : <Sel value={inst.feedbackType} options={names(C.feedbacks)} onChange={setN('feedbackType')} />}
              </Row>
              <Row label="Fdback Vol:"><Slide min={0} max={C.operatorAmplitudeMax} value={inst.feedbackAmplitude} onChange={set('feedbackAmplitude')} /></Row>
              {fm6 && (inst.algorithm6Op === 0 || inst.feedbackType6Op === 0) && (
                <div className="ubx-custom">
                  {inst.algorithm6Op === 0 && (() => {
                    const ca = inst.customAlgorithm;
                    const toggle = (row, m) => update(() => {
                      const mb = ca.modulatedBy.map(a => [...a]);
                      mb[row] = mb[row].includes(m) ? mb[row].filter(x => x !== m) : [...mb[row], m].sort((a, b) => a - b);
                      ca.set(ca.carrierCount, mb);
                    });
                    return (
                      <>
                        <Row label="Carriers:"><Slide min={1} max={6} value={ca.carrierCount} onChange={(v) => update(() => { ca.set(v, ca.modulatedBy.map((a, r) => a.filter(m => m > v && m > r + 1))); })} /></Row>
                        <div className="ubx-matrixhint">Operator (row) is modulated by (column)</div>
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
                        <div className="ubx-matrixhint">Feedback: operator (row) receives (column)</div>
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
                </div>
              )}
            </>
          )}

          {/* effects: the header opens a list; the ones that are on show their controls below */}
          <SecHead title="Effects">
            <Pill onClick={() => setOpenEffects(o => !o)} title="Choose effects" on={openEffects}>▾</Pill>
          </SecHead>
          {openEffects && (
            <div className="ubx-effectlist">
              {C.effectOrder.map((i) => {
                const n = C.effectNames[i];
                return <Tick key={n} label={n} value={effectOn(n)} onChange={() => toggleEffect(n)} />;
              })}
            </div>
          )}
          {effectOn('transition type') && (
            <>
              <Row label="Transition:"><Sel value={inst.transition} options={names(C.transitions)} onChange={setN('transition')} /></Row>
              <Row label="Clickless:"><Tick label="" value={inst.clicklessTransition} onChange={set('clicklessTransition')} title="Avoid clicks when a note starts" /></Row>
            </>
          )}
          {effectOn('chord type') && (
            <>
              <Row label="Chords:"><Sel value={inst.chord} options={names(C.chords)} onChange={setN('chord')} /></Row>
              {inst.chord === 2 && (
                <>
                  <Row label="Arp Speed:"><Slide min={0} max={50} value={inst.arpeggioSpeed} onChange={set('arpeggioSpeed')} /></Row>
                  <Row label="Fast 2-note:"><Tick label="" value={inst.fastTwoNoteArp} onChange={set('fastTwoNoteArp')} /></Row>
                </>
              )}
            </>
          )}
          {effectOn('vibrato') && (
            <>
              <Row label="Vibrato:"><Sel value={inst.vibrato} options={[...names(C.vibratos), [C.vibratos.length, 'custom']]} onChange={setN('vibrato')} /></Row>
              {inst.vibrato === C.vibratos.length && (
                <>
                  <Row label="Depth:"><Slide min={0} max={2} step={0.01} value={inst.vibratoDepth} onChange={set('vibratoDepth')} /></Row>
                  <Row label="Speed:"><Slide min={0} max={30} step={0.1} value={inst.vibratoSpeed} onChange={set('vibratoSpeed')} /></Row>
                  <Row label="Delay:"><Slide min={0} max={50} step={0.5} value={inst.vibratoDelay} onChange={set('vibratoDelay')} /></Row>
                  <Row label="Type:"><Sel value={inst.vibratoType} options={names(C.vibratoTypes)} onChange={setN('vibratoType')} /></Row>
                </>
              )}
            </>
          )}
          {effectOn('pitch shift') && <Row label="Pitch Shift:"><Slide min={0} max={C.pitchShiftRange - 1} value={inst.pitchShift} onChange={set('pitchShift')} title={`${inst.pitchShift - C.pitchShiftCenter} semitones`} /></Row>}
          {effectOn('detune') && <Row label="Detune:"><Slide min={C.detuneMin} max={C.detuneMax} value={inst.detune} onChange={set('detune')} title={`${inst.detune - C.detuneCenter} cents`} /></Row>}
          {effectOn('distortion') && <Row label="Distortion:"><Slide min={0} max={C.distortionRange - 1} value={inst.distortion} onChange={set('distortion')} /></Row>}
          {effectOn('bitcrusher') && (
            <>
              <Row label="Crush Freq:"><Slide min={0} max={C.bitcrusherFreqRange - 1} value={inst.bitcrusherFreq} onChange={set('bitcrusherFreq')} /></Row>
              <Row label="Crush Bits:"><Slide min={0} max={C.bitcrusherQuantizationRange - 1} value={inst.bitcrusherQuantization} onChange={set('bitcrusherQuantization')} /></Row>
            </>
          )}
          {effectOn('note filter') && (
            <>
              <Row label="Note Filt.Type:">
                <Seg value={simpleNote ? 'simple' : 'advanced'} options={[['simple', 'simple'], ['advanced', 'advanced']]} onChange={(v) => update(() => { inst.noteFilterType = v === 'simple'; })} />
              </Row>
              {simpleNote ? (
                <>
                  <Row label="Filter Cut:"><Slide min={0} max={C.filterSimpleCutRange - 1} value={inst.noteFilterSimpleCut} onChange={set('noteFilterSimpleCut')} /></Row>
                  <Row label="Filter Peak:"><Slide min={0} max={C.filterSimplePeakRange - 1} value={inst.noteFilterSimplePeak} onChange={set('noteFilterSimplePeak')} /></Row>
                </>
              ) : (
                <Row label="Note Filt:" className="ubx-graphrow">
                  <Pill title="Add a filter point" onClick={() => { if (inst.noteFilter.controlPointCount < C.filterMaxPoints) update(() => { inst.noteFilter.addPoint(0, Math.round(C.filterFreqRange / 2), C.filterGainCenter); }); }}>+</Pill>
                  <FilterGraph inst={inst} C={C} kind="note" update={update} />
                </Row>
              )}
            </>
          )}
          {effectOn('chorus') && <Row label="Chorus:"><Slide min={0} max={C.chorusRange - 1} value={inst.chorus} onChange={set('chorus')} /></Row>}
          {effectOn('echo') && (
            <>
              <Row label="Echo:"><Slide min={0} max={C.echoSustainRange - 1} value={inst.echoSustain} onChange={set('echoSustain')} /></Row>
              <Row label="Echo Delay:"><Slide min={0} max={C.echoDelayRange - 1} value={inst.echoDelay} onChange={set('echoDelay')} /></Row>
            </>
          )}
          {effectOn('reverb') && <Row label="Reverb:"><Slide min={0} max={C.reverbRange - 1} value={inst.reverb} onChange={set('reverb')} /></Row>}

          <SecHead title="Envelopes">
            <Pill onClick={() => setOpenEnv(o => !o)} title="Envelope speed and stepping" on={openEnv}>▾</Pill>
            <Pill title="Add an envelope" onClick={() => {
              if (inst.envelopeCount >= C.maxEnvelopeCount) return;
              update(() => {
                const vol = C.instrumentAutomationTargets.findIndex(t => t.name === 'noteVolume');
                const punch = C.envelopes.findIndex(x => x.name === 'punch');
                inst.addEnvelope(vol, 0, punch < 0 ? 1 : punch);
              });
            }}>+</Pill>
          </SecHead>
          {openEnv && (
            <>
              <Row label="Env Speed:"><Slide min={0} max={50} value={inst.envelopeSpeed} onChange={set('envelopeSpeed')} /></Row>
              <Row label="Discrete:"><Tick label="" value={inst.discreteEnvelope} onChange={set('discreteEnvelope')} title="Step the envelopes instead of gliding" /></Row>
            </>
          )}
          {envs.map((e, i) => (
            <div key={i} className="ubx-env">
              <Sel
                value={`${e.target}:${e.index}`}
                options={(() => {
                  const opts = targetsFor();
                  const cur = `${e.target}:${e.index}`;
                  return opts.some(([v]) => v === cur) ? opts : [[cur, C.instrumentAutomationTargets[e.target]?.name || 'none'], ...opts];
                })()}
                onChange={(v) => { const [t, k] = v.split(':').map(Number); update(() => { e.target = t; e.index = k; }); }}
              />
              <Sel value={e.envelope} options={names(C.envelopes)} onChange={(v) => update(() => { e.envelope = Number(v); })} />
              <Pill title="Remove this envelope" onClick={() => update(() => { inst.envelopes.splice(i, 1); inst.envelopeCount--; })}>×</Pill>
            </div>
          ))}
        </div>
        <div className="ub-sidecard">
          <h4>Output</h4>
          <Scope id={id} rev={rev} />
          <p className="ub-note">The rendered note (about half a second, middle C-ish).</p>
          {fm6 === false && type === 1 && <p className="ub-note">Carrier operators have light sliders; the others modulate them.</p>}
        </div>
      </div>
    </div>
  );
}
