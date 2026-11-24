import { useState, useEffect, Fragment } from 'react';
import { Eye, EyeOff, Volume2, VolumeX } from 'lucide-react';
import { getAllInstruments } from '../utils/audio';
import { listColorSchemes } from '../utils/storage';
import ConfirmDialog from './ConfirmDialog';
import SchemeEditorModal from './SchemeEditorModal';

export default function TrackStrip({
  tracks, activeTrackId, onSwitchTrack,
  onToggleMute, onToggleSolo, onSetVolume,
  onAddTrack, onDeleteTrack, onDuplicateTrack, onReorderTracks, onRenameTrack,
  onToggleVisible, onSetBgOpacity, onSetTrackScheme,
  trackGroups = [], selectedTrackIds = new Set(), onSelectTrack, onGroupTracks, onUngroupTracks, onRemoveTrackGroup,
  onToggleTrackGroup, onRenameTrackGroup, onSetTrackGroupColour, onTrackGroupFlag,
  onTranscribe, onToggleHeat, heatTracks = {},
  onLoadAudio, missingAudioIds, onRemoveAudio, onSetAudioOptions, onAddSyncPoint, onAutoSync, onClearSyncPoints,
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
  const [ctxMenu, setCtxMenu] = useState(null); // { kind: 'track' | 'group', id, x, y }

  // Selection modifiers: Ctrl/Cmd toggles, Shift selects a range, a plain click selects one track.
  const clickMode = (e) => (e.ctrlKey || e.metaKey ? 'toggle' : e.shiftKey ? 'range' : 'single');
  const groupById = (id) => trackGroups.find(g => g.id === id) || null;
  const isHiddenByGroup = (track) => !!(track.groupId && groupById(track.groupId)?.collapsed);
  const isFirstOfGroup = (index) => !!tracks[index].groupId && (index === 0 || tracks[index - 1].groupId !== tracks[index].groupId);
  const pickAudioFor = (trackId) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.wav,.mp3,.aiff,.aif,audio/*';
    input.onchange = () => { if (input.files[0]) onLoadAudio(trackId, input.files[0]); };
    input.click();
  };
  const askDelete = (t) => {
    if ((t.notes && t.notes.length > 0) || t.audioFileName) setConfirmDelete(t);
    else onDeleteTrack(t.id);
  };
  const openTrackMenu = (e, track) => {
    e.preventDefault();
    e.stopPropagation();
    if (!selectedTrackIds.has(track.id)) onSelectTrack(track.id, 'single');
    setCtxMenu({ kind: 'track', id: track.id, x: e.clientX, y: e.clientY });
  };
  const openGroupMenu = (e, gid) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ kind: 'group', id: gid, x: e.clientX, y: e.clientY });
  };
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    const key = (e) => { if (e.key === 'Escape') close(); };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', key);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', key);
      window.removeEventListener('blur', close);
    };
  }, [ctxMenu]);

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

  // Ask the layout to resize the Tracks panel to its content (so the controls are not cut off).
  useEffect(() => {
    const t = setTimeout(() => window.dispatchEvent(new Event('guitar-roll-fit-tracks')), 30);
    return () => clearTimeout(t);
  }, [expanded, tracks.length]);

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
          {tracks.map((track, tIndex) => {
            const isActive = track.id === activeTrackId;
            const grp = track.groupId ? groupById(track.groupId) : null;
            const pill = grp && isFirstOfGroup(tIndex) ? (
              <span
                key={`gpill-${grp.id}`}
                className={`track-group-pill ${grp.collapsed ? 'collapsed' : ''}`}
                style={{ '--group-colour': grp.colour }}
                title={`${grp.name}: click to ${grp.collapsed ? 'expand' : 'collapse'}, right-click for options`}
                onClick={() => onToggleTrackGroup(grp.id)}
                onContextMenu={(e) => openGroupMenu(e, grp.id)}
              >
                <span className="track-group-dot" />
                {grp.name}
                {grp.collapsed && <span className="track-group-count">{tracks.filter(t => t.groupId === grp.id).length}</span>}
              </span>
            ) : null;
            if (isHiddenByGroup(track)) return pill;
            return (
              <Fragment key={track.id}>
              {pill}
              <button
                className={`track-tab-mini ${isActive ? 'active' : ''} ${track.muted ? 'muted' : ''} ${selectedTrackIds.has(track.id) && selectedTrackIds.size > 1 ? 'selected' : ''} ${grp ? 'in-group' : ''}`}
                style={grp ? { '--group-colour': grp.colour } : undefined}
                onClick={(e) => onSelectTrack(track.id, clickMode(e))}
                onContextMenu={(e) => openTrackMenu(e, track)}
              >
                {track.name}
                {(() => {
                  // One speaker icon: on = you will hear this track, off = muted or silenced by another track's solo.
                  const silencedBySolo = !track.muted && !track.solo && tracks.some(t => t.solo);
                  const audible = !track.muted && !silencedBySolo;
                  return (
                    <span
                      className={`track-mini-speaker ${audible ? 'on' : 'off'}`}
                      role="button"
                      title={track.muted ? 'Muted — click to unmute' : silencedBySolo ? 'Silent: another track is soloed — click to mute' : 'Click to mute'}
                      onClick={(e) => { e.stopPropagation(); onToggleMute(track.id); }}
                    >
                      {audible ? <Volume2 size={14} /> : <VolumeX size={14} />}
                    </span>
                  );
                })()}
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
              </Fragment>
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
            const grp = track.groupId ? groupById(track.groupId) : null;
            const members = grp ? tracks.filter(t => t.groupId === grp.id) : [];
            const header = grp && isFirstOfGroup(index) ? (
              <div
                key={`ghead-${grp.id}`}
                className="track-group-header"
                style={{ '--group-colour': grp.colour }}
                onContextMenu={(e) => openGroupMenu(e, grp.id)}
              >
                <button className="track-group-caret" onClick={() => onToggleTrackGroup(grp.id)} title={grp.collapsed ? 'Expand group' : 'Collapse group'}>
                  {grp.collapsed ? '▸' : '▾'}
                </button>
                <span className="track-group-dot" />
                <span
                  className="track-group-name"
                  title="Double-click to rename"
                  onDoubleClick={() => { const n = window.prompt('Group name', grp.name); if (n && n.trim()) onRenameTrackGroup(grp.id, n.trim()); }}
                >{grp.name}</span>
                <span className="track-group-count">{members.length} tracks</span>
                <button
                  className={`track-btn-lg ${members.every(t => t.muted) ? 'active-red' : ''}`}
                  onClick={() => onTrackGroupFlag(grp.id, 'muted')}
                  title="Mute / unmute the whole group"
                >M</button>
                <button
                  className={`track-btn-lg ${members.every(t => t.solo) ? 'active-yellow' : ''}`}
                  onClick={() => onTrackGroupFlag(grp.id, 'solo')}
                  title="Solo the whole group"
                >S</button>
                <button className="track-btn-lg" onClick={() => onRemoveTrackGroup(grp.id)} title="Ungroup these tracks (Ctrl+Shift+G)">Ungroup</button>
              </div>
            ) : null;
            if (isHiddenByGroup(track)) return header;
            return (
              <Fragment key={track.id}>
              {header}
              <div
                className={`track-row ${isActive ? 'active' : ''} ${track.muted ? 'muted' : ''} ${dragOverIndex === index ? 'drag-over' : ''} ${selectedTrackIds.has(track.id) && selectedTrackIds.size > 1 ? 'selected' : ''} ${grp ? 'in-group' : ''}`}
                style={grp ? { '--group-colour': grp.colour } : undefined}
                onClick={(e) => onSelectTrack(track.id, clickMode(e))}
                onContextMenu={(e) => openTrackMenu(e, track)}
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
                <span
                  className="track-row-grip"
                  draggable
                  title="Drag to reorder this track"
                  onClick={(e) => e.stopPropagation()}
                  onDragStart={(e) => {
                    setDragIndex(index);
                    e.dataTransfer.effectAllowed = 'move';
                    const row = e.currentTarget.closest('.track-row');
                    if (row) e.dataTransfer.setDragImage(row, 12, 12);
                  }}
                >⠿</span>
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
                  ) : null}
                </div>

              </div>
              </Fragment>
            );
          })}
        </div>
      )}

      {ctxMenu && (() => {
        const stop = (e) => e.stopPropagation();
        const close = () => setCtxMenu(null);
        const pos = { left: Math.min(ctxMenu.x, window.innerWidth - 230), top: Math.min(ctxMenu.y, window.innerHeight - 260) };
        if (ctxMenu.kind === 'group') {
          const g = groupById(ctxMenu.id);
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
        const t = tracks.find(x => x.id === ctxMenu.id);
        if (!t) return null;
        const selCount = selectedTrackIds.size;
        const selTracks = tracks.filter(x => selectedTrackIds.has(x.id));
        const anyGrouped = selTracks.some(x => x.groupId);
        const otherGroups = trackGroups.filter(g => !selTracks.every(x => x.groupId === g.id));
        return (
          <div className="tab-context-menu" style={pos} onMouseDown={stop}>
            <div className="tab-context-menu-title">{selCount > 1 ? `${selCount} tracks selected` : t.name}</div>
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
            <button className="tab-context-menu-item" onClick={() => { pickAudioFor(t.id); close(); }}>
              Import audio file…
            </button>
            {t.type === 'audio' && t.audioFileName && !missingAudioIds?.has(t.id) && (
              <>
                <div className="tab-context-menu-divider" />
                <button className="tab-context-menu-item" onClick={() => { onTranscribe(t.id); close(); }}>Transcribe to a draft track…</button>
                <button className="tab-context-menu-item" onClick={() => { onToggleHeat(t.id); close(); }}>
                  {heatTracks[t.id] ? 'Hide pitch heat map' : 'Show pitch heat map'}
                </button>
              </>
            )}
            {t.type === 'audio' && t.audioFileName && (
              <button className="tab-context-menu-item" onClick={() => { onRemoveAudio(t.id); close(); }}>Remove audio file</button>
            )}
            <div className="tab-context-menu-divider" />
            <button className="tab-context-menu-item danger" onClick={() => { askDelete(t); close(); }}>Delete track</button>
          </div>
        );
      })()}

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
