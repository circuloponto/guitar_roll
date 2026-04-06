import { useState } from 'react';
import { getAllInstruments } from '../utils/audio';

export default function TrackStrip({
  tracks, activeTrackId, onSwitchTrack,
  onToggleMute, onToggleSolo, onSetVolume,
  onAddTrack, onDeleteTrack, onRenameTrack,
}) {
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState('');

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

  return (
    <div className="track-strip">
      {tracks.map(track => {
        const isActive = track.id === activeTrackId;
        const allInst = getAllInstruments();
        const instLabel = allInst[track.instrument]?.label || track.instrument;
        return (
          <div
            key={track.id}
            className={`track-tab ${isActive ? 'active' : ''} ${track.muted ? 'muted' : ''}`}
            onClick={() => onSwitchTrack(track.id)}
          >
            <div className="track-tab-top">
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
                  className="track-name"
                  onDoubleClick={(e) => { e.stopPropagation(); startRename(track); }}
                >
                  {track.name}
                </span>
              )}
              <span className="track-inst">{instLabel}</span>
            </div>
            <div className="track-tab-controls">
              <button
                className={`track-btn ${track.muted ? 'active-red' : ''}`}
                onClick={(e) => { e.stopPropagation(); onToggleMute(track.id); }}
                title="Mute"
              >M</button>
              <button
                className={`track-btn ${track.solo ? 'active-yellow' : ''}`}
                onClick={(e) => { e.stopPropagation(); onToggleSolo(track.id); }}
                title="Solo"
              >S</button>
              <input
                type="range"
                className="track-volume"
                min={0}
                max={100}
                value={Math.round(track.volume * 100)}
                onChange={(e) => { e.stopPropagation(); onSetVolume(track.id, Number(e.target.value) / 100); }}
                onClick={(e) => e.stopPropagation()}
                title={`Volume: ${Math.round(track.volume * 100)}%`}
              />
              {tracks.length > 1 && (
                <button
                  className="track-btn track-delete"
                  onClick={(e) => { e.stopPropagation(); onDeleteTrack(track.id); }}
                  title="Delete track"
                >×</button>
              )}
            </div>
          </div>
        );
      })}
      <button className="track-add-btn" onClick={onAddTrack} title="Add track">+</button>
    </div>
  );
}
