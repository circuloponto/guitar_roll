import { DEFAULT_ACCENT } from '../utils/accent';
import { useState, useEffect } from 'react';
import ConfirmDialog from './ConfirmDialog';
import {
  listColorSchemes, saveColorScheme, deleteColorScheme,
  listSessions, saveSession, loadSession, deleteSession,
  exportToFile, importFromFile, stateToUrl, getSessionState, DOWNLOAD_HINT,
} from '../utils/storage';
import SynthEditor from './SynthEditor';
import { SENSITIVITY } from '../utils/transcribe';
import { exportSessionZip, importSessionFile, sessionHasAudio } from '../utils/sessionBundle';
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

function colorsToSynesthesia(colors) {
  return Object.entries(colors)
    .filter(entry => entry[1] !== '#ffffff')
    .map(([note, color]) => ({ note, color }));
}

function getSessionSchemes(appState, savedSchemes) {
  const sessionSchemes = appState.sessionSchemes || {};
  const tracks = appState.tracks || [];
  const orderedNames = [];

  const addName = (name) => {
    if (name && !orderedNames.includes(name)) {
      orderedNames.push(name);
    }
  };

  if (appState.sessionScheme?.name) {
    addName(appState.sessionScheme.name);
  }

  tracks.forEach(track => {
    addName(track.schemeName);
  });

  Object.keys(sessionSchemes)
    .sort((a, b) => a.localeCompare(b))
    .forEach(addName);

  return orderedNames.map(name => {
    const sources = [];
    let isActive = false;

    if (appState.sessionScheme?.name === name) {
      sources.push('Global scheme');
      isActive = true;
    }

    tracks.forEach(track => {
      if (track.schemeName === name) {
        sources.push(`Track: ${track.name || track.id}`);
        isActive = true;
      }
    });

    return {
      name,
      colors: sessionSchemes[name] || savedSchemes[name] || appState.sessionScheme?.colors || {},
      sources,
      isActive,
    };
  });
}

export default function SettingsModal({ appState, onApplyState, onClose, onHotkeysChange, hoverPreview, onHoverPreviewChange, tupletLines, onTupletLinesChange, autoScroll, onAutoScrollChange, hoverPill, onHoverPillChange, autoSave, onAutoSaveChange, showTimelineVerticalZoomButtons, onShowTimelineVerticalZoomButtonsChange, fretboardAutoForward, onFretboardAutoForwardChange, fretboardAutoForwardExcludeAdjacent, onFretboardAutoForwardExcludeAdjacentChange, swungDisplay, onSwungDisplayChange, resetMultOnSubdiv, onResetMultOnSubdivChange, rhythmAltersSelected, onRhythmAltersSelectedChange, selectingSchemeClosesMenu, onSelectingSchemeClosesMenuChange, accent, onAccentChange, onRestoreAutosave, showSelectedOnFretboard, onShowSelectedOnFretboardChange, noteFade, onNoteFadeChange, txSettings, onTxSettingsChange, learned, onForgetLearning, onRetrain, showFretNumbers, onShowFretNumbersChange, openDots, onOpenDotsChange, openScroll, onOpenScrollChange, initialTab, synthInstrument, onSynthInstrumentChange }) {
  // Preferences-style layout: one tab per topic (like Ableton's Preferences).
  const [tab, setTab] = useState(() => { if (initialTab) return initialTab; try { return localStorage.getItem('guitar-roll-settings-tab') || 'look'; } catch { return 'look'; } });
  const [colorsView, setColorsView] = useState('list');   // list | edit
  const [projectView, setProjectView] = useState('main'); // main | sessions
  const selectTab = (id) => { setTab(id); try { localStorage.setItem('guitar-roll-settings-tab', id); } catch { /* ignore */ } };
  const openSchemes = () => { setTab('look'); setColorsView('list'); };
  const [editingScheme, setEditingScheme] = useState(null); // { name, originalName, colors }
  const [sessions, setSessions] = useState(listSessions);
  const [sessionName, setSessionName] = useState('');
  const [copyMsg, setCopyMsg] = useState('');
  const [exportHint, setExportHint] = useState('');
  const [confirm, setConfirm] = useState(null); // { message, onConfirm }
  const [schemeLibraryVersion, setSchemeLibraryVersion] = useState(0);
  const [nameConflict, setNameConflict] = useState(null); // { type, newName, oldName, colors }

  const refreshSessions = () => setSessions(listSessions());

  // Apply a color scheme to the app
  const applyScheme = (name, colors) => {
    onApplyState({
      synesthesia: colorsToSynesthesia(colors),
      sessionScheme: { name, colors },
    });
  };

  const normalizeSchemeColors = (colors) => (
    CHROMATIC_INTERNAL.map(name => (colors?.[name] || '#ffffff').toLowerCase()).join('|')
  );

  const findIdenticalScheme = (name, colors, schemes) => {
    const normalizedColors = normalizeSchemeColors(colors);

    return Object.entries(schemes).find(([schemeName, schemeColors]) => (
      schemeName !== name && normalizeSchemeColors(schemeColors) === normalizedColors
    ));
  };

  const showSessionNameConflict = (newName, colors, schemes) => {
    const identicalScheme = findIdenticalScheme(newName, colors, schemes);

    if (identicalScheme) {
      setNameConflict({
        type: 'session',
        newName,
        oldName: identicalScheme[0],
        colors,
      });
      openSchemes();
      return true;
    }

    return false;
  };

  const showSavedNameConflict = (newName, colors, schemes) => {
    const identicalScheme = findIdenticalScheme(newName, colors, schemes);

    if (identicalScheme) {
      setNameConflict({
        type: 'saved',
        newName,
        oldName: identicalScheme[0],
        colors,
      });
      openSchemes();
      return true;
    }

    return false;
  };

  const unapplySchemeFromSession = (name) => {
    const updates = {};

    if (appState.sessionScheme?.name === name) {
      updates.sessionScheme = null;
      updates.synesthesia = [];
    }

    if ((appState.tracks || []).some(track => track.schemeName === name)) {
      updates.tracks = (appState.tracks || []).map(track =>
        track.schemeName === name
          ? { ...track, schemeName: null }
          : track
      );
    }

    if (Object.keys(updates).length > 0) {
      onApplyState(updates);
    }
  };

  const removeSchemeFromSession = (name) => {
    const updates = {};

    if (appState.sessionScheme?.name === name) {
      updates.sessionScheme = null;
      updates.synesthesia = [];
    }

    if ((appState.tracks || []).some(track => track.schemeName === name)) {
      updates.tracks = (appState.tracks || []).map(track =>
        track.schemeName === name
          ? { ...track, schemeName: null }
          : track
      );
    }

    if (appState.sessionSchemes?.[name]) {
      updates.sessionSchemes = { ...appState.sessionSchemes };
      delete updates.sessionSchemes[name];
    }

    if (Object.keys(updates).length > 0) {
      onApplyState(updates);
    }
  };

  const deleteScheme = (name) => {
    setConfirm({
      message: `Delete color scheme "${name}"?`,
      onConfirm: () => {
        deleteColorScheme(name);
        removeSchemeFromSession(name);
        setConfirm(null);
      },
    });
  };

  const renameExistingSchemeToNewName = () => {
    if (!nameConflict) return;

    const { type, newName, oldName, colors } = nameConflict;

    if (type === 'saved') {
      saveColorScheme(newName, colors);
      deleteColorScheme(oldName);
      setSchemeLibraryVersion(version => version + 1);
    }

    const updates = {};
    const tracks = appState.tracks || [];

    if (tracks.some(track => track.schemeName === oldName || track.schemeName === newName)) {
      updates.tracks = tracks.map(track => {
        if (track.schemeName === oldName || track.schemeName === newName) {
          return { ...track, schemeName: newName };
        }
        return track;
      });
    }

    if (appState.sessionScheme?.name === oldName) {
      updates.sessionScheme = { name: newName, colors };
    }

    if (appState.sessionSchemes?.[oldName] || appState.sessionSchemes?.[newName]) {
      updates.sessionSchemes = { ...appState.sessionSchemes };
      delete updates.sessionSchemes[oldName];
      updates.sessionSchemes[newName] = colors;
    }

    if (Object.keys(updates).length > 0) {
      onApplyState(updates);
    }

    setNameConflict(null);
  };

  const useExistingSchemeName = () => {
    if (!nameConflict) return;

    if (nameConflict.type === 'saved') {
      saveColorScheme(nameConflict.oldName, nameConflict.colors);
      setSchemeLibraryVersion(version => version + 1);
    }

    setNameConflict(null);
  };

  // --- Colors tab: scheme manager / editor ---
  const renderSchemesView = () => {
    const savedSchemes = listColorSchemes();
    const sessionSchemeEntries = getSessionSchemes(appState, savedSchemes);
    const savedSchemesList = Object.entries(savedSchemes)
      .map(([name, colors]) => ({ name, colors }));

    const saveSchemeToLibrary = (scheme) => {
      if (showSavedNameConflict(scheme.name, scheme.colors, listColorSchemes())) {
        return;
      }

      saveColorScheme(scheme.name, scheme.colors);
      setSchemeLibraryVersion(version => version + 1);
    };

    function SchemePalette({ colors }) {
      return (
        <div className="scheme-colors-preview">
          {CHROMATIC_INTERNAL.map(n => (
            <div
              key={n}
              className="scheme-color-dot"
              style={{ background: colors?.[n] || '#ffffff' }}
            />
          ))}
        </div>
      );
    }

    function SchemeItem({ scheme, isActive, sources, isSessionItem }) {
      const isSavedScheme = Object.prototype.hasOwnProperty.call(savedSchemes, scheme.name);

      return (
        <div className="scheme-item">
          <div className="scheme-row">
            <span className="scheme-name">
              {scheme.name}
              {isActive && <span className="scheme-active-badge">Active</span>}
            </span>
          </div>

          <SchemePalette colors={scheme.colors} />

          {sources?.length > 0 && (
            <div className="scheme-source">
              Used by: {sources.join(', ')}
            </div>
          )}

          <div className="scheme-actions">
            {!isActive && (
              <button className="settings-btn-sm" onClick={() => applyScheme(scheme.name, scheme.colors)}>Apply</button>
            )}
            <button className="settings-btn-sm" onClick={() => {
              setEditingScheme({
                name: scheme.name,
                originalName: scheme.name,
                colors: { ...scheme.colors },
              });
              setColorsView('edit');
            }}>Edit</button>
            {isSessionItem && !isSavedScheme && (
              <button className="settings-btn-sm" onClick={() => saveSchemeToLibrary(scheme)}>
                Save
              </button>
            )}
            {isActive && (
              <button className="settings-btn-sm" onClick={() => unapplySchemeFromSession(scheme.name)}>
                Un-Apply
              </button>
            )}
            {isSessionItem ? (
              <button className="settings-btn-sm" onClick={() => removeSchemeFromSession(scheme.name)}>
                Remove
              </button>
            ) : (
              <button className="settings-btn-sm danger" onClick={() => deleteScheme(scheme.name)}>Delete</button>
            )}
          </div>
        </div>
      );
    }
    return (
      <>
          <div className="settings-section">
            <h3>Session Schemes</h3>

            <div className="schemes-list" key={schemeLibraryVersion}>
              {sessionSchemeEntries.length === 0 && (
                <p className="settings-empty">No color schemes are in this session.</p>
              )}
              {sessionSchemeEntries.map(scheme => (
                <SchemeItem
                  key={scheme.name}
                  scheme={scheme}
                  isActive={scheme.isActive}
                  sources={scheme.sources}
                  isSessionItem={true}
                />
              ))}
            </div>
          </div>

          <div className="settings-section" style={{ marginTop: 16 }}>
            <h3>Saved Color Schemes</h3>

            <div className="schemes-list" key={schemeLibraryVersion}>
              {savedSchemesList.length === 0 && (
                <p className="settings-empty">No saved color schemes.</p>
              )}
              {savedSchemesList.map(scheme => (
                <SchemeItem
                  key={scheme.name}
                  scheme={scheme}
                  isActive={false}
                  isSessionItem={false}
                />
              ))}
            </div>
          </div>

          <div className="settings-row-btns" style={{ marginTop: 12 }}>
            <button className="settings-btn" onClick={() => {
              setEditingScheme({
                name: '',
                originalName: '',
                colors: defaultSchemeColors(),
              });
              setColorsView('edit');
            }}>
              + Create Scheme
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
      </>
    );
  };

  const renderEditView = () => (
    <div>
      <button className="settings-link-btn" onClick={() => setColorsView('list')}>&larr; Back to Color Schemes</button>
          <h3 className="settings-subtitle">{editingScheme.originalName ? 'Edit Color Scheme' : 'New Color Scheme'}</h3>

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
              const originalName = editingScheme.originalName || '';
              const newName = editingScheme.name.trim();
              if (!newName) return;

              const colors = editingScheme.colors;
              const sessionSchemesForCheck = { ...(appState.sessionSchemes || {}) };
              if (originalName) {
                delete sessionSchemesForCheck[originalName];
              }

              if (showSessionNameConflict(newName, colors, sessionSchemesForCheck)) {
                return;
              }

              onApplyState({
                sessionSchemes: {
                  ...sessionSchemesForCheck,
                  [newName]: colors,
                },
              });
              setColorsView('list');
            }}>
              Add to Session
            </button>
            <button className="settings-btn" onClick={() => {
              const originalName = editingScheme.originalName || '';
              const newName = editingScheme.name.trim();
              if (!newName) return;

              const savedSchemesForCheck = listColorSchemes();
              if (originalName) {
                delete savedSchemesForCheck[originalName];
              }

              if (showSavedNameConflict(newName, editingScheme.colors, savedSchemesForCheck)) {
                return;
              }

              if (originalName && originalName !== newName) {
                saveColorScheme(newName, editingScheme.colors);
                deleteColorScheme(originalName);

                const updates = {};

                if (appState.sessionScheme?.name === originalName) {
                  updates.sessionScheme = {
                    name: newName,
                    colors: editingScheme.colors,
                  };
                }

                if ((appState.tracks || []).some(track => track.schemeName === originalName)) {
                  updates.tracks = (appState.tracks || []).map(track =>
                    track.schemeName === originalName
                      ? { ...track, schemeName: newName }
                      : track
                  );
                }

                if (appState.sessionSchemes?.[originalName]) {
                  updates.sessionSchemes = { ...appState.sessionSchemes };
                  delete updates.sessionSchemes[originalName];
                  updates.sessionSchemes[newName] = editingScheme.colors;
                }

                if (Object.keys(updates).length > 0) {
                  onApplyState(updates);
                }
              } else {
                saveColorScheme(newName, editingScheme.colors);
              }

              setSchemeLibraryVersion(version => version + 1);
              setColorsView('list');
            }}>
              Save Scheme
            </button>
            <button className="settings-btn" onClick={() => setColorsView('list')}>
              Cancel
            </button>
          </div>
    </div>
  );

  const renderSessionsView = () => {
    const sessionNames = Object.keys(sessions).sort((a, b) =>
      (sessions[b].savedAt || 0) - (sessions[a].savedAt || 0)
    );
    return (
      <div>
        <button className="settings-link-btn" onClick={() => setProjectView('main')}>&larr; Back to Project</button>
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
      </div>
    );
  };

  const TABS = [
    { id: 'look', label: 'Look & Feel' },
    { id: 'playback', label: 'Playback' },
    { id: 'synth', label: 'Synth' },
    { id: 'transcription', label: 'Transcription' },
    { id: 'fretboard', label: 'Fretboard' },
    { id: 'timeline', label: 'Timeline' },
    { id: 'shortcuts', label: 'Shortcuts' },
    { id: 'project', label: 'Project' },
  ];
  const activeTab = TABS.some(t => t.id === tab) ? tab : 'look';

  let pane = null;
  if (activeTab === 'look') {
    pane = colorsView === 'edit' && editingScheme ? renderEditView() : (
      <>
          <div className="settings-section">
            <h3>Accent Color</h3>
            <p className="settings-desc">Highlight color used for the play button, active tabs, selections and the loop region.</p>
            <div className="settings-row" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <input
                type="color"
                value={accent || DEFAULT_ACCENT}
                onChange={(e) => onAccentChange(e.target.value)}
                style={{ width: 44, height: 28, padding: 0, border: '1px solid var(--line)', borderRadius: 4, background: 'transparent', cursor: 'pointer' }}
                aria-label="Accent color"
              />
              <span style={{ fontSize: 12, color: 'var(--mute)', fontFamily: 'var(--mono)' }}>{(accent || DEFAULT_ACCENT).toUpperCase()}</span>
              <button className="tool-btn" onClick={() => onAccentChange(DEFAULT_ACCENT)} disabled={(accent || DEFAULT_ACCENT).toLowerCase() === DEFAULT_ACCENT}>Reset</button>
            </div>
          </div>
        <div className="settings-section">
          <h3>Layout</h3>
          <p className="settings-desc">Drag a panel by its title bar to move it, and resize panels from the lines between them.</p>
          <button className="settings-btn" onClick={() => window.dispatchEvent(new Event('guitar-roll-reset-layout'))}>Reset layout</button>
        </div>
        <h3 className="settings-subtitle" style={{ marginTop: 24 }}>Colors</h3>
        {renderSchemesView()}
        <div className="settings-section" style={{ marginTop: 16 }}>
          <h3>Instance Color Menu</h3>
          <div className="settings-row">
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--soft)', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={selectingSchemeClosesMenu ?? true}
                onChange={(e) => onSelectingSchemeClosesMenuChange(e.target.checked)}
              />
              Selecting a scheme closes the instance-color menu
            </label>
          </div>
        </div>
      </>
    );
  } else if (activeTab === 'playback') {
    pane = (<>
          <div className="settings-section">
            <h3>Hover Sound Preview</h3>
            <p className="settings-desc">Play the note under the cursor on hover.</p>
            <div className="settings-checks">
              {[
                { key: 'fretboard', label: 'Fretboard' },
                { key: 'pianoRoll', label: 'Piano Roll Keys' },
                { key: 'timelineNotes', label: 'Timeline Notes' },
              ].map(({ key, label }) => (
                <label key={key} className="settings-check">
                  <input
                    type="checkbox"
                    checked={hoverPreview[key] || false}
                    onChange={(e) => onHoverPreviewChange({ ...hoverPreview, [key]: e.target.checked })}
                  />
                  {label}
                </label>
              ))}
            </div>
            <div className="settings-row" style={{ marginTop: 6 }}>
              <span style={{ fontSize: 13, color: 'var(--soft)', marginRight: 8 }}>Volume</span>
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round((hoverPreview.volume ?? 0.3) * 100)}
                onChange={(e) => onHoverPreviewChange({ ...hoverPreview, volume: Number(e.target.value) / 100 })}
                style={{ width: 120 }}
              />
              <span style={{ fontSize: 12, color: 'var(--mute)', marginLeft: 6 }}>{Math.round((hoverPreview.volume ?? 0.3) * 100)}%</span>
            </div>
          </div>
    </>);
  } else if (activeTab === 'transcription') {
    const tx = txSettings || {};
    pane = (
      <>
        <div className="settings-section">
          <h3>Draft from audio</h3>
          <p className="settings-desc">
            Right-click an audio track and choose "Transcribe to a draft track…". The recording is
            analysed in your browser (nothing is uploaded) and the notes are put on the grid using the
            tempo map and sync points, then fingered on the fretboard. Treat it as a first draft to
            correct by ear: faint notes are the ones the model was least sure of.
          </p>
          <div className="settings-row">
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--soft)' }}>
              Sensitivity
              <select className="duration-select" value={tx.sensitivity} onChange={(e) => onTxSettingsChange({ sensitivity: e.target.value })}>
                {Object.entries(SENSITIVITY).map(([id, s]) => <option key={id} value={id}>{s.label}</option>)}
              </select>
            </label>
          </div>
          <div className="settings-row" style={{ marginTop: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--soft)' }}>
              Shortest note
              <input type="range" min={30} max={250} step={10} value={tx.minNoteMs} onChange={(e) => onTxSettingsChange({ minNoteMs: Number(e.target.value) })} style={{ width: 140 }} />
              <span style={{ fontSize: 12, color: 'var(--mute)', minWidth: 48 }}>{tx.minNoteMs} ms</span>
            </label>
          </div>
          <div className="settings-row" style={{ marginTop: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--soft)' }} title="Notes that start within this time of each other are treated as one chord (a strum spreads over a few tens of ms)">
              Chord grouping
              <input type="range" min={0} max={120} step={5} value={tx.chordMs} onChange={(e) => onTxSettingsChange({ chordMs: Number(e.target.value) })} style={{ width: 140 }} />
              <span style={{ fontSize: 12, color: 'var(--mute)', minWidth: 48 }}>{tx.chordMs} ms</span>
            </label>
          </div>
          <div className="settings-row" style={{ marginTop: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--soft)', cursor: 'pointer' }}>
              <input type="checkbox" checked={tx.harmonicFilter ?? true} onChange={(e) => onTxSettingsChange({ harmonicFilter: e.target.checked })} />
              Ignore overtones (weak notes an octave or more above a stronger note)
            </label>
          </div>
          <span className="settings-sublabel" style={{ marginTop: 12 }}>Too many bass notes?</span>
          <div className="settings-row" style={{ marginTop: 4 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--soft)' }} title="Notes below this are ignored">
              Lowest note
              <select className="duration-select" value={tx.lowestMidi ?? 40} onChange={(e) => onTxSettingsChange({ lowestMidi: Number(e.target.value) })}>
                <option value={40}>E2 (open low E)</option>
                <option value={43}>G2</option>
                <option value={45}>A2 (open A string)</option>
                <option value={47}>B2</option>
                <option value={50}>D3 (open D string)</option>
                <option value={52}>E3</option>
                <option value={55}>G3 (open G string)</option>
              </select>
            </label>
          </div>
          <div className="settings-row" style={{ marginTop: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--soft)' }} title="Below E3 a note must be at least this strong compared with the typical note. 0 = off">
              Bass strength needed
              <input type="range" min={0} max={100} step={5} value={Math.round((tx.bassStrength ?? 0.4) * 100)} onChange={(e) => onTxSettingsChange({ bassStrength: Number(e.target.value) / 100 })} style={{ width: 140 }} />
              <span style={{ fontSize: 12, color: 'var(--mute)', minWidth: 48 }}>{Math.round((tx.bassStrength ?? 0.4) * 100)}%</span>
            </label>
          </div>
          <div className="settings-row" style={{ marginTop: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--soft)', cursor: 'pointer' }} title="The model sometimes adds the pitch an octave below a real note. Deliberate octave pairs of equal strength are kept either way">
              <input type="checkbox" checked={tx.octaveDownFilter ?? true} onChange={(e) => onTxSettingsChange({ octaveDownFilter: e.target.checked })} />
              Ignore a weak note an octave below a stronger one
            </label>
          </div>
          <span className="settings-sublabel" style={{ marginTop: 14 }}>Check the notes against the attacks</span>
          <div className="settings-row" style={{ marginTop: 4 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--soft)' }} title="A real note starts with a pluck. The attacks are detected separately from the pitch model. Hammer-ons and slides start without one, which is why 'all notes' can remove real notes">
              Require an attack under a note
              <select className="duration-select" value={tx.attackGate ?? 'bass'} onChange={(e) => onTxSettingsChange({ attackGate: e.target.value })}>
                <option value="off">Off</option>
                <option value="bass">Low notes only (recommended)</option>
                <option value="all">All notes</option>
              </select>
            </label>
          </div>
          <div className="settings-row" style={{ marginTop: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--soft)' }} title="At most this many notes can start at the same attack (a guitar has six strings). The strongest are kept. Use 1 to 3 for a melody">
              Most notes per attack
              <input type="range" min={1} max={6} step={1} value={tx.maxPerAttack ?? 6} onChange={(e) => onTxSettingsChange({ maxPerAttack: Number(e.target.value) })} style={{ width: 120 }} />
              <span style={{ fontSize: 12, color: 'var(--mute)', minWidth: 20 }}>{tx.maxPerAttack ?? 6}</span>
            </label>
          </div>
          <span className="settings-sublabel" style={{ marginTop: 14 }}>What it has learned from you</span>
          <p className="settings-desc" style={{ marginTop: 4 }}>
            Write a stretch of a recording by hand, then right-click the audio track and choose "Teach it from my notes…".
            It compares its own findings with yours and learns which of its notes to trust, so later drafts have fewer
            false notes. It prefers missing a note to inventing one. Everything stays in this browser.
          </p>
          <div className="settings-row">
            <span style={{ fontSize: 13, color: 'var(--soft)' }}>
              {learned
                ? `Taught with ${learned.samples} candidates (${learned.positives} real). On those it keeps ${Math.round(learned.recall * 100)}% of the real notes and ${Math.round(learned.precision * 100)}% of what it keeps is right.`
                : 'Not taught yet.'}
            </span>
          </div>
          <div className="settings-row" style={{ marginTop: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--soft)', cursor: 'pointer' }}>
              <input type="checkbox" checked={tx.useLearned ?? true} onChange={(e) => onTxSettingsChange({ useLearned: e.target.checked })} />
              Use what it learned when transcribing
            </label>
          </div>
          <div className="settings-row" style={{ marginTop: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--soft)' }} title="How sure it must be before a note is kept. Higher = fewer notes, fewer mistakes">
              Aim for
              <select className="duration-select" value={tx.targetPrecision ?? 0.85} onChange={(e) => { const v = Number(e.target.value); onTxSettingsChange({ targetPrecision: v }); onRetrain(v); }}>
                <option value={0.75}>75% of its notes right (more notes)</option>
                <option value={0.85}>85% right</option>
                <option value={0.92}>92% right</option>
                <option value={0.97}>97% right (only the surest)</option>
              </select>
            </label>
          </div>
          <div className="settings-row" style={{ marginTop: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--soft)' }} title="Nudge how strict it is, without retraining">
              Fine tune
              <span style={{ fontSize: 11, color: 'var(--mute)' }}>more notes</span>
              <input type="range" min={-20} max={20} step={2} value={Math.round((tx.learnStrictness ?? 0) * 100)} onChange={(e) => onTxSettingsChange({ learnStrictness: Number(e.target.value) / 100 })} style={{ width: 120 }} />
              <span style={{ fontSize: 11, color: 'var(--mute)' }}>fewer notes</span>
            </label>
          </div>
          <div className="settings-row" style={{ marginTop: 8 }}>
            <button className="settings-btn" onClick={() => { if (window.confirm('Forget everything it has learned from your notes?')) onForgetLearning(); }} disabled={!learned}>Forget what it learned</button>
          </div>

          <div className="settings-row" style={{ marginTop: 14 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--soft)', cursor: 'pointer' }}>
              <input type="checkbox" checked={tx.heatAfter ?? true} onChange={(e) => onTxSettingsChange({ heatAfter: e.target.checked })} />
              Show the pitch heat map behind the roll after transcribing
            </label>
          </div>
        </div>
      </>
    );
  } else if (activeTab === 'synth') {
    pane = <SynthEditor embedded currentInstrument={synthInstrument} onInstrumentChange={onSynthInstrumentChange} />;
  } else if (activeTab === 'fretboard') {
    pane = (<>
          <div className="settings-section">
            <h3>Fretboard</h3>
            <span className="settings-sublabel">Auto-scroll to keep frets in view</span>
            <div className="settings-checks">
              {[
                { key: 'onHover', label: 'On note hover' },
                { key: 'onInput', label: 'On note input' },
                { key: 'onPlayback', label: 'During playback' },
              ].map(({ key, label }) => (
                <label key={key} className="settings-check">
                  <input
                    type="checkbox"
                    checked={autoScroll?.[key] ?? true}
                    onChange={(e) => onAutoScrollChange({ ...autoScroll, [key]: e.target.checked })}
                  />
                  {label}
                </label>
              ))}
            </div>
            <span className="settings-sublabel">Note marker under the cursor</span>
            <div className="settings-checks">
              {[
                { key: 'fretboard', label: 'On fretboard hover' },
                { key: 'pianoRoll', label: 'On piano roll hover' },
              ].map(({ key, label }) => (
                <label key={key} className="settings-check">
                  <input
                    type="checkbox"
                    checked={hoverPill?.[key] ?? true}
                    onChange={(e) => onHoverPillChange({ ...hoverPill, [key]: e.target.checked })}
                  />
                  {label}
                </label>
              ))}
            </div>

            <span className="settings-sublabel">Display</span>
            <div className="settings-row">
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--soft)', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={showFretNumbers ?? true}
                  onChange={(e) => onShowFretNumbersChange(e.target.checked)}
                />
                Show fret numbers
              </label>
            </div>

            <span className="settings-sublabel">Open strings</span>
            <div className="settings-row">
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--soft)', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={openDots ?? true}
                  onChange={(e) => onOpenDotsChange(e.target.checked)}
                />
                Show a note dot on open strings (off: just the string glow)
              </label>
            </div>
            <div className="settings-row" style={{ marginTop: 6 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--soft)', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={openScroll ?? true}
                  onChange={(e) => onOpenScrollChange(e.target.checked)}
                />
                Open strings can trigger auto-scroll
              </label>
            </div>

            <span className="settings-sublabel">Playback visuals</span>
            <div className="settings-row">
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--soft)' }}>
                Note fade-out
                <select
                  className="duration-select"
                  value={noteFade ?? 'normal'}
                  onChange={(e) => onNoteFadeChange(e.target.value)}
                  title="How long notes take to fade on the fretboard during playback. It follows each note's length and the tempo."
                >
                  <option value="off">Off (hold until the note ends)</option>
                  <option value="short">Short</option>
                  <option value="normal">Normal</option>
                  <option value="long">Long</option>
                </select>
              </label>
            </div>

            <span className="settings-sublabel">Selection</span>
            <div className="settings-row">
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--soft)', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={showSelectedOnFretboard ?? true}
                  onChange={(e) => onShowSelectedOnFretboardChange(e.target.checked)}
                />
                Show selected notes on the fretboard
              </label>
            </div>

            <span className="settings-sublabel">Input behavior</span>
            <div className="settings-row">
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--soft)', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={fretboardAutoForward ?? false}
                  onChange={(e) => onFretboardAutoForwardChange(e.target.checked)}
                />
                Auto-forward after note input / duration change
              </label>
            </div>
            <div className="settings-row" style={{ marginTop: 6 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: fretboardAutoForward ? '#ccc' : '#888', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={fretboardAutoForwardExcludeAdjacent ?? true}
                  onChange={(e) => onFretboardAutoForwardExcludeAdjacentChange(e.target.checked)}
                  disabled={!fretboardAutoForward}
                />
                Exclude adjacent mode from auto-forward
              </label>
            </div>
          </div>
    </>);
  } else if (activeTab === 'timeline') {
    pane = (<>
          <div className="settings-section">
            <h3>Tuplet Grid Lines</h3>
            <p className="settings-desc">Subdivision lines between beats in the grid.</p>
            <div className="settings-row">
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--soft)', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={tupletLines?.visible ?? true}
                  onChange={(e) => onTupletLinesChange({ ...tupletLines, visible: e.target.checked })}
                />
                Show subdivision lines
              </label>
            </div>
            <div className="settings-row" style={{ marginTop: 6 }}>
              <span style={{ fontSize: 13, color: 'var(--soft)', marginRight: 8 }}>Opacity</span>
              <input
                type="range"
                min={5}
                max={100}
                value={Math.round((tupletLines?.opacity ?? 0.35) * 100)}
                onChange={(e) => onTupletLinesChange({ ...tupletLines, opacity: Number(e.target.value) / 100 })}
                style={{ width: 120 }}
                disabled={!(tupletLines?.visible ?? true)}
              />
              <span style={{ fontSize: 12, color: 'var(--mute)', marginLeft: 6 }}>{Math.round((tupletLines?.opacity ?? 0.35) * 100)}%</span>
            </div>
          </div>
          <div className="settings-section">
            <h3>Timeline</h3>
            <p className="settings-desc">On-screen controls for the timeline pane.</p>
            <div className="settings-row">
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--soft)', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={showTimelineVerticalZoomButtons !== false}
                  onChange={(e) => onShowTimelineVerticalZoomButtonsChange(e.target.checked)}
                />
                Dock vertical zoom buttons (top-right)
              </label>
            </div>

              <div className="settings-row" style={{ marginTop: 6 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--soft)', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={swungDisplay ?? false}
                    onChange={(e) => onSwungDisplayChange(e.target.checked)}
                  />
                  Swung grid display
                </label>
              </div>

              <div className="settings-row" style={{ marginTop: 6 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--soft)', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={resetMultOnSubdiv ?? true}
                    onChange={(e) => onResetMultOnSubdivChange(e.target.checked)}
                  />
                  Changing ÷ number resets × to 1
                </label>
              </div>

              <div className="settings-row" style={{ marginTop: 6 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--soft)', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={rhythmAltersSelected ?? true}
                    onChange={(e) => onRhythmAltersSelectedChange(e.target.checked)}
                  />
                  Changing ÷ or × alters selected note lengths
                </label>
              </div>
          </div>
    </>);
  } else if (activeTab === 'shortcuts') {
    pane = <HotkeysPage onHotkeysChange={onHotkeysChange} />;
  } else if (activeTab === 'project') {
    pane = projectView === 'sessions' ? renderSessionsView() : (<>
          <div className="settings-section">
            <h3>Autosave</h3>
            <p className="settings-desc">Back up this session in your browser while you work.</p>
            <div className="settings-row">
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--soft)', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={autoSave ?? true}
                  onChange={(e) => onAutoSaveChange(e.target.checked)}
                />
                Autosave every 30 seconds
              </label>
            </div>
            <div className="settings-row-btns">
              <button
                className="settings-btn"
                onClick={() => {
                  if (!window.confirm('Replace the current session with the last autosave?')) return;
                  if (!onRestoreAutosave?.()) window.alert('There is no autosave yet.');
                  else onClose();
                }}
              >
                Restore last autosave
              </button>
            </div>
          </div>
          <div className="settings-section">
            <h3>Sessions</h3>
            <p className="settings-desc">Save in this browser, move between devices as files, or share as a link.</p>
            <div className="settings-row-btns">
              <button className="settings-btn" onClick={() => { refreshSessions(); setProjectView('sessions'); }}>
                Save / Load Session
              </button>
            </div>
            <div className="settings-row-btns">
              <button
                className="settings-btn"
                title="Saves the session. If it has audio tracks it saves a .zip with the audio files inside, so importing it brings back the audio and sync points."
                onClick={async () => {
                  const state = getSessionState(appState);
                  try {
                    if (sessionHasAudio(state)) {
                      const r = await exportSessionZip(state, `${appState.projectName || 'guitar-roll'}.zip`);
                      if (r.saved) {
                        setCopyMsg(`Exported with ${r.audioCount} audio file${r.audioCount === 1 ? '' : 's'}${r.missing.length ? ` (${r.missing.length} missing)` : ''}`);
                        setTimeout(() => setCopyMsg(''), 3500);
                        setExportHint(r.saved === 'download' ? DOWNLOAD_HINT : '');
                      }
                    } else {
                      const how = await exportToFile(state, `${appState.projectName || 'guitar-roll'}.json`);
                      setExportHint(how === 'download' ? DOWNLOAD_HINT : '');
                    }
                  } catch (error) {
                    console.warn('Export failed', error);
                    window.alert('Could not export: ' + (error.message || error));
                  }
                }}
              >
                Export to File
              </button>
              <button className="settings-btn" onClick={async () => {
                try {
                  const { data, audioCount } = await importSessionFile();
                  onApplyState(data);
                  if (audioCount) { setCopyMsg(`Imported with ${audioCount} audio file${audioCount > 1 ? 's' : ''}`); setTimeout(() => setCopyMsg(''), 3000); }
                } catch (error) {
                  console.warn('Import failed', error);
                  if (error && error !== 'No file') window.alert('Could not import this file: ' + (error.message || error));
                }
              }}>
                Import from File
              </button>
            </div>
            {exportHint && <p className="settings-desc" style={{ marginTop: 6 }}>{exportHint}</p>}
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
    </>);
  }

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-prefs" onClick={e => e.stopPropagation()}>
        <nav className="settings-tabs" aria-label="Settings sections">
          <div className="settings-tabs-title">Settings</div>
          {TABS.map(t => (
            <button
              key={t.id}
              className={`settings-tab${activeTab === t.id ? ' active' : ''}`}
              onClick={() => selectTab(t.id)}
            >{t.label}</button>
          ))}
        </nav>
        <div className="settings-pane">
          <button className="settings-x" onClick={onClose} title="Close" aria-label="Close">&times;</button>
          <h2 className="settings-pane-title">{TABS.find(t => t.id === activeTab)?.label}</h2>
          {pane}
        </div>
      </div>
        {confirm && (
          <ConfirmDialog message={confirm.message} onConfirm={confirm.onConfirm} onCancel={() => setConfirm(null)} />
        )}
        {nameConflict && (
          <div className="confirm-overlay" onClick={() => setNameConflict(null)}>
            <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
              <div className="confirm-message">
                {nameConflict.type === 'session'
                  ? `You have an identical scheme in the session already (${nameConflict.oldName}).`
                  : `You have an identical scheme in Saved already (${nameConflict.oldName}).`}
              </div>
              <div className="confirm-actions vertical">
                <button
                  className="settings-btn"
                  onClick={renameExistingSchemeToNewName}
                >
                  Rename "{nameConflict.oldName}" to "{nameConflict.newName}"
                </button>
                <button
                  className="settings-btn"
                  onClick={useExistingSchemeName}
                >
                  Rename "{nameConflict.newName}" to "{nameConflict.oldName}"
                </button>
                <button className="settings-btn" onClick={() => setNameConflict(null)}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
    </div>
  );
}

function HotkeysPage({ onHotkeysChange }) {
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
    <div>
      <div className="settings-pane-actions">
        <p className="settings-desc" style={{ margin: 0 }}>Click a key to rebind it. Hover a shortcut for details.</p>
        <button className="settings-btn" onClick={handleReset}>Reset to Defaults</button>
      </div>

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
              <div key={id} className={`hotkey-row ${hasConflict ? 'conflict' : ''}`} title={hk.description}>
                <span className="hotkey-label">{hk.label}</span>
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
        <div className="settings-group">Fixed Shortcuts</div>
        <div className="hotkeys-list">
          {[
            { label: 'Undo', display: 'Ctrl + Z' },
            { label: 'Redo', display: 'Ctrl + Y / Ctrl + Shift + Z' },
            { label: 'Copy', display: 'Ctrl + C' },
            { label: 'Paste', display: 'Ctrl + V' },
            ...(REFERENCE_ACTIONS || []),
          ].map((a, i) => (
            <div key={`ref-${i}`} className="hotkey-row" title={a.description}>
              <span className="hotkey-label">{a.label}</span>
              <span className="hotkey-key fixed">{a.display}</span>
            </div>
          ))}
        </div>

    </div>
  );
}
