import { useState, useEffect, Fragment } from 'react';
import { Eye, EyeOff, Volume2, VolumeX } from 'lucide-react';
import { getAllInstruments } from '../utils/audio';
import ConfirmDialog from './ConfirmDialog';
import { TrackControls, TrackMenu } from './TrackParts';

export default function TrackStrip({
  tracks, activeTrackId, onSwitchTrack,
  onToggleMute, onToggleSolo, onSetVolume,
  onAddTrack, onDeleteTrack, onDuplicateTrack, onReorderTracks, onRenameTrack,
  onToggleVisible, onSetBgOpacity, onSetTrackScheme,
  trackGroups = [], selectedTrackIds = new Set(), onSelectTrack, onGroupTracks, onUngroupTracks, onRemoveTrackGroup,
  onToggleTrackGroup, onRenameTrackGroup, onSetTrackGroupColour, onTrackGroupFlag, onTrackGroupSet,
  onTranscribe, onLearn, onToggleHeat, heatTracks = {}, onTogglePhantomShow, onTogglePhantomEdit,
  onLoadAudio, missingAudioIds, onRemoveAudio, onSetAudioOptions, onNudgeBpm, onDetectTempo, bpm, onAutoSync, onClearSyncPoints,
  sessionSchemes = {},
}) {
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const [dragIndex, setDragIndex] = useState(null);
  const [dragOverIndex, setDragOverIndex] = useState(null);
  const [ctxMenu, setCtxMenu] = useState(null); // { kind: 'track' | 'group', id, x, y }

  // Selection modifiers: Ctrl/Cmd toggles, Shift selects a range, a plain click selects one track.
  const clickMode = (e) => (e.ctrlKey || e.metaKey ? 'toggle' : e.shiftKey ? 'range' : 'single');
  const groupById = (id) => trackGroups.find(g => g.id === id) || null;
  const isHiddenByGroup = (track) => !!(track.groupId && groupById(track.groupId)?.collapsed);
  const isFirstOfGroup = (index) => !!tracks[index].groupId && (index === 0 || tracks[index - 1].groupId !== tracks[index].groupId);
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
                <label className="track-group-sl" title="Volume of the whole group (the balance between its tracks is kept)">
                  Vol
                  <input type="range" className="track-slider track-group-slider" min={0} max={100}
                    value={Math.round(Math.max(...members.map(t => t.volume)) * 100)}
                    onChange={(e) => onTrackGroupSet && onTrackGroupSet(grp.id, 'volume', Number(e.target.value) / 100)} />
                </label>
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
                  <TrackControls
                    track={track} isActive={isActive}
                    onToggleMute={onToggleMute} onToggleSolo={onToggleSolo} onSetVolume={onSetVolume}
                    onToggleVisible={onToggleVisible} onSetBgOpacity={onSetBgOpacity} onSetTrackScheme={onSetTrackScheme}
                    sessionSchemes={sessionSchemes} missingAudioIds={missingAudioIds} onLoadAudio={onLoadAudio}
                    onSetAudioOptions={onSetAudioOptions} onNudgeBpm={onNudgeBpm} onDetectTempo={onDetectTempo} bpm={bpm}
                    onAutoSync={onAutoSync} onClearSyncPoints={onClearSyncPoints}
                  />
                </div>

              </div>
              </Fragment>
            );
          })}
        </div>
      )}

      <TrackMenu
        menu={ctxMenu} onClose={() => setCtxMenu(null)} tracks={tracks} trackGroups={trackGroups} selectedTrackIds={selectedTrackIds}
        onGroupTracks={onGroupTracks} onUngroupTracks={onUngroupTracks} onDuplicateTrack={onDuplicateTrack}
        onLoadAudio={onLoadAudio} missingAudioIds={missingAudioIds} onTranscribe={onTranscribe} onLearn={onLearn}
        onTogglePhantomShow={onTogglePhantomShow} onTogglePhantomEdit={onTogglePhantomEdit} onToggleHeat={onToggleHeat} heatTracks={heatTracks} onRemoveAudio={onRemoveAudio} onAskDelete={askDelete}
        onRename={(id) => { const t = tracks.find(x => x.id === id); if (t) startRename(t); if (!expanded) setExpanded(true); }}
        onRenameTrackGroup={onRenameTrackGroup} onToggleTrackGroup={onToggleTrackGroup}
        onSetTrackGroupColour={onSetTrackGroupColour} onRemoveTrackGroup={onRemoveTrackGroup}
      />

      {confirmDelete && (
        <ConfirmDialog
          message={confirmDelete.notes?.length ? `Delete track "${confirmDelete.name}" with ${confirmDelete.notes.length} note${confirmDelete.notes.length !== 1 ? 's' : ''}?` : `Delete track "${confirmDelete.name}"?`}
          onConfirm={() => { onDeleteTrack(confirmDelete.id); setConfirmDelete(null); }}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}
