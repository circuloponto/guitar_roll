import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { getAllInstruments } from '../utils/audio';
import { listColorSchemes } from '../utils/storage';
import ConfirmDialog from './ConfirmDialog';
import SchemeEditorModal from './SchemeEditorModal';

export default function TrackStrip({
  tracks, activeTrackId, onSwitchTrack,
  onToggleMute, onToggleSolo, onSetVolume,
  onAddTrack, onDeleteTrack, onDuplicateTrack, onReorderTracks, onRenameTrack,
  onToggleVisible, onSetBgOpacity, onSetTrackScheme,
  onLoadAudio, onRemoveAudio, onSetAudioOptions, onAddSyncPoint, onAutoSync, onClearSyncPoints,
  sessionSchemes = {},
}) {
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const [newSchemeForTrack, setNewSchemeForTrack] = useState(null);
  const [schemesVersion, setSchemesVersion] = useState(0); // bump to refresh dropdown
  const [dragIndex, setDragIndex] = useState(null);
  const [dragOverIndex, setDragOverIndex] = useState(null);

  const startRename = (track) => {
    setEditingId(track.id);
    setEditName(track.name);
  };

  const commitRename = () => {
    if (editingId && editName.trim()) {
      onRenameTrack(editingId, editName.trim());
    }
    setEditingId(null);
  };

  const allInst = getAllInstruments();
  // eslint-disable-next-line no-unused-vars
  const _v = schemesVersion;
  const schemes = listColorSchemes();
  const schemeNames = Array.from(new Set([
    ...Object.keys(schemes),
    ...Object.keys(sessionSchemes || {}),
  ]));

  return (
    <div className={`track-panel ${expanded ? 'expanded' : ''}`}>
      {/* Slim header bar — always visible */}
      <div className="track-header">
        <button
          className="track-expand-btn"
          onClick={() => setExpanded(e => !e)}
          title={expanded ? 'Collapse tracks' : 'Expand tracks'}
        >
          {expanded ? '▾' : '▸'} Tracks ({tracks.length})
        </button>
        <div className="track-tabs-row">
          {tracks.map(track => {
            const isActive = track.id === activeTrackId;
            return (
              <button
                key={track.id}
                className={`track-tab-mini ${isActive ? 'active' : ''} ${track.muted ? 'muted' : ''}`}
                onClick={() => onSwitchTrack(track.id)}
              >
                {track.name}
                {track.muted && <span className="track-mini-badge">M</span>}
                {track.solo && <span className="track-mini-badge solo">S</span>}
                <span
                  className="track-mini-x"
                  role="button"
                  title="Delete track"
                  onClick={(e) => {
                    e.stopPropagation();
                    if ((track.notes && track.notes.length > 0) || track.audioFileName) setConfirmDelete(track);
                    else onDeleteTrack(track.id);
                  }}
                >×</span>
              </button>
            );
          })}
          <button className="track-add-btn-mini" onClick={onAddTrack} title="Add track">+</button>
        </div>
      </div>

      {/* Expanded panel — full track controls */}
      {expanded && (
        <div className="track-rows">
          {tracks.map((track, index) => {
            const isActive = track.id === activeTrackId;
            const instLabel = allInst[track.instrument]?.label || track.instrument;
            return (
              <div
                key={track.id}
                className={`track-row ${isActive ? 'active' : ''} ${track.muted ? 'muted' : ''} ${dragOverIndex === index ? 'drag-over' : ''}`}
                onClick={() => onSwitchTrack(track.id)}
                draggable
                onDragStart={(e) => {
                  setDragIndex(index);
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  setDragOverIndex(index);
                }}
                onDragLeave={() => setDragOverIndex(null)}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragIndex !== null && dragIndex !== index) {
                    onReorderTracks(dragIndex, index);
                  }
                  setDragIndex(null);
                  setDragOverIndex(null);
                }}
                onDragEnd={() => { setDragIndex(null); setDragOverIndex(null); }}
              >
                <div className="track-row-name">
                  {editingId === track.id ? (
                    <input
                      className="track-name-input"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename();
                        if (e.key === 'Escape') setEditingId(null);
                        e.stopPropagation();
                      }}
                      onClick={(e) => e.stopPropagation()}
                      autoFocus
                    />
                  ) : (
                    <span
                      className="track-row-name-text"
                      onDoubleClick={(e) => { e.stopPropagation(); startRename(track); }}
                    >
                      {track.name}
                    </span>
                  )}
                  <span className="track-row-inst">{instLabel}</span>
                </div>

                <div className="track-row-controls">
                  <button
                    className={`track-btn-lg ${track.muted ? 'active-red' : ''}`}
                    onClick={(e) => { e.stopPropagation(); onToggleMute(track.id); }}
                    title="Mute"
                  >M</button>
                  <button
                    className={`track-btn-lg ${track.solo ? 'active-yellow' : ''}`}
                    onClick={(e) => { e.stopPropagation(); onToggleSolo(track.id); }}
                    title="Solo"
                  >S</button>
                  {!isActive && onToggleVisible && (
                    <button
                      className={`track-btn-lg ${track.visible === false ? 'active-red' : ''}`}
                      onClick={(e) => { e.stopPropagation(); onToggleVisible(track.id); }}
                      title={track.visible === false ? 'Show ghost notes' : 'Hide ghost notes'}
                    >
                      {track.visible === false ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  )}

                  <div className="track-slider-group">
                    <label className="track-slider-label">Vol</label>
                    <input
                      type="range"
                      className="track-slider"
                      min={0}
                      max={100}
                      value={Math.round(track.volume * 100)}
                      onChange={(e) => { e.stopPropagation(); onSetVolume(track.id, Number(e.target.value) / 100); }}
                      onClick={(e) => e.stopPropagation()}
                    />
                    <span className="track-slider-val">{Math.round(track.volume * 100)}%</span>
                  </div>

                  {!isActive && onSetBgOpacity && track.visible !== false && (
                    <div className="track-slider-group">
                      <label className="track-slider-label">Opacity</label>
                      <input
                        type="range"
                        className="track-slider track-slider-ghost"
                        min={5}
                        max={100}
                        value={Math.round((track.bgOpacity ?? 0.2) * 100)}
                        onChange={(e) => { e.stopPropagation(); onSetBgOpacity(track.id, Number(e.target.value) / 100); }}
                        onClick={(e) => e.stopPropagation()}
                      />
                      <span className="track-slider-val">{Math.round((track.bgOpacity ?? 0.2) * 100)}%</span>
                    </div>
                  )}

                  {onSetTrackScheme && (
                    <div className="track-slider-group">
                      <label className="track-slider-label">Scheme</label>
                      <select
                        className="track-scheme-select"
                        value={track.schemeName || ''}
                        onChange={(e) => {
                          if (e.target.value === '__new__') {
                            setNewSchemeForTrack(track.id);
                          } else {
                            onSetTrackScheme(track.id, e.target.value || null);
                          }
                        }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <option value="">Default</option>
                        {schemeNames.map(name => (
                          <option key={name} value={name}>{name}</option>
                        ))}
                        <option value="__new__">+ New Scheme...</option>
                      </select>
                    </div>
                  )}

                  {track.type === 'audio' && track.audioFileName ? (
                    <div className="track-slider-group">
                      <span className="track-slider-label" style={{ color: 'var(--accent-hi)' }} title={track.audioFileName}>
                        🎵 {track.audioFileName.length > 12 ? track.audioFileName.slice(0, 12) + '…' : track.audioFileName}
                      </span>
                      <button
                        className="track-btn-lg"
                        onClick={(e) => { e.stopPropagation(); onRemoveAudio(track.id); }}
                        title="Remove audio"
                        style={{ color: 'var(--danger)', fontSize: 11 }}
                      >✕</button>
                      {/* Pitch: lock keeps the original pitch when tempo changes; semitones transpose */}
                      <button
                        className={`track-btn-lg ${track.keepPitch === false ? '' : 'active-accent'}`}
                        onClick={(e) => { e.stopPropagation(); onSetAudioOptions(track.id, { keepPitch: track.keepPitch === false }); }}
                        title={track.keepPitch === false
                          ? 'Pitch follows tempo (like tape). Click to keep original pitch when tempo changes.'
                          : 'Pitch is kept when tempo changes. Click to let pitch follow tempo (like tape).'}
                        style={{ fontSize: 11 }}
                      >{track.keepPitch === false ? 'Pitch: free' : 'Pitch: lock'}</button>
                      <button
                        className="track-btn-lg"
                        onClick={(e) => { e.stopPropagation(); onSetAudioOptions(track.id, { pitchSemitones: Math.max(-12, (track.pitchSemitones || 0) - 1) }); }}
                        title="Transpose down one semitone"
                      >−</button>
                      <span
                        className="track-slider-label"
                        title="Transpose (semitones). Click to reset."
                        style={{ cursor: 'pointer', minWidth: 34, textAlign: 'center' }}
                        onClick={(e) => { e.stopPropagation(); onSetAudioOptions(track.id, { pitchSemitones: 0 }); }}
                      >{(track.pitchSemitones || 0) > 0 ? '+' : ''}{track.pitchSemitones || 0} st</span>
                      <button
                        className="track-btn-lg"
                        onClick={(e) => { e.stopPropagation(); onSetAudioOptions(track.id, { pitchSemitones: Math.min(12, (track.pitchSemitones || 0) + 1) }); }}
                        title="Transpose up one semitone"
                      >+</button>
                      {/* Sync points: pin the sound at the playhead to the grid, then drag the pin in the timeline */}
                      <button
                        className="track-btn-lg"
                        onClick={(e) => { e.stopPropagation(); onAddSyncPoint(track.id); }}
                        title="Add a sync point at the playhead (or double-click the waveform). Drag the pin to line that sound up with the grid."
                        style={{ fontSize: 11 }}
                      >+ Sync</button>
                      <button
                        className="track-btn-lg"
                        onClick={(e) => { e.stopPropagation(); onAutoSync(track.id); }}
                        title="Detect the beats in this audio and place sync points on the bar lines (replaces existing ones; undo with Ctrl+Z)"
                        style={{ fontSize: 11 }}
                      >Auto sync</button>
                      {(track.syncPoints?.length || 0) > 0 && (
                        <button
                          className="track-btn-lg"
                          onClick={(e) => { e.stopPropagation(); onClearSyncPoints(track.id); }}
                          title="Remove all sync points from this audio"
                          style={{ fontSize: 11 }}
                        >Clear sync ({track.syncPoints.length})</button>
                      )}
                    </div>
                  ) : (
                    <button
                      className="track-btn-lg"
                      onClick={(e) => {
                        e.stopPropagation();
                        const input = document.createElement('input');
                        input.type = 'file';
                        input.accept = '.wav,.mp3,.aiff,.aif';
                        input.onchange = () => {
                          if (input.files[0]) onLoadAudio(track.id, input.files[0]);
                        };
                        input.click();
                      }}
                      title="Load audio file"
                      style={{ color: 'var(--accent-hi)', fontSize: 11 }}
                    >🎵</button>
                  )}

                  <button
                    className="track-btn-lg"
                    onClick={(e) => { e.stopPropagation(); onDuplicateTrack(track.id); }}
                    title="Duplicate track"
                    style={{ color: 'var(--ok)' }}
                  >⧉</button>
                </div>

                <button
                  style={{
                    background: 'var(--danger-bg)',
                    color: 'var(--danger)',
                    border: '1px solid var(--danger)',
                    borderRadius: 4,
                    padding: '4px 8px',
                    fontSize: 12,
                    fontWeight: 'bold',
                    cursor: 'pointer',
                    flexShrink: 0,
                    marginLeft: 'auto',
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (track.notes && track.notes.length > 0) {
                      setConfirmDelete(track);
                    } else {
                      onDeleteTrack(track.id);
                    }
                  }}
                  title="Delete track"
                >DEL</button>
              </div>
            );
          })}
          <button className="track-add-btn" onClick={onAddTrack} title="Add track">+ Add Track</button>
        </div>
      )}

      {confirmDelete && (
        <ConfirmDialog
          message={confirmDelete.notes?.length ? `Delete track "${confirmDelete.name}" with ${confirmDelete.notes.length} note${confirmDelete.notes.length !== 1 ? 's' : ''}?` : `Delete track "${confirmDelete.name}"?`}
          onConfirm={() => { onDeleteTrack(confirmDelete.id); setConfirmDelete(null); }}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
      {newSchemeForTrack && (
        <SchemeEditorModal
          onSave={(name) => {
            onSetTrackScheme(newSchemeForTrack, name);
            setNewSchemeForTrack(null);
            setSchemesVersion(v => v + 1);
          }}
          onCancel={() => setNewSchemeForTrack(null)}
        />
      )}
    </div>
  );
}
