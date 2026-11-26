import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FolderPlus, Search, X, ClipboardPaste, Upload, Download, BookmarkPlus } from 'lucide-react';
import TemplateTree from './TemplateTree';
import { SCALE_LIST, ROOT_NAMES, newTemplateId, isFolder, parseTemplates, moveNodes, withDescendants } from '../utils/templateOps';

// The Templates window (from the 8-fold way app): a tree of scale-degree patterns. Click one to arm it, then
// click the timeline to stamp it there, transposed to the chosen scale + root. "Capture" saves the selected
// timeline notes as a new template.
export default function TemplatesPanel({ templates, setTemplates, scaleId, setScaleId, root, setRoot, pendingId, onArm, onCapture, canCapture }) {
  const [selected, setSelected] = useState(() => new Set());
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [menu, setMenu] = useState(null); // { x, y, id }
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [flashId, setFlashId] = useState(null);
  const [feedback, setFeedback] = useState('');
  const fileRef = useRef(null);
  const flash = (m) => { setFeedback(m); setTimeout(() => setFeedback(''), 1600); };

  useEffect(() => {
    if (!menu) return undefined;
    const close = () => setMenu(null);
    const key = (e) => { if (e.key === 'Escape') close(); };
    window.addEventListener('mousedown', close); window.addEventListener('keydown', key); window.addEventListener('blur', close);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', key); window.removeEventListener('blur', close); };
  }, [menu]);

  const targets = (id) => (selected.has(id) && selected.size > 1 ? [...selected] : [id]);
  const byId = (id) => templates.find((t) => t.id === id);

  const createFolder = () => {
    const id = newTemplateId();
    setTemplates((prev) => [...prev, { id, type: 'folder', name: 'New folder', parentId: null }]);
    setRenameValue('New folder'); setRenamingId(id);
  };
  const toggleFolder = (id) => setTemplates((prev) => prev.map((n) => (n.id === id ? { ...n, collapsed: !n.collapsed } : n)));
  const commitRename = (id) => {
    const n = renameValue.trim();
    if (n) setTemplates((prev) => prev.map((t) => (t.id === id ? { ...t, name: n } : t)));
    setRenamingId(null);
  };
  const remove = (ids) => {
    const set = new Set(ids);
    setTemplates((prev) => prev
      .filter((n) => !set.has(n.id))
      .map((n) => {
        if (!set.has(n.parentId)) return n;
        const gone = prev.find((x) => x.id === n.parentId);
        return { ...n, parentId: gone ? gone.parentId ?? null : null }; // a deleted folder's contents move up
      }));
    setSelected(new Set());
  };
  const json = (ids) => {
    const list = withDescendants(templates, ids);
    return JSON.stringify(list.length === 1 ? list[0] : list, null, 2);
  };
  const copy = async (ids) => {
    try { await navigator.clipboard.writeText(json(ids)); flash('Copied'); } catch { flash('Clipboard blocked'); }
  };
  const download = (ids, name = 'templates') => {
    const url = URL.createObjectURL(new Blob([json(ids)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = `${name.replace(/[^\w-]+/g, '_') || 'templates'}.json`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const addImported = (list) => {
    if (!list || !list.length) { flash('No template'); return; }
    setTemplates((prev) => [...prev, ...list]);
    flash(`+${list.filter((n) => !isFolder(n)).length}`);
  };
  const paste = async () => {
    try { addImported(parseTemplates(await navigator.clipboard.readText())); } catch { flash('Clipboard blocked'); }
  };
  const importFiles = async (files) => {
    const all = [];
    for (const f of files) { const p = parseTemplates(await f.text()); if (p) all.push(...p); }
    addImported(all);
  };
  const reveal = (node) => {
    const map = new Map(templates.map((n) => [n.id, n]));
    const open = new Set();
    for (let cur = map.get(node.parentId); cur; cur = map.get(cur.parentId)) if (cur.collapsed) open.add(cur.id);
    if (open.size) setTemplates((prev) => prev.map((n) => (open.has(n.id) ? { ...n, collapsed: false } : n)));
    setSearch(''); setSearchOpen(false); setFlashId(node.id);
    setTimeout(() => setFlashId(null), 1500);
  };

  const menuNode = menu ? byId(menu.id) : null;

  return (
    <div className="tpl-panel">
      <div className="tpl-scale">
        <select className="tpl-select" value={scaleId} onChange={(e) => setScaleId(Number(e.target.value))} title="Scale the templates are played in">
          {SCALE_LIST.map((s) => <option key={s.id} value={s.id}>Scale {s.id}</option>)}
        </select>
        <select className="tpl-select tpl-root" value={root} onChange={(e) => setRoot(Number(e.target.value))} title="Root note">
          {ROOT_NAMES.map((n, i) => <option key={n} value={i}>{n}</option>)}
        </select>
      </div>
      <div className="tpl-toolbar">
        <button className="tpl-icon-btn" disabled={!canCapture} onClick={onCapture} title={canCapture ? 'Capture the selected notes as a template (in this scale + root)' : 'Select notes on the timeline to capture them'}><BookmarkPlus size={14} /></button>
        <button className="tpl-icon-btn" onClick={createFolder} title="New folder"><FolderPlus size={14} /></button>
        <button className="tpl-icon-btn" onClick={paste} title="Paste templates from the clipboard"><ClipboardPaste size={14} /></button>
        <button className="tpl-icon-btn" onClick={() => fileRef.current?.click()} title="Import template file(s)"><Upload size={14} /></button>
        <button className="tpl-icon-btn" disabled={!templates.length} onClick={() => download(templates.filter((t) => t.parentId == null).map((t) => t.id), 'templates')} title="Export the whole library"><Download size={14} /></button>
        <button className={`tpl-icon-btn${searchOpen ? ' on' : ''}`} onClick={() => { setSearchOpen((o) => !o); setSearch(''); }} title="Search"><Search size={14} /></button>
        {feedback && <span className="tpl-feedback">{feedback}</span>}
        <input ref={fileRef} type="file" accept="application/json,.json" multiple style={{ display: 'none' }}
          onChange={(e) => { importFiles([...e.target.files]); e.target.value = ''; }} />
      </div>
      {searchOpen && (
        <div className="tpl-search">
          <Search size={12} />
          <input autoFocus placeholder="Search templates…" value={search} onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') { setSearchOpen(false); setSearch(''); } }} />
          {search && <button className="tpl-icon-btn" onClick={() => setSearch('')}><X size={12} /></button>}
        </div>
      )}
      <div className="tpl-body">
        {templates.length === 0 ? (
          <div className="tpl-hint">No templates yet: select notes on the timeline and press Capture.</div>
        ) : (
          <TemplateTree
            templates={templates}
            searchQuery={search}
            tagFilter={null}
            onReveal={reveal}
            flashId={flashId}
            onMove={(id, target, pos) => setTemplates((prev) => moveNodes(prev, [id], target, pos))}
            onMoveMany={(ids, target, pos) => { setTemplates((prev) => moveNodes(prev, ids, target, pos)); setSelected(new Set()); }}
            selectedTemplateIds={selected}
            onToggleSelect={(id) => setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; })}
            renamingTemplateId={renamingId}
            renameValue={renameValue}
            setRenameValue={setRenameValue}
            commitRename={commitRename}
            cancelRename={() => setRenamingId(null)}
            pendingTemplate={pendingId ? { id: pendingId } : null}
            onPlace={(tpl) => { setSelected(new Set()); onArm(tpl); }}
            onToggleFolder={toggleFolder}
            onContextMenu={(e, id) => setMenu({ x: e.clientX, y: e.clientY, id })}
          />
        )}
      </div>
      {menu && menuNode && createPortal(
        <div className="tab-context-menu" style={{ position: 'fixed', left: menu.x, top: menu.y, zIndex: 100000 }} onMouseDown={(e) => e.stopPropagation()}>
          <div className="tab-context-menu-title">{targets(menu.id).length > 1 ? `${targets(menu.id).length} items` : menuNode.name}</div>
          {targets(menu.id).length === 1 && (
            <button className="tab-context-menu-item" onClick={() => { setRenameValue(menuNode.name); setRenamingId(menu.id); setMenu(null); }}>Rename</button>
          )}
          <button className="tab-context-menu-item" onClick={() => { copy(targets(menu.id)); setMenu(null); }}>Copy as JSON</button>
          <button className="tab-context-menu-item" onClick={() => { download(targets(menu.id), menuNode.name); setMenu(null); }}>Download .json</button>
          <div className="tab-context-menu-divider" />
          <button className="tab-context-menu-item danger" onClick={() => { remove(targets(menu.id)); setMenu(null); }}>Delete</button>
        </div>, document.body)}
    </div>
  );
}
