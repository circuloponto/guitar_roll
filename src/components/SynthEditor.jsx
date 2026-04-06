import { useState, useCallback } from 'react';
import {
  defaultSynthParams, SYNTH_PRESETS, getSynthParams,
  loadCustomPresets, saveCustomPreset, deleteCustomPreset,
  playNote, getAllInstruments,
  loadHiddenPresets, hidePreset, unhidePreset,
} from '../utils/audio';

const WAVE_TYPES = ['sine', 'triangle', 'sawtooth', 'square'];
const FILTER_TYPES = ['lowpass', 'highpass', 'bandpass'];

export default function SynthEditor({ currentInstrument, onInstrumentChange, onClose }) {
  const customPresets = loadCustomPresets();
  const allPresets = { ...SYNTH_PRESETS, ...Object.fromEntries(Object.entries(customPresets).map(([id, p]) => [id, p])) };

  // Load params for current instrument, or default
  const initial = getSynthParams(currentInstrument) || SYNTH_PRESETS['clean-electric'];
  const [params, setParams] = useState(JSON.parse(JSON.stringify(initial)));
  const [presetName, setPresetName] = useState(params.name || 'Custom');
  const [dirty, setDirty] = useState(false);

  const update = (fn) => {
    setParams(prev => {
      const next = JSON.parse(JSON.stringify(prev));
      fn(next);
      return next;
    });
    setDirty(true);
  };

  const previewSound = useCallback(() => {
    // Save temporarily and play
    const tempId = '__preview__';
    saveCustomPreset(tempId, { ...params, name: 'Preview' });
    playNote(2, 5, 0.5, 0.8, tempId);
    setTimeout(() => deleteCustomPreset(tempId), 100);
  }, [params]);

  const handleSave = () => {
    const id = presetName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    if (!id) return;
    saveCustomPreset(id, { ...params, name: presetName });
    onInstrumentChange(id);
    setDirty(false);
  };

  const handleLoadPreset = (id) => {
    const p = allPresets[id];
    if (p) {
      setParams(JSON.parse(JSON.stringify(p)));
      setPresetName(p.name || id);
      setDirty(false);
    }
  };

  const [hiddenList, setHiddenList] = useState(loadHiddenPresets);

  const handleDeletePreset = (id) => {
    if (SYNTH_PRESETS[id]) {
      hidePreset(id);
      setHiddenList(loadHiddenPresets());
    } else {
      deleteCustomPreset(id);
    }
    if (currentInstrument === id) {
      // Switch to first available instrument
      const remaining = getAllInstruments();
      const firstId = Object.keys(remaining)[0] || 'clean-electric';
      onInstrumentChange(firstId);
    }
  };

  const handleRestorePreset = (id) => {
    unhidePreset(id);
    setHiddenList(loadHiddenPresets());
  };

  const env = params.envelope;
  const flt = params.filter;
  const trem = params.tremolo || { rate: 0, depth: 0 };
  const vib = params.vibrato || { rate: 0, depth: 0 };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-popup synth-editor" onClick={(e) => e.stopPropagation()}>
        <h2 className="settings-title">Synth Editor</h2>

        {/* Preset selector */}
        <div className="settings-section">
          <h3>Presets</h3>
          <div className="synth-preset-list">
            {Object.entries(allPresets).filter(([id]) => !hiddenList.includes(id)).map(([id, p]) => (
              <div key={id} className="synth-preset-item">
                <button
                  className={`settings-btn-sm ${id === currentInstrument ? 'active' : ''}`}
                  onClick={() => handleLoadPreset(id)}
                >
                  {p.name || id}
                </button>
                <button className="settings-btn-sm danger" onClick={() => handleDeletePreset(id)}>x</button>
              </div>
            ))}
          </div>
          {hiddenList.length > 0 && (
            <div style={{ marginTop: 6 }}>
              <span style={{ fontSize: 10, color: '#666' }}>Hidden: </span>
              {hiddenList.map(id => (
                <button key={id} className="settings-btn-sm" style={{ marginLeft: 4, fontSize: 10 }}
                  onClick={() => handleRestorePreset(id)}
                >{SYNTH_PRESETS[id]?.name || id} +</button>
              ))}
            </div>
          )}
        </div>

        {/* Oscillators */}
        <div className="settings-section">
          <h3>Oscillators</h3>
          {params.oscillators.map((osc, i) => (
            <div key={i} className="synth-osc-row">
              <select
                value={osc.type}
                onChange={(e) => update(p => { p.oscillators[i].type = e.target.value; })}
              >
                {WAVE_TYPES.map(w => <option key={w} value={w}>{w}</option>)}
              </select>
              <label>Det <input type="range" min={-2400} max={2400} value={osc.detune}
                onChange={(e) => update(p => { p.oscillators[i].detune = Number(e.target.value); })}
              /><span className="synth-val">{osc.detune}c</span></label>
              <label>Gain <input type="range" min={0} max={100} value={Math.round(osc.gain * 100)}
                onChange={(e) => update(p => { p.oscillators[i].gain = Number(e.target.value) / 100; })}
              /><span className="synth-val">{Math.round(osc.gain * 100)}%</span></label>
              {params.oscillators.length > 1 && (
                <button className="settings-btn-sm danger" onClick={() => update(p => { p.oscillators.splice(i, 1); })}>-</button>
              )}
            </div>
          ))}
          {params.oscillators.length < 6 && (
            <button className="settings-btn-sm" onClick={() => update(p => {
              p.oscillators.push({ type: 'sine', detune: 0, gain: 0.5 });
            })}>+ Add Oscillator</button>
          )}
        </div>

        {/* Filter */}
        <div className="settings-section">
          <h3>Filter</h3>
          <div className="synth-filter-row">
            <select value={flt.type} onChange={(e) => update(p => { p.filter.type = e.target.value; })}>
              {FILTER_TYPES.map(f => <option key={f} value={f}>{f}</option>)}
            </select>
            <label>Cutoff <input type="range" min={20} max={10000} value={flt.cutoff}
              onChange={(e) => update(p => { p.filter.cutoff = Number(e.target.value); })}
            /><span className="synth-val">{flt.cutoff}Hz</span></label>
            <label>Res <input type="range" min={0} max={200} value={Math.round(flt.resonance * 10)}
              onChange={(e) => update(p => { p.filter.resonance = Number(e.target.value) / 10; })}
            /><span className="synth-val">{flt.resonance.toFixed(1)}</span></label>
            <label>Env <input type="range" min={0} max={100} value={Math.round(flt.envAmount * 100)}
              onChange={(e) => update(p => { p.filter.envAmount = Number(e.target.value) / 100; })}
            /><span className="synth-val">{Math.round(flt.envAmount * 100)}%</span></label>
          </div>
        </div>

        {/* ADSR Envelope */}
        <div className="settings-section">
          <h3>Envelope (ADSR)</h3>
          <div className="synth-adsr">
            <label>A <input type="range" min={1} max={500} value={Math.round(env.attack * 1000)}
              onChange={(e) => update(p => { p.envelope.attack = Number(e.target.value) / 1000; })}
            /><span className="synth-val">{Math.round(env.attack * 1000)}ms</span></label>
            <label>D <input type="range" min={1} max={1000} value={Math.round(env.decay * 1000)}
              onChange={(e) => update(p => { p.envelope.decay = Number(e.target.value) / 1000; })}
            /><span className="synth-val">{Math.round(env.decay * 1000)}ms</span></label>
            <label>S <input type="range" min={0} max={100} value={Math.round(env.sustain * 100)}
              onChange={(e) => update(p => { p.envelope.sustain = Number(e.target.value) / 100; })}
            /><span className="synth-val">{Math.round(env.sustain * 100)}%</span></label>
            <label>R <input type="range" min={10} max={1000} value={Math.round(env.release * 1000)}
              onChange={(e) => update(p => { p.envelope.release = Number(e.target.value) / 1000; })}
            /><span className="synth-val">{Math.round(env.release * 1000)}ms</span></label>
          </div>
        </div>

        {/* Tremolo & Vibrato */}
        <div className="settings-section">
          <h3>Tremolo & Vibrato</h3>
          <div className="synth-adsr">
            <label>Trem Rate <input type="range" min={0} max={200} value={Math.round(trem.rate * 10)}
              onChange={(e) => update(p => { if (!p.tremolo) p.tremolo = { rate: 0, depth: 0 }; p.tremolo.rate = Number(e.target.value) / 10; })}
            /><span className="synth-val">{trem.rate.toFixed(1)}Hz</span></label>
            <label>Trem Depth <input type="range" min={0} max={100} value={Math.round(trem.depth * 100)}
              onChange={(e) => update(p => { if (!p.tremolo) p.tremolo = { rate: 0, depth: 0 }; p.tremolo.depth = Number(e.target.value) / 100; })}
            /><span className="synth-val">{Math.round(trem.depth * 100)}%</span></label>
            <label>Vib Rate <input type="range" min={0} max={200} value={Math.round(vib.rate * 10)}
              onChange={(e) => update(p => { if (!p.vibrato) p.vibrato = { rate: 0, depth: 0 }; p.vibrato.rate = Number(e.target.value) / 10; })}
            /><span className="synth-val">{vib.rate.toFixed(1)}Hz</span></label>
            <label>Vib Depth <input type="range" min={0} max={200} value={Math.round(vib.depth)}
              onChange={(e) => update(p => { if (!p.vibrato) p.vibrato = { rate: 0, depth: 0 }; p.vibrato.depth = Number(e.target.value); })}
            /><span className="synth-val">{Math.round(vib.depth)}c</span></label>
          </div>
        </div>

        {/* Actions */}
        <div className="synth-actions">
          <button className="settings-btn" onClick={previewSound}>Preview</button>
          <input
            className="settings-input"
            value={presetName}
            onChange={(e) => { setPresetName(e.target.value); setDirty(true); }}
            placeholder="Preset name"
            style={{ width: 140 }}
          />
          <button className="settings-btn" onClick={handleSave} disabled={!presetName.trim()}>
            Save{dirty ? ' *' : ''}
          </button>
          <button className="settings-btn settings-close" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
