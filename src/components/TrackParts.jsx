import { useState, useEffect } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { listColorSchemes } from '../utils/storage';
import SchemeEditorModal from './SchemeEditorModal';

// Pieces of the track UI shared by the Tracks window and the Arrangement, so a track offers the
// same options wherever you reach it from.

function pickAudio(onLoadAudio, trackId) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.wav,.mp3,.aiff,.aif,audio/*';
  input.onchange = () => { if (input.files[0]) onLoadAudio(trackId, input.files[0]); };
  input.click();
}

// All controls of one track: mute, solo, eye, volume, opacity, scheme, audio options, tempo match,
// sync points.
export function TrackControls({
  track, isActive,
  onToggleMute, onToggleSolo, onSetVolume, onToggleVisible, onSetBgOpacity, onSetTrackScheme, sessionSchemes = {},
  missingAudioIds, onLoadAudio, onSetAudioOptions, onNudgeBpm, onDetectTempo, bpm, onAutoSync, onClearSyncPoints,
}) {
  const [newSchemeForTrack, setNewSchemeForTrack] = useState(null);
  const [schemesVersion, setSchemesVersion] = useState(0);
  void schemesVersion; // changing it refreshes the scheme list
  const schemes = listColorSchemes();
  const schemeNames = Array.from(new Set([...Object.keys(schemes), ...Object.keys(sessionSchemes || {})]));
  return (
    <>
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
      {track.phantomRow && onToggleVisible && (
        <button
          className={`track-btn-lg ${!track.phantomShow ? 'active-red' : ''}`}
          onClick={(e) => { e.stopPropagation(); onToggleVisible(track.id); }}
          title={track.phantomShow ? 'Hide phantom notes' : 'Show phantom notes'}
        >
          {!track.phantomShow ? <EyeOff size={14} /> : <Eye size={14} />}
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

      {track.phantomRow && onSetBgOpacity && track.phantomShow && (
        <div className="track-slider-group">
          <label className="track-slider-label">Opacity</label>
          <input
            type="range"
            className="track-slider track-slider-ghost"
            min={5}
            max={100}
            value={Math.round((track.phantomOpacity ?? 0.85) * 100)}
            onChange={(e) => { e.stopPropagation(); onSetBgOpacity(track.id, Number(e.target.value) / 100); }}
            onClick={(e) => e.stopPropagation()}
          />
          <span className="track-slider-val">{Math.round((track.phantomOpacity ?? 0.85) * 100)}%</span>
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
          {missingAudioIds?.has(track.id) && (
            <button
              className="track-btn-lg"
              onClick={(e) => {
                e.stopPropagation();
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = '.wav,.mp3,.aiff,.aif,audio/*';
                input.onchange = () => { if (input.files[0]) onLoadAudio(track.id, input.files[0]); };
                input.click();
              }}
              title="The audio file isn't in this browser. Pick it again to relink it: sync points and edits are kept."
              style={{ color: 'var(--amber)', fontSize: 11 }}
            >Relink audio</button>
          )}
          {/* Match tempo: the BPM moves the grid, the song keeps its own speed (like Logic) */}
          <button
            className={`track-btn-lg ${track.followTempo ? 'active-accent' : ''}`}
            onClick={(e) => { e.stopPropagation(); onSetAudioOptions(track.id, { followTempo: !track.followTempo }); }}
            title={track.followTempo
              ? 'Matching tempo: changing the BPM moves the grid, the song plays at its own speed. Click to lock (the BPM then speeds the song up and down with the notes).'
              : 'Click to match tempo: change the BPM until the song lines up with the grid (the song keeps its own speed).'}
            style={{ fontSize: 11 }}
          >{track.followTempo ? 'Matching tempo' : 'Match tempo'}</button>
          {track.followTempo && (
            <>
              <button className="track-btn-lg" onClick={(e) => { e.stopPropagation(); onDetectTempo && onDetectTempo(track.id); }} title="Detect the song's tempo and put its first beat on the grid" style={{ fontSize: 11 }}>Detect</button>
              <button className="track-btn-lg" onClick={(e) => { e.stopPropagation(); onNudgeBpm && onNudgeBpm(-1); }} title="BPM −1">−1</button>
              <button className="track-btn-lg" onClick={(e) => { e.stopPropagation(); onNudgeBpm && onNudgeBpm(-0.1); }} title="BPM −0.1">−.1</button>
              <span className="track-slider-label" style={{ minWidth: 52, textAlign: 'center' }} title="Project tempo">{bpm} BPM</span>
              <button className="track-btn-lg" onClick={(e) => { e.stopPropagation(); onNudgeBpm && onNudgeBpm(0.1); }} title="BPM +0.1">+.1</button>
              <button className="track-btn-lg" onClick={(e) => { e.stopPropagation(); onNudgeBpm && onNudgeBpm(1); }} title="BPM +1">+1</button>
              <button className="track-btn-lg" onClick={(e) => { e.stopPropagation(); onSetAudioOptions(track.id, { followTempo: false }); }} title="Lock this tempo: the song stays attached to the grid" style={{ fontSize: 11 }}>Lock</button>
            </>
          )}
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
          {/* Adding a sync point at the playhead lives in the Sync editor (and has a hotkey) */}
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
      ) : null}

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
    </>
  );
}

// The right-click menu of a track or a track group.
export function TrackMenu({
  menu, onClose, tracks, trackGroups = [], selectedTrackIds = new Set(),
  onGroupTracks, onUngroupTracks, onDuplicateTrack, onLoadAudio, missingAudioIds,
  onTranscribe, onLearn, onToggleHeat, heatTracks = {}, onTogglePhantomShow, onTogglePhantomEdit, onRemoveAudio, onAskDelete, onRename, onOptions,
  onRenameTrackGroup, onToggleTrackGroup, onSetTrackGroupColour, onRemoveTrackGroup,
}) {
  const groupById = (id) => trackGroups.find(g => g.id === id) || null;
  useEffect(() => {
    if (!menu) return undefined;
    const key = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', onClose);
    window.addEventListener('keydown', key);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('mousedown', onClose);
      window.removeEventListener('keydown', key);
      window.removeEventListener('blur', onClose);
    };
  }, [menu, onClose]);
  if (!menu) return null;
  return (
(() => {
  const stop = (e) => e.stopPropagation();
  const close = onClose;
  const pos = { left: Math.min(menu.x, window.innerWidth - 230), top: Math.min(menu.y, window.innerHeight - 260) };
  if (menu.kind === 'group') {
    const g = groupById(menu.id);
    if (!g) return null;
    return (
      <div className="tab-context-menu" style={pos} onMouseDown={stop}>
        <div className="tab-context-menu-title">{g.name}</div>
        <button className="tab-context-menu-item" onClick={() => { const n = window.prompt('Group name', g.name); if (n && n.trim()) onRenameTrackGroup(g.id, n.trim()); close(); }}>Rename group</button>
        <button className="tab-context-menu-item" onClick={() => { onToggleTrackGroup(g.id); close(); }}>{g.collapsed ? 'Expand group' : 'Collapse group'}</button>
        <label className="tab-context-menu-colour-picker">
          <span className="tab-context-menu-label">Colour</span>
          <span className="tab-context-menu-colour-swatch" style={{ background: g.colour }} />
          <input type="color" value={g.colour} onChange={(e) => onSetTrackGroupColour(g.id, e.target.value)} onMouseDown={stop} aria-label="Pick group colour" />
        </label>
        <div className="tab-context-menu-divider" />
        <button className="tab-context-menu-item danger" onClick={() => { onRemoveTrackGroup(g.id); close(); }}>Ungroup tracks</button>
      </div>
    );
  }
  const t = tracks.find(x => x.id === menu.id);
  if (!t) return null;
  const selCount = selectedTrackIds.size;
  const selTracks = tracks.filter(x => selectedTrackIds.has(x.id));
  const anyGrouped = selTracks.some(x => x.groupId);
  const otherGroups = trackGroups.filter(g => !selTracks.every(x => x.groupId === g.id));
  return (
    <div className="tab-context-menu" style={pos} onMouseDown={stop}>
      <div className="tab-context-menu-title">{selCount > 1 ? `${selCount} tracks selected` : t.name}</div>
      {onRename && <button className="tab-context-menu-item" onClick={() => { onRename(t.id); close(); }}>Rename track</button>}
      {onOptions && <button className="tab-context-menu-item" onClick={() => { onOptions(t.id); close(); }}>Track options…</button>}
      <button
        className="tab-context-menu-item"
        disabled={selCount < 2}
        title={selCount < 2 ? 'Select two or more tracks first (Ctrl/Cmd or Shift + click)' : ''}
        onClick={() => { onGroupTracks(); close(); }}
      >Group Tracks<span className="tab-context-menu-key">Ctrl+G</span></button>
      {otherGroups.length > 0 && (
        <>
          <div className="tab-context-menu-label">Add to group</div>
          {otherGroups.map(g => (
            <button key={g.id} className="tab-context-menu-item" onClick={() => { onGroupTracks(g.id); close(); }}>
              <span className="tab-context-menu-swatch" style={{ background: g.colour }} />{g.name}
            </button>
          ))}
        </>
      )}
      {anyGrouped && (
        <button className="tab-context-menu-item" onClick={() => { onUngroupTracks(); close(); }}>Remove from group<span className="tab-context-menu-key">Ctrl+Shift+G</span></button>
      )}
      <div className="tab-context-menu-divider" />
      <button className="tab-context-menu-item" onClick={() => { onDuplicateTrack(t.id); close(); }}>Duplicate track</button>
      {t.type !== 'audio' && onTogglePhantomEdit && (
        <>
          <button className="tab-context-menu-item" onClick={() => { onTogglePhantomEdit(t.id); close(); }} title="A silent companion layer for scale and chord shapes: shown on the fretboard, never played">
            {t.phantomEdit ? 'Done editing phantom notes' : 'Edit phantom notes…'}
          </button>
          <button className="tab-context-menu-item" onClick={() => { onTogglePhantomShow(t.id); close(); }}>
            {t.phantomShow ? 'Hide phantom notes' : 'Show phantom notes'}
          </button>
          <button className="tab-context-menu-item" onClick={() => { onTogglePhantomShow(t.id, 'phantomRow'); close(); }}>
            {t.phantomRow ? 'Hide phantom controls in track list' : 'Show phantom controls in track list'}
          </button>
        </>
      )}
      <button className="tab-context-menu-item" onClick={() => { pickAudio(onLoadAudio, t.id); close(); }}>
        Import audio file…
      </button>
      {t.type === 'audio' && t.audioFileName && !missingAudioIds?.has(t.id) && (
        <>
          <div className="tab-context-menu-divider" />
          <button className="tab-context-menu-item" onClick={() => { onTranscribe(t.id); close(); }}>Transcribe to a draft track…</button>
          <button className="tab-context-menu-item" onClick={() => { onLearn(t.id); close(); }} title="Compare the analysis with the notes you wrote by hand on a notes track, and learn which of its notes to trust">Teach it from my notes…</button>
          <button className="tab-context-menu-item" onClick={() => { onToggleHeat(t.id); close(); }}>
            {heatTracks[t.id] ? 'Hide pitch heat map' : 'Show pitch heat map'}
          </button>
        </>
      )}
      {t.type === 'audio' && t.audioFileName && (
        <button className="tab-context-menu-item" onClick={() => { onRemoveAudio(t.id); close(); }}>Remove audio file</button>
      )}
      <div className="tab-context-menu-divider" />
      <button className="tab-context-menu-item danger" onClick={() => { onAskDelete(t); close(); }}>Delete track</button>
    </div>
  );
})()
  );
}
