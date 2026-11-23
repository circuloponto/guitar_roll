// Track groups (like Ableton's "Group Tracks"): a group is a named, coloured, collapsible set of
// tracks that sit next to each other in the track list. Tracks point at their group with `groupId`.
// group = { id, name, colour, collapsed }

export const TRACK_GROUP_COLOURS = ['#4f8cff', '#ff6b9a', '#3ecf8e', '#f5a623', '#9d5cff', '#ff5c5c', '#00c2c7'];

export const makeTrackGroupId = () =>
  `tg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

// Pull every group's members together (at the position of the group's first member).
export function normalizeGroups(tracks) {
  const out = [];
  const placed = new Set();
  for (const t of tracks) {
    if (t.groupId) {
      if (placed.has(t.groupId)) continue;
      placed.add(t.groupId);
      tracks.forEach(m => { if (m.groupId === t.groupId) out.push(m); });
    } else {
      out.push(t);
    }
  }
  return out;
}

// Drop groups with no members and clear dangling group ids.
export function tidyTrackGroups(tracks, groups) {
  const alive = new Set(tracks.map(t => t.groupId).filter(Boolean));
  const known = new Set(groups.map(g => g.id));
  return {
    tracks: tracks.map(t => (t.groupId && !known.has(t.groupId) ? { ...t, groupId: null } : t)),
    groups: groups.filter(g => alive.has(g.id)),
  };
}

// Put the given tracks into a new group (or an existing one, with `intoGroupId`). The members are
// gathered where the first of them sits.
export function groupTracks(tracks, groups, ids, intoGroupId = null) {
  const idSet = new Set(ids);
  if (idSet.size === 0) return { tracks, groups, groupId: null };
  let gid = intoGroupId;
  let nextGroups = groups;
  if (!gid) {
    gid = makeTrackGroupId();
    nextGroups = [...groups, {
      id: gid,
      name: `Group ${groups.length + 1}`,
      colour: TRACK_GROUP_COLOURS[groups.length % TRACK_GROUP_COLOURS.length],
      collapsed: false,
    }];
  }
  const marked = tracks.map(t => (idSet.has(t.id) ? { ...t, groupId: gid } : t));
  const tidy = tidyTrackGroups(normalizeGroups(marked), nextGroups);
  return { tracks: tidy.tracks, groups: tidy.groups, groupId: gid };
}

// Take tracks out of their groups (all members of the touched groups when `whole` is true).
export function ungroupTracks(tracks, groups, ids, whole = false) {
  const idSet = new Set(ids);
  const touched = new Set(tracks.filter(t => idSet.has(t.id) && t.groupId).map(t => t.groupId));
  const next = tracks.map(t => {
    if (!t.groupId) return t;
    if (idSet.has(t.id) || (whole && touched.has(t.groupId))) return { ...t, groupId: null };
    return t;
  });
  return tidyTrackGroups(next, groups);
}
