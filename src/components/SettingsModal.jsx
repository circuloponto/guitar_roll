import { useState, useEffect } from 'react';
import ConfirmDialog from './ConfirmDialog';
import {
  listColorSchemes, saveColorScheme, deleteColorScheme,
  listSessions, saveSession, loadSession, deleteSession,
  exportToFile, importFromFile, stateToUrl, getSessionState,
} from '../utils/storage';
import {
  loadHotkeys, saveHotkeys, getDefaultHotkeys, formatHotkey,
  findConflicts, EDITABLE_HOTKEYS, REFERENCE_ACTIONS,
} from '../utils/hotkeys';

// Editable hex input that allows free typing and applies on valid hex
function HexInput({ value, onChange }) {
  const [text, setText] = useState(value);
  useEffect(() => { setText(value); }, [value]);

  const apply = (v) => {
    let hex = v.trim();
    if (hex && !hex.startsWith('#')) hex = '#' + hex;
    if (/^#[0-9a-fA-F]{6}$/.test(hex)) {
      onChange(hex.toLowerCase());
    }
  };

  return (
    <input
      type="text"
      className="settings-hex-input"
      value={text}
      onChange={e => setText(e.target.value)}
      onBlur={() => apply(text)}
      onKeyDown={e => {
        e.stopPropagation();
        if (e.key === 'Enter') { apply(text); e.target.blur(); }
      }}
      onPaste={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}
    />
  );
}

const CHROMATIC = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
// Map display names to internal names used by synesthesia
const CHROMATIC_INTERNAL = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function defaultSchemeColors() {
  const colors = {};
  CHROMATIC_INTERNAL.forEach(n => { colors[n] = '#ffffff'; });
  return colors;
}

export default function SettingsModal({ appState, onApplyState, onClose, onHotkeysChange, hoverPreview, onHoverPreviewChange, tupletLines, onTupletLinesChange, autoScroll, onAutoScrollChange, hoverPill, onHoverPillChange, autoSave, onAutoSaveChange, showTimelineVerticalZoomButtons, onShowTimelineVerticalZoomButtonsChange }) {
  const [page, setPage] = useState('main'); // main, schemes, editScheme, sessions, hotkeys
  const [schemes, setSchemes] = useState(listColorSchemes);
  const [editingScheme, setEditingScheme] = useState(null); // { name, colors }
  const [sessions, setSessions] = useState(listSessions);
  const [sessionName, setSessionName] = useState('');
  const [copyMsg, setCopyMsg] = useState('');
  const [confirm, setConfirm] = useState(null); // { message, onConfirm }

  const refreshSchemes = () => setSchemes(listColorSchemes());
  const refreshSessions = () => setSessions(listSessions());

  // Apply a color scheme to the app
  const applyScheme = (name, colors) => {
    const synesthesia = Object.entries(colors)
      .filter(([_, c]) => c !== '#ffffff')
      .map(([note, color]) => ({ note, color }));
    onApplyState({ synesthesia, activeColorScheme: { name, colors } });
  };

  // --- Main page ---
  if (page === 'main') {
    return (
      <div className="settings-overlay" onClick={onClose}>
        <div className="settings-popup" onClick={e => e.stopPropagation()}>
          <h2 className="settings-title">Settings</h2>

          <div className="settings-section">
            <h3>Hover Sound Preview</h3>
            {[
              { key: 'fretboard', label: 'Fretboard' },
              { key: 'pianoRoll', label: 'Piano Roll Keys' },
              { key: 'timelineNotes', label: 'Timeline Notes' },
            ].map(({ key, label }) => (
              <div key={key} className="settings-row">
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#ccc', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={hoverPreview[key] || false}
                    onChange={(e) => onHoverPreviewChange({ ...hoverPreview, [key]: e.target.checked })}
                  />
                  {label}
                </label>
              </div>
            ))}
            <div className="settings-row" style={{ marginTop: 6 }}>
              <span style={{ fontSize: 13, color: '#ccc', marginRight: 8 }}>Volume</span>
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round((hoverPreview.volume ?? 0.3) * 100)}
                onChange={(e) => onHoverPreviewChange({ ...hoverPreview, volume: Number(e.target.value) / 100 })}
                style={{ width: 120 }}
              />
              <span style={{ fontSize: 12, color: '#888', marginLeft: 6 }}>{Math.round((hoverPreview.volume ?? 0.3) * 100)}%</span>
            </div>
          </div>

          <div className="settings-section">
            <h3>Tuplet Grid Lines</h3>
            <div className="settings-row">
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#ccc', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={tupletLines?.visible ?? true}
                  onChange={(e) => onTupletLinesChange({ ...tupletLines, visible: e.target.checked })}
                />
                Show subdivision lines
              </label>
            </div>
            <div className="settings-row" style={{ marginTop: 6 }}>
              <span style={{ fontSize: 13, color: '#ccc', marginRight: 8 }}>Opacity</span>
              <input
                type="range"
                min={5}
                max={100}
                value={Math.round((tupletLines?.opacity ?? 0.35) * 100)}
                onChange={(e) => onTupletLinesChange({ ...tupletLines, opacity: Number(e.target.value) / 100 })}
                style={{ width: 120 }}
                disabled={!(tupletLines?.visible ?? true)}
              />
              <span style={{ fontSize: 12, color: '#888', marginLeft: 6 }}>{Math.round((tupletLines?.opacity ?? 0.35) * 100)}%</span>
            </div>
          </div>

          <div className="settings-section">
            <h3>Fretboard Auto-Scroll</h3>
            {[
              { key: 'onHover', label: 'Scroll on note hover' },
              { key: 'onInput', label: 'Scroll on note input' },
              { key: 'onPlayback', label: 'Scroll during playback' },
            ].map(({ key, label }) => (
              <div key={key} className="settings-row">
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#ccc', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={autoScroll?.[key] ?? true}
                    onChange={(e) => onAutoScrollChange({ ...autoScroll, [key]: e.target.checked })}
                  />
                  {label}
                </label>
              </div>
            ))}
          </div>

          <div className="settings-section">
            <h3>Fretboard Hover Pill</h3>
            {[
              { key: 'fretboard', label: 'Show on fretboard hover' },
              { key: 'pianoRoll', label: 'Show on piano roll hover' },
            ].map(({ key, label }) => (
              <div key={key} className="settings-row">
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#ccc', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={hoverPill?.[key] ?? true}
                    onChange={(e) => onHoverPillChange({ ...hoverPill, [key]: e.target.checked })}
                  />
                  {label}
                </label>
              </div>
            ))}
          </div>

          <div className="settings-section">
            <h3>Timeline</h3>
            <div className="settings-row">
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#ccc', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={showTimelineVerticalZoomButtons !== false}
                  onChange={(e) => onShowTimelineVerticalZoomButtonsChange(e.target.checked)}
                />
                Dock vertical zoom buttons (top-right)
              </label>
            </div>
          </div>

          <div className="settings-section">
            <h3>Keyboard Shortcuts</h3>
            <button className="settings-btn" onClick={() => setPage('hotkeys')}>
              Manage Hotkeys
            </button>
          </div>

          <div className="settings-section">
            <h3>Color Schemes</h3>
            <button className="settings-btn" onClick={() => setPage('schemes')}>
              Manage Color Schemes
            </button>
          </div>

          <div className="settings-section" style={{ display: 'none' }}>
            <h3>String Colors (moved to Color Schemes)</h3>
          </div>

          <div className="settings-section">
            <h3>Autosave</h3>
            <div className="settings-row">
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#ccc', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={autoSave ?? true}
                  onChange={(e) => onAutoSaveChange(e.target.checked)}
                />
                Autosave every 30 seconds
              </label>
            </div>
          </div>

          <div className="settings-section">
            <h3>Sessions</h3>
            <div className="settings-row-btns">
              <button className="settings-btn" onClick={() => { refreshSessions(); setPage('sessions'); }}>
                Save / Load Session
              </button>
            </div>
            <div className="settings-row-btns">
              <button className="settings-btn" onClick={() => exportToFile(getSessionState(appState), `${appState.projectName || 'guitar-roll'}.json`)}>
                Export to File
              </button>
              <button className="settings-btn" onClick={async () => {
                try {
                  const data = await importFromFile();
                  onApplyState(data);
                } catch {}
              }}>
                Import from File
              </button>
            </div>
          </div>

          <div className="settings-section">
            <h3>Share</h3>
            <div className="settings-row-btns">
              <button className="settings-btn" onClick={() => {
                const url = stateToUrl(getSessionState(appState));
                navigator.clipboard.writeText(url);
                setCopyMsg('Link copied!');
                setTimeout(() => setCopyMsg(''), 2000);
              }}>
                Copy Share Link
              </button>
              {copyMsg && <span className="settings-copy-msg">{copyMsg}</span>}
            </div>
          </div>

          <button className="settings-btn settings-close" onClick={onClose}>Close</button>
        </div>
      </div>
    );
  }

  // --- Color Schemes list page ---
  if (page === 'schemes') {
    const schemeNames = Object.keys(schemes);
    return (
      <div className="settings-overlay" onClick={onClose}>
        <div className="settings-popup" onClick={e => e.stopPropagation()}>
          <h2 className="settings-title">Color Schemes</h2>

          <div className="schemes-list">
            {schemeNames.length === 0 && (
              <p className="settings-empty">No color schemes saved yet.</p>
            )}
            {schemeNames.map(name => (
              <div key={name} className="scheme-item">
                <span className="scheme-name">{name}</span>
                <div className="scheme-row">
                  <div className="scheme-colors-preview">
                    {CHROMATIC_INTERNAL.map(n => (
                      <div key={n} className="scheme-color-dot" style={{ background: schemes[name][n] || '#ffffff' }} />
                    ))}
                  </div>
                  <div className="scheme-actions">
                    <button className="settings-btn-sm" onClick={() => applyScheme(name, schemes[name])}>Apply</button>
                    <button className="settings-btn-sm" onClick={() => {
                      setEditingScheme({ name, colors: { ...schemes[name] } });
                      setPage('editScheme');
                    }}>Edit</button>
                    <button className="settings-btn-sm danger" onClick={() => {
                      setConfirm({
                        message: `Delete color scheme "${name}"?`,
                        onConfirm: () => { deleteColorScheme(name); refreshSchemes(); setConfirm(null); },
                      });
                    }}>Delete</button>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="settings-row-btns" style={{ marginTop: 12 }}>
            <button className="settings-btn" onClick={() => {
              setEditingScheme({ name: '', colors: defaultSchemeColors() });
              setPage('editScheme');
            }}>
              + Add Color Scheme
            </button>
          </div>

          <div className="settings-section" style={{ marginTop: 16 }}>
            <h3>String Colors</h3>
            {['E', 'A', 'D', 'G', 'B', 'e'].map((name, i) => (
              <div key={i} className="settings-row">
                <span className="settings-label">{name}</span>
                <input
                  type="color"
                  value={appState.stringColors[i]}
                  onChange={(e) => {
                    const next = [...appState.stringColors];
                    next[i] = e.target.value;
                    onApplyState({ stringColors: next });
                  }}
                />
                <HexInput
                  value={appState.stringColors[i]}
                  onChange={(v) => {
                    const next = [...appState.stringColors];
                    next[i] = v;
                    onApplyState({ stringColors: next });
                  }}
                />
              </div>
            ))}
          </div>

          <button className="settings-btn settings-back" onClick={() => setPage('main')}>Back</button>
        </div>
        {confirm && (
          <ConfirmDialog message={confirm.message} onConfirm={confirm.onConfirm} onCancel={() => setConfirm(null)} />
        )}
      </div>
    );
  }

  // --- Edit color scheme page ---
  if (page === 'editScheme' && editingScheme) {
    return (
      <div className="settings-overlay" onClick={onClose}>
        <div className="settings-popup settings-popup-wide" onClick={e => e.stopPropagation()}>
          <h2 className="settings-title">Edit Color Scheme</h2>

          <div className="settings-row">
            <span className="settings-label">Name:</span>
            <input
              type="text"
              className="settings-input"
              value={editingScheme.name}
              onChange={e => setEditingScheme(prev => ({ ...prev, name: e.target.value }))}
              placeholder="Scheme name"
            />
          </div>

          <div className="scheme-edit-grid">
            {CHROMATIC.map((displayName, i) => {
              const internalName = CHROMATIC_INTERNAL[i];
              return (
                <div key={internalName} className="settings-row">
                  <span className="settings-label" style={{ width: 30 }}>{displayName}</span>
                  <input
                    type="color"
                    value={editingScheme.colors[internalName] || '#ffffff'}
                    onChange={e => setEditingScheme(prev => ({
                      ...prev,
                      colors: { ...prev.colors, [internalName]: e.target.value }
                    }))}
                  />
                  <HexInput
                    value={editingScheme.colors[internalName] || '#ffffff'}
                    onChange={v => {
                      const n = internalName;
                      setEditingScheme(prev => ({
                        ...prev,
                        colors: { ...prev.colors, [n]: v }
                      }));
                    }}
                  />
                </div>
              );
            })}
          </div>

          <div className="settings-row-btns" style={{ marginTop: 16 }}>
            <button className="settings-btn" onClick={() => {
              if (!editingScheme.name.trim()) return;
              saveColorScheme(editingScheme.name.trim(), editingScheme.colors);
              refreshSchemes();
              setPage('schemes');
            }}>
              Save
            </button>
            <button className="settings-btn" onClick={() => setPage('schemes')}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  // --- Sessions page ---
  if (page === 'sessions') {
    const sessionNames = Object.keys(sessions).sort((a, b) =>
      (sessions[b].savedAt || 0) - (sessions[a].savedAt || 0)
    );
    return (
      <div className="settings-overlay" onClick={onClose}>
        <div className="settings-popup" onClick={e => e.stopPropagation()}>
          <h2 className="settings-title">Sessions</h2>

          <div className="settings-row" style={{ marginBottom: 12 }}>
            <input
              type="text"
              className="settings-input"
              value={sessionName}
              onChange={e => setSessionName(e.target.value)}
              placeholder="Session name"
            />
            <button className="settings-btn" onClick={() => {
              if (!sessionName.trim()) return;
              saveSession(sessionName.trim(), getSessionState(appState));
              refreshSessions();
              setSessionName('');
            }}>
              Save Current
            </button>
          </div>

          <div className="schemes-list">
            {sessionNames.length === 0 && (
              <p className="settings-empty">No saved sessions.</p>
            )}
            {sessionNames.map(name => (
              <div key={name} className="scheme-item">
                <span className="scheme-name">{name}</span>
                <span className="settings-date">
                  {sessions[name].savedAt ? new Date(sessions[name].savedAt).toLocaleDateString() : ''}
                </span>
                <span className="settings-date">{sessions[name].tracks ? sessions[name].tracks.reduce((s, t) => s + (t.notes?.length || 0), 0) : (sessions[name].notes?.length || 0)} notes</span>
                <div className="scheme-actions">
                  <button className="settings-btn-sm" onClick={() => {
                    const data = loadSession(name);
                    if (data) onApplyState(data);
                  }}>Load</button>
                  <button className="settings-btn-sm danger" onClick={() => {
                    setConfirm({
                      message: `Delete session "${name}"?`,
                      onConfirm: () => { deleteSession(name); refreshSessions(); setConfirm(null); },
                    });
                  }}>Delete</button>
                </div>
              </div>
            ))}
          </div>

          <button className="settings-btn settings-back" onClick={() => setPage('main')}>Back</button>
        </div>
        {confirm && (
          <ConfirmDialog message={confirm.message} onConfirm={confirm.onConfirm} onCancel={() => setConfirm(null)} />
        )}
      </div>
    );
  }

  // --- Hotkeys page ---
  if (page === 'hotkeys') {
    return <HotkeysPage onBack={() => setPage('main')} onClose={onClose} onHotkeysChange={onHotkeysChange} />;
  }

  return null;
}

function HotkeysPage({ onBack, onClose, onHotkeysChange }) {
  const [hotkeys, setHotkeys] = useState(loadHotkeys);
  const [recording, setRecording] = useState(null); // hotkey id being recorded
  const conflicts = findConflicts(hotkeys);

  const handleRecord = (id) => {
    setRecording(id);
  };

  useEffect(() => {
    if (!recording) return;
    const handler = (e) => {
      e.preventDefault();
      e.stopPropagation();

      // Ignore lone modifier keys
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;

      const newKey = {
        ...hotkeys[recording],
        key: e.key,
        modifiers: (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) ? {
          ctrl: e.ctrlKey || e.metaKey || undefined,
          shift: e.shiftKey || undefined,
          alt: e.altKey || undefined,
        } : undefined,
      };

      const updated = { ...hotkeys, [recording]: newKey };
      setHotkeys(updated);
      saveHotkeys(updated);
      if (onHotkeysChange) onHotkeysChange(updated);
      setRecording(null);
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [recording, hotkeys, onHotkeysChange]);

  const handleReset = () => {
    const defaults = getDefaultHotkeys();
    setHotkeys(defaults);
    saveHotkeys(defaults);
    if (onHotkeysChange) onHotkeysChange(defaults);
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-popup settings-popup-wide" onClick={e => e.stopPropagation()}>
        <h2 className="settings-title">Keyboard Shortcuts</h2>

        {conflicts.length > 0 && (
          <div className="hotkey-conflicts">
            {conflicts.map((c, i) => (
              <div key={i} className="hotkey-conflict">
                Conflict: "{c.label1}" and "{c.label2}" share the same key
              </div>
            ))}
          </div>
        )}

        <div className="hotkeys-list">
          {EDITABLE_HOTKEYS.map(id => {
            const hk = hotkeys[id];
            if (!hk) return null;
            const isRecording = recording === id;
            const hasConflict = conflicts.some(c => c.id1 === id || c.id2 === id);
            return (
              <div key={id} className={`hotkey-row ${hasConflict ? 'conflict' : ''}`}>
                <div className="hotkey-info">
                  <span className="hotkey-label">{hk.label}</span>
                  <span className="hotkey-desc">{hk.description}</span>
                </div>
                <button
                  className={`hotkey-key ${isRecording ? 'recording' : ''}`}
                  onClick={() => handleRecord(id)}
                >
                  {isRecording ? 'Press a key...' : formatHotkey(hk)}
                </button>
              </div>
            );
          })}
        </div>

        {/* Non-editable shortcuts */}
        <div className="settings-section" style={{ marginTop: 12 }}>
          <h3>Fixed Shortcuts</h3>
          <div className="hotkey-row">
            <div className="hotkey-info">
              <span className="hotkey-label">Undo</span>
            </div>
            <span className="hotkey-key fixed">Ctrl + Z</span>
          </div>
          <div className="hotkey-row">
            <div className="hotkey-info">
              <span className="hotkey-label">Redo</span>
            </div>
            <span className="hotkey-key fixed">Ctrl + Y / Ctrl + Shift + Z</span>
          </div>
          <div className="hotkey-row">
            <div className="hotkey-info">
              <span className="hotkey-label">Copy</span>
            </div>
            <span className="hotkey-key fixed">Ctrl + C</span>
          </div>
          <div className="hotkey-row">
            <div className="hotkey-info">
              <span className="hotkey-label">Paste</span>
            </div>
            <span className="hotkey-key fixed">Ctrl + V</span>
          </div>
          {REFERENCE_ACTIONS && REFERENCE_ACTIONS.map((a, i) => (
            <div key={`ref-${i}`} className="hotkey-row">
              <div className="hotkey-info">
                <span className="hotkey-label">{a.label}</span>
                <span className="hotkey-desc">{a.description}</span>
              </div>
              <span className="hotkey-key fixed">{a.display}</span>
            </div>
          ))}
        </div>

        <div className="settings-row-btns" style={{ marginTop: 12 }}>
          <button className="settings-btn" onClick={handleReset}>Reset to Defaults</button>
        </div>

        <button className="settings-btn settings-back" onClick={onBack}>Back</button>
      </div>
    </div>
  );
}
