import { useState } from 'react';
import { saveColorScheme } from '../utils/storage';

const CHROMATIC = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const CHROMATIC_INTERNAL = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function defaultColors() {
  const colors = {};
  CHROMATIC_INTERNAL.forEach(n => { colors[n] = '#ffffff'; });
  return colors;
}

export default function SchemeEditorModal({ initialName = '', initialColors, onSave, onCancel }) {
  const [name, setName] = useState(initialName);
  const [colors, setColors] = useState(initialColors || defaultColors());

  const handleSave = () => {
    if (!name.trim()) return;
    saveColorScheme(name.trim(), colors);
    onSave(name.trim());
  };

  return (
    <div className="settings-overlay" onClick={onCancel}>
      <div className="settings-popup settings-popup-wide" onClick={(e) => e.stopPropagation()}>
        <h2 className="settings-title">New Color Scheme</h2>

        <div className="settings-row">
          <span className="settings-label">Name:</span>
          <input
            type="text"
            className="settings-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Scheme name"
            autoFocus
          />
        </div>

        <div className="scheme-edit-grid" style={{ marginTop: 12 }}>
          {CHROMATIC.map((displayName, i) => {
            const internalName = CHROMATIC_INTERNAL[i];
            return (
              <div key={internalName} className="settings-row">
                <span className="settings-label" style={{ width: 30 }}>{displayName}</span>
                <input
                  type="color"
                  value={colors[internalName] || '#ffffff'}
                  onChange={(e) => setColors(prev => ({ ...prev, [internalName]: e.target.value }))}
                />
              </div>
            );
          })}
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button className="settings-btn" onClick={handleSave} disabled={!name.trim()}>Save</button>
          <button className="settings-btn" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
