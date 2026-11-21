import { useState, useRef, useEffect } from 'react';

// Song tab strip with colored, collapsible tab groups. Drag a tab to reorder it, onto a
// group pill to join that group, or past the last tab to leave its group. Drag a group
// pill to move the whole group. Double-click renames; right-click opens a menu.
export default function SongTabs({
  songs, groups, activeSongId,
  onSelect, onAdd, onRemove, onRename, onDuplicate,
  onAddGroup, onToggleGroupCollapsed, onRemoveGroup, onRenameGroup, onSetGroupColour,
  onMoveSong, onMoveGroup, onAssignSongToGroup,
}) {
  const [drag, setDrag] = useState(null);          // { kind: 'tab' | 'group', id }
  const [over, setOver] = useState(null);          // song id | 'pill-<gid>' | '__tail'
  const [editing, setEditing] = useState(null);    // { kind, id, draft }
  const [menu, setMenu] = useState(null);          // { kind, id, x, y }
  const inputRef = useRef(null);

  useEffect(() => { if (editing) { inputRef.current?.focus(); inputRef.current?.select(); } }, [editing?.kind, editing?.id]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const key = (e) => { if (e.key === 'Escape') close(); };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', key);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', key);
      window.removeEventListener('blur', close);
    };
  }, [menu]);

  const endDrag = () => { setDrag(null); setOver(null); };

  const commitEdit = () => {
    if (!editing) return;
    const t = editing.draft.trim();
    if (t) (editing.kind === 'tab' ? onRename : onRenameGroup)?.(editing.id, t);
    setEditing(null);
  };

  const editInput = (cls) => (
    <input
      ref={inputRef}
      className={cls}
      value={editing.draft}
      onChange={(e) => setEditing((s) => ({ ...s, draft: e.target.value }))}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onBlur={commitEdit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        else if (e.key === 'Escape') setEditing(null);
        e.stopPropagation();
      }}
    />
  );

  const nodes = [];
  let prevGroupId = null;
  songs.forEach((song, i) => {
    const gid = song.groupId ?? null;
    const group = gid ? groups.find((g) => g.id === gid) : null;
    if (gid && gid !== prevGroupId) {
      const members = songs.filter((s) => s.groupId === gid);
      const first = members[0];
      const collapsed = !!group?.collapsed;
      const renaming = editing?.kind === 'group' && editing.id === gid;
      nodes.push(
        <div
          key={`pill-${gid}`}
          className={`song-group-pill${collapsed ? ' collapsed' : ''}${drag?.kind === 'group' && drag.id === gid ? ' dragging' : ''}${over === `pill-${gid}` ? ' drop-target' : ''}`}
          style={{ '--group-colour': group?.colour ?? GROUP_FALLBACK }}
          draggable={!renaming}
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = 'move';
            try { e.dataTransfer.setData('text/plain', `group:${gid}`); } catch { /* ignore */ }
            setDrag({ kind: 'group', id: gid });
          }}
          onDragEnd={endDrag}
          onDragOver={(e) => {
            if (!drag || (drag.kind === 'group' && drag.id === gid)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            if (over !== `pill-${gid}`) setOver(`pill-${gid}`);
          }}
          onDrop={(e) => {
            if (!drag) return;
            e.preventDefault();
            e.stopPropagation();
            if (drag.kind === 'group') { if (drag.id !== gid && first) onMoveGroup(drag.id, first.id); }
            else onAssignSongToGroup(drag.id, gid);
            endDrag();
          }}
          onClick={() => { if (!renaming) onToggleGroupCollapsed(gid); }}
          onDoubleClick={(e) => { e.stopPropagation(); setEditing({ kind: 'group', id: gid, draft: group?.name ?? '' }); }}
          onContextMenu={(e) => { e.preventDefault(); setMenu({ kind: 'group', id: gid, x: e.clientX, y: e.clientY }); }}
          title={`${group?.name ?? 'Group'} · click to ${collapsed ? 'expand' : 'collapse'}, drag to move, double-click to rename, right-click for options`}
        >
          <span className="song-group-pill-dot" />
          {renaming ? editInput('song-group-pill-input') : (
            <>
              <span className="song-group-pill-name">{group?.name ?? 'Group'}</span>
              {collapsed && <span className="song-group-pill-count">{members.length}</span>}
            </>
          )}
        </div>
      );
    }
    prevGroupId = gid;
    if (group?.collapsed) return;

    const isActive = song.id === activeSongId;
    const renaming = editing?.kind === 'tab' && editing.id === song.id;
    const dropBefore = over === song.id;
    nodes.push(
      <div
        key={song.id}
        role="tab"
        aria-selected={isActive}
        className={`song-tab${isActive ? ' active' : ''}${group ? ' in-group' : ''}${drag?.kind === 'tab' && drag.id === song.id ? ' dragging' : ''}${dropBefore ? ' drop-before' : ''}`}
        style={group ? { '--group-colour': group.colour } : undefined}
        draggable={!renaming}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move';
          try { e.dataTransfer.setData('text/plain', `song:${song.id}`); } catch { /* ignore */ }
          setDrag({ kind: 'tab', id: song.id });
        }}
        onDragEnd={endDrag}
        onDragOver={(e) => {
          if (!drag) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          const r = e.currentTarget.getBoundingClientRect();
          const after = e.clientX > r.left + r.width / 2;
          // "Before the next tab" (or the very end) when the pointer is on the right half.
          const next = songs.slice(i + 1).find(() => true);
          const key = after ? (next ? next.id : '__tail') : song.id;
          if (over !== key) setOver(key);
        }}
        onDrop={(e) => {
          if (!drag) return;
          e.preventDefault();
          e.stopPropagation();
          const beforeId = over === '__tail' || over == null ? null : over;
          if (drag.kind === 'tab') onMoveSong(drag.id, beforeId);
          else if (beforeId !== drag.id) onMoveGroup(drag.id, beforeId);
          endDrag();
        }}
        onClick={() => { if (!renaming) onSelect(song.id); }}
        onDoubleClick={() => setEditing({ kind: 'tab', id: song.id, draft: song.name })}
        onContextMenu={(e) => { e.preventDefault(); setMenu({ kind: 'tab', id: song.id, x: e.clientX, y: e.clientY }); }}
        title={`${song.name} · double-click to rename, drag to reorder, right-click for options`}
      >
        {renaming ? editInput('song-tab-rename') : <span className="song-tab-name">{song.name}</span>}
        {songs.length > 1 && (
          <button
            type="button"
            className="song-tab-close"
            onClick={(e) => { e.stopPropagation(); onRemove(song.id); }}
            onMouseDown={(e) => e.stopPropagation()}
            title="Close tab"
            aria-label={`Close ${song.name}`}
          >×</button>
        )}
      </div>
    );
  });

  const tabMenuSong = menu?.kind === 'tab' ? songs.find((s) => s.id === menu.id) : null;
  const groupMenuGroup = menu?.kind === 'group' ? groups.find((g) => g.id === menu.id) : null;
  const currentGroup = tabMenuSong?.groupId ? groups.find((g) => g.id === tabMenuSong.groupId) : null;
  const close = () => setMenu(null);

  return (
    <div className="song-tabs" role="tablist" aria-label="songs">
      <div
        className={`song-tabs-list${drag ? ' dragging-active' : ''}`}
        onDragOver={(e) => { if (drag?.kind === 'group') e.preventDefault(); }}
      >
        {nodes}
        <div
          className={`song-tab-drop-tail${over === '__tail' ? ' active' : ''}`}
          onDragOver={(e) => { if (!drag) return; e.preventDefault(); if (over !== '__tail') setOver('__tail'); }}
          onDrop={(e) => {
            if (!drag) return;
            e.preventDefault();
            if (drag.kind === 'tab') onMoveSong(drag.id, null, null);
            else onMoveGroup(drag.id, null);
            endDrag();
          }}
        />
      </div>
      <button type="button" className="song-tab-add" onClick={onAdd} title="New tab" aria-label="New tab">+</button>

      {tabMenuSong && (
        <div className="tab-context-menu" style={{ left: menu.x, top: menu.y }} onMouseDown={(e) => e.stopPropagation()}>
          <div className="tab-context-menu-title">{tabMenuSong.name}</div>
          <button className="tab-context-menu-item" onClick={() => { setEditing({ kind: 'tab', id: tabMenuSong.id, draft: tabMenuSong.name }); close(); }}>Rename</button>
          <button className="tab-context-menu-item" onClick={() => { onDuplicate(tabMenuSong.id); close(); }}>Duplicate tab</button>
          <div className="tab-context-menu-divider" />
          <button className="tab-context-menu-item" onClick={() => { const id = onAddGroup(); onAssignSongToGroup(tabMenuSong.id, id); close(); }}>New group with this tab</button>
          {groups.length > 0 && (
            <>
              <div className="tab-context-menu-label">Add to group</div>
              {groups.map((g) => (
                <button
                  key={g.id}
                  className={`tab-context-menu-item${currentGroup?.id === g.id ? ' checked' : ''}`}
                  onClick={() => { onAssignSongToGroup(tabMenuSong.id, g.id); close(); }}
                >
                  <span className="tab-context-menu-swatch" style={{ background: g.colour }} />
                  {g.name}
                </button>
              ))}
            </>
          )}
          {currentGroup && (
            <button className="tab-context-menu-item" onClick={() => { onAssignSongToGroup(tabMenuSong.id, null); close(); }}>Remove from group</button>
          )}
          {songs.length > 1 && (
            <>
              <div className="tab-context-menu-divider" />
              <button className="tab-context-menu-item danger" onClick={() => { onRemove(tabMenuSong.id); close(); }}>Close tab</button>
            </>
          )}
        </div>
      )}

      {groupMenuGroup && (
        <div className="tab-context-menu" style={{ left: menu.x, top: menu.y }} onMouseDown={(e) => e.stopPropagation()}>
          <div className="tab-context-menu-title">{groupMenuGroup.name}</div>
          <button className="tab-context-menu-item" onClick={() => { setEditing({ kind: 'group', id: groupMenuGroup.id, draft: groupMenuGroup.name }); close(); }}>Rename group</button>
          <button className="tab-context-menu-item" onClick={() => { onToggleGroupCollapsed(groupMenuGroup.id); close(); }}>
            {groupMenuGroup.collapsed ? 'Expand group' : 'Collapse group'}
          </button>
          <div className="tab-context-menu-divider" />
          <label className="tab-context-menu-colour-picker">
            <span className="tab-context-menu-label">Colour</span>
            <span className="tab-context-menu-colour-swatch" style={{ background: groupMenuGroup.colour }} />
            <input
              type="color"
              value={groupMenuGroup.colour}
              onChange={(e) => onSetGroupColour(groupMenuGroup.id, e.target.value)}
              onMouseDown={(e) => e.stopPropagation()}
              aria-label="Pick group colour"
            />
          </label>
          <div className="tab-context-menu-divider" />
          <button className="tab-context-menu-item danger" onClick={() => { onRemoveGroup(groupMenuGroup.id); close(); }}>Ungroup (keep tabs)</button>
        </div>
      )}
    </div>
  );
}

const GROUP_FALLBACK = '#4f8cff';
