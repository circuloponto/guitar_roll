// Song tabs and tab groups (modelled on the tabs in 43_scales / 48_scales).
// A song is a whole workspace: tracks, tempo, time signature, bars, markers, loop.
// song = { id, name, groupId?, snapshot }   group = { id, name, colour, collapsed }
// Only the active song's live state sits in App; every other song keeps its snapshot here.

export const GROUP_COLOURS = ['#4f8cff', '#ff6b9a', '#3ecf8e', '#f5a623', '#9d5cff', '#ff5c5c', '#00c2c7'];

const rid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
export const makeSongId = () => `sg-${rid()}`;
export const makeGroupId = () => `gr-${rid()}`;

// "New Tab N": one past the highest trailing number in use, so numbers stay unique.
export function nextTabName(songs) {
  let max = 0;
  for (const s of songs) {
    const m = (s.name || '').match(/(\d+)\s*$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `New Tab ${max + 1}`;
}

// Reorder a song, optionally re-grouping it. `beforeId` null drops it at the end. With
// `targetGroupId` undefined it adopts the group of its unambiguous neighbours so grouped
// tabs stay contiguous.
export function moveSong(songs, draggedId, beforeId, targetGroupId) {
  if (draggedId === beforeId) return songs;
  const dragged = songs.find((s) => s.id === draggedId);
  if (!dragged) return songs;
  const without = songs.filter((s) => s.id !== draggedId);
  let insertIdx = beforeId == null ? without.length : without.findIndex((s) => s.id === beforeId);
  if (insertIdx === -1) insertIdx = without.length;
  let group = targetGroupId;
  if (group === undefined) {
    const before = without[insertIdx - 1]?.groupId ?? null;
    const after = without[insertIdx]?.groupId ?? null;
    if (before && before === after) group = before;
    else if (dragged.groupId && (before === dragged.groupId || after === dragged.groupId)) group = dragged.groupId;
    else group = null;
  }
  const updated = { ...dragged, groupId: group ?? null };
  return [...without.slice(0, insertIdx), updated, ...without.slice(insertIdx)];
}

// Move a whole group (as a contiguous block) in front of `beforeSongId` (null = the end).
export function moveGroup(songs, groupId, beforeSongId) {
  const members = songs.filter((s) => s.groupId === groupId);
  if (members.length === 0) return songs;
  const rest = songs.filter((s) => s.groupId !== groupId);
  let insertIdx = beforeSongId == null ? rest.length : rest.findIndex((s) => s.id === beforeSongId);
  if (insertIdx === -1) insertIdx = rest.length;
  // Never split another group: snap to the start of the run we landed in.
  if (insertIdx > 0 && insertIdx < rest.length) {
    const bg = rest[insertIdx - 1].groupId;
    const ag = rest[insertIdx].groupId;
    if (bg && bg === ag) while (insertIdx > 0 && rest[insertIdx - 1].groupId === bg) insertIdx--;
  }
  return [...rest.slice(0, insertIdx), ...members, ...rest.slice(insertIdx)];
}

// Put a song into a group (after the group's last member) or ungroup it (to the end).
export function assignSongToGroup(songs, songId, groupId) {
  const target = songs.find((s) => s.id === songId);
  if (!target || (target.groupId ?? null) === (groupId ?? null)) return songs;
  const without = songs.filter((s) => s.id !== songId);
  const updated = { ...target, groupId: groupId ?? null };
  if (!groupId) return [...without, updated];
  let last = -1;
  without.forEach((s, i) => { if (s.groupId === groupId) last = i; });
  // First member: the tab keeps its place and the group forms around it.
  if (last === -1) return songs.map((s) => (s.id === songId ? updated : s));
  const at = last + 1;
  return [...without.slice(0, at), updated, ...without.slice(at)];
}

// Drop groups that no longer have members, and group ids pointing at missing groups.
export function tidyGroups(songs, groups) {
  const ids = new Set(groups.map((g) => g.id));
  const fixed = songs.map((s) => (s.groupId && !ids.has(s.groupId) ? { ...s, groupId: null } : s));
  return { songs: fixed, groups };
}
