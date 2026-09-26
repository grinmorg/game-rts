import { ReactNode, useEffect, useReducer, useRef, useState } from 'react';
import {
  MAP_NAME_MAX, MAP_SIZE_MAX, MAP_SIZE_MIN, MAP_STARTS_PER_ZONE_MAX, MAX_PLAYERS, MINE_GOLD_MAX, MINE_GOLD_MIN, MapIssue, PLAYER_COLORS, Tile,
  customMapThumb, decodeCustomSource, encodeCustomMap, mapHasErrors, validateCustomMap,
} from '@rookfall/sim';
import { TKey, useT } from '../i18n';
import { net } from '../net/client';
import { myMapById, saveMap } from '../net/maps';
import { PickedMap } from '../ui/MapPicker';
import { ISSUE_KEYS, mapErrorKey } from '../ui/mapText';
import { EditorDoc, SYMMETRIES, Symmetry } from './doc';
import { closeEditor, editorSession, openEditor, setToolOptions, toolOptions } from './session';
import { EditorView, Selection, TILE_RGB, Tool, ToolOptions } from './view';

const TERRAINS: { tile: Tile; key: TKey }[] = [
  { tile: Tile.Grass, key: 'tileGrass' }, { tile: Tile.Dirt, key: 'tileDirt' }, { tile: Tile.Forest, key: 'tileForest' },
  { tile: Tile.Rock, key: 'tileRock' }, { tile: Tile.Water, key: 'tileWater' },
];
const TOOLS: { tool: Tool; icon: string; code: string; hotkey: string; label: TKey }[] = [
  { tool: 'brush', icon: '🖌️', code: 'KeyB', hotkey: 'B', label: 'toolBrush' },
  { tool: 'line', icon: '📏', code: 'KeyL', hotkey: 'L', label: 'toolLine' },
  { tool: 'rect', icon: '⬛', code: 'KeyR', hotkey: 'R', label: 'toolRect' },
  { tool: 'fill', icon: '🪣', code: 'KeyG', hotkey: 'G', label: 'toolFill' },
  { tool: 'pick', icon: '💧', code: 'KeyI', hotkey: 'I', label: 'toolPick' },
  { tool: 'mine', icon: '🪙', code: 'KeyM', hotkey: 'M', label: 'toolMine' },
  { tool: 'start', icon: '🏰', code: 'KeyS', hotkey: 'S', label: 'toolStart' },
  { tool: 'select', icon: '👆', code: 'KeyV', hotkey: 'V', label: 'toolSelect' },
  { tool: 'pan', icon: '✋', code: 'KeyH', hotkey: 'H', label: 'toolPan' },
];
const TOOL_HINTS: Record<Tool, TKey> = {
  brush: 'hintBrush', line: 'hintLine', rect: 'hintRect', fill: 'hintFill', pick: 'hintPick', mine: 'hintMine', start: 'hintStart', select: 'hintSelect', pan: 'hintPan',
};
const SYM: Record<Symmetry, { icon: string; key: TKey }> = {
  none: { icon: '∅', key: 'symNone' }, x: { icon: '⇆', key: 'symX' }, y: { icon: '⇅', key: 'symY' },
  xy: { icon: '✚', key: 'symXY' }, rot: { icon: '↻', key: 'symRot' }, rot4: { icon: '✢', key: 'symRot4' },
};
const GOLD_PRESETS = [3000, 6000, 8000, 10000, 15000];
const PAINT_TOOLS: Tool[] = ['brush', 'line', 'rect', 'fill'];
const hex = (c: number) => '#' + c.toString(16).padStart(6, '0');
const rgb = (t: number) => `rgb(${TILE_RGB[t].join(',')})`;

interface Toast { text: string; kind: 'ok' | 'error' | 'info'; id: number }

/**
 * The map editor: paint terrain, lay out gold and spawns, check the map, save it to the server, try it
 * against bots. The document and the camera live in the editor session (session.ts), so the screen can be
 * left for a test match and come back to the same state.
 */
export function EditorScreen({ back, test }: { back: () => void; test: (payload: string, picked: PickedMap) => void }) {
  const t = useT();
  const [doc, setDoc] = useState<EditorDoc | null>(() => editorSession()?.doc ?? null);
  const [opts, setOptsState] = useState<ToolOptions>(toolOptions);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const lastPaint = useRef<Tool>(PAINT_TOOLS.includes(opts.tool) ? opts.tool : 'brush');
  const setOpts = (patch: Partial<ToolOptions>) => setOptsState((o) => {
    const n = { ...o, ...patch };
    if (PAINT_TOOLS.includes(n.tool)) lastPaint.current = n.tool;
    setToolOptions(n);
    return n;
  });
  const [, force] = useReducer((n: number) => n + 1, 0);
  const [issues, setIssues] = useState<MapIssue[]>(() => { const d = editorSession()?.doc; return d ? validateCustomMap(d.toSource()) : []; });
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const [sel, setSel] = useState<Selection | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [saving, setSaving] = useState(false);
  const [dialog, setDialog] = useState<'resize' | 'scatter' | null>(null);
  const [menu, setMenu] = useState(false);
  const [side, setSide] = useState(false);
  const [connected, setConnected] = useState(net.connected);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const flash = (text: string, kind: Toast['kind'] = 'info') => setToast({ text, kind, id: Date.now() });
  useEffect(() => { if (!toast) return; const id = setTimeout(() => setToast(null), toast.kind === 'error' ? 5000 : 2600); return () => clearTimeout(id); }, [toast]);
  useEffect(() => { const u = [net.on('open', () => setConnected(true)), net.on('close', () => setConnected(false))]; return () => u.forEach((f) => f()); }, []);
  // nothing to edit (a reload on this screen): back to the map list
  useEffect(() => { if (!doc) back(); }, [doc, back]);

  useEffect(() => {
    if (!doc || !canvasRef.current) return;
    const session = editorSession()!;
    const v = new EditorView(canvasRef.current, doc, () => optsRef.current, {
      onHover: setHover,
      onSelect: setSel,
      onPick: (tile) => setOpts({ terrain: tile, tool: optsRef.current.tool === 'pick' ? lastPaint.current : optsRef.current.tool }),
      onRefused: (r) => flash(t(r === 'mines' ? 'edTooManyMines' : 'edTooManyStarts', { n: MAP_STARTS_PER_ZONE_MAX, zones: MAX_PLAYERS }), 'error'),
    }, session.cam);
    viewRef.current = v;
    v.setIssues(validateCustomMap(doc.toSource()));
    const off = doc.onChange(() => force());
    return () => { session.cam = { ...v.cam }; v.dispose(); off(); viewRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc]);
  useEffect(() => { viewRef.current?.refresh(); }, [opts]);

  // the check runs on a settled document, not on every painted cell
  const version = doc?.version ?? 0;
  useEffect(() => {
    if (!doc) return;
    const id = setTimeout(() => { const is = validateCustomMap(doc.toSource()); setIssues(is); viewRef.current?.setIssues(is); }, 250);
    return () => clearTimeout(id);
  }, [doc, version]);

  const zones = doc ? new Set(doc.starts.map((s) => s.zone)).size : 0;
  const errors = issues.filter((i) => i.error);
  const warnings = issues.filter((i) => !i.error);

  const save = async (asCopy = false) => {
    if (!doc || saving) return;
    if (!net.connected) { flash(t('mapErrOffline'), 'error'); return; }
    setSaving(true);
    // saving errors into a published map takes it off the community list; say so
    const wasPublic = !asCopy && !!doc.id && !!myMapById(doc.id)?.public;
    try {
      const meta = await saveMap(asCopy ? undefined : doc.id, encodeCustomMap(doc.toSource()));
      doc.markSaved(meta.id, meta.rev);
      if (wasPublic && !meta.public) flash(t('mapUnpublished'), 'error');
      else flash(meta.valid ? t('mapSavedOk') : t('mapSavedInvalid'), meta.valid ? 'ok' : 'info');
    } catch (e) {
      flash(t(mapErrorKey(e)), 'error');
    }
    setSaving(false);
  };

  const runTest = () => {
    if (!doc) return;
    const src = doc.toSource();
    const found = validateCustomMap(src);
    if (mapHasErrors(found)) { setIssues(found); viewRef.current?.setIssues(found); setSide(true); flash(t('edTestErrors'), 'error'); return; }
    test(encodeCustomMap(src), {
      id: doc.id ?? 'draft', custom: true, name: doc.name || t('untitledMap'), players: new Set(src.starts.map((s) => s.zone)).size,
      w: src.w, h: src.h, thumb: customMapThumb(src),
    });
  };

  const leave = () => {
    if (doc?.dirty && !window.confirm(t('edLeaveUnsaved'))) return;
    closeEditor();
    back();
  };

  const exportFile = () => {
    if (!doc) return;
    const blob = new Blob([encodeCustomMap(doc.toSource())], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(doc.name || 'map').replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '') || 'map'}.rookmap`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  const importFile = async (file: File) => {
    const src = decodeCustomSource(await file.text());
    if (!src) { flash(t('edImportBad'), 'error'); return; }
    if (doc?.dirty && !window.confirm(t('edLeaveUnsaved'))) return;
    const next = new EditorDoc(src);
    next.dirty = true;
    openEditor(next);
    setDoc(next);
    setSel(null);
    flash(t('edImported'), 'ok');
  };

  // keyboard: tools, terrain, brush size, undo/redo, delete, save
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!doc || dialog) return;
      const el = e.target as HTMLElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA')) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.code === 'KeyZ') { e.preventDefault(); if (e.shiftKey) doc.redo(); else doc.undo(); return; }
      if (mod && e.code === 'KeyY') { e.preventDefault(); doc.redo(); return; }
      if (mod && e.code === 'KeyS') { e.preventDefault(); void save(); return; }
      if (mod || e.altKey || e.repeat) return;
      const tool = TOOLS.find((x) => x.code === e.code);
      if (tool) { setOpts({ tool: tool.tool }); return; }
      if (/^Digit[1-5]$/.test(e.code)) { setOpts({ terrain: TERRAINS[Number(e.code[5]) - 1].tile, tool: PAINT_TOOLS.includes(optsRef.current.tool) ? optsRef.current.tool : lastPaint.current }); return; }
      if (e.code === 'BracketLeft') setOpts({ size: Math.max(1, optsRef.current.size - 1) });
      else if (e.code === 'BracketRight') setOpts({ size: Math.min(32, optsRef.current.size + 1) });
      else if (e.code === 'KeyF') viewRef.current?.fit();
      else if (e.code === 'Escape') viewRef.current?.select(null);
      else if ((e.code === 'Delete' || e.code === 'Backspace') && viewRef.current?.selection) {
        const s = viewRef.current.selection;
        viewRef.current.select(null);
        doc.removeObject(s.kind, s.index);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!doc) return null;
  const selMine = sel?.kind === 'mine' ? doc.mines[sel.index] : undefined;
  const selStart = sel?.kind === 'start' ? doc.starts[sel.index] : undefined;
  const zoneCount = (z: number) => doc.starts.filter((s) => s.zone === z).length;
  // the first dozen zones, and as many more as the map uses plus the next free one - a hundred buttons for a duel
  // map would only be noise
  const zonesShown = Math.min(MAX_PLAYERS, Math.max(12, opts.zone + 2, ...doc.starts.map((s) => s.zone + 2)));
  const tileName = hover ? t(TERRAINS.find((x) => x.tile === doc.tileAt(hover.x, hover.y))?.key ?? 'tileGrass') : '';
  const totalGold = doc.mines.reduce((a, m) => a + m.gold, 0);
  const brushLike = opts.tool === 'brush' || opts.tool === 'line';

  return (
    <div className="editor">
      <div className="ed-top">
        <button className="plain" onClick={leave}>← {t('back')}</button>
        <input className="ed-name" value={doc.name} placeholder={t('untitledMap')} maxLength={MAP_NAME_MAX} onChange={(e) => doc.rename(e.target.value)} aria-label={t('mapName')} />
        <span className="ed-meta small muted">{doc.w}×{doc.h} · {t('mapPlayersN', { n: zones })}</span>
        <span className="grow" />
        <button className="plain ed-icon" title={`${t('undo')} (Ctrl+Z)`} disabled={!doc.canUndo} onClick={() => doc.undo()}>↶</button>
        <button className="plain ed-icon" title={`${t('redo')} (Ctrl+Shift+Z)`} disabled={!doc.canRedo} onClick={() => doc.redo()}>↷</button>
        <button className="gold" onClick={() => void save()} disabled={saving || !connected} title={connected ? `${t('save')} (Ctrl+S)` : t('mapErrOffline')}>
          💾 <span className="ed-label">{saving ? t('saving') : t('save')}</span>{doc.dirty ? ' •' : ''}
        </button>
        <button className="primary" onClick={runTest} title={t('testMapHint')}>▶ <span className="ed-label">{t('testMap')}</span></button>
        <div className="ed-menu-wrap">
          <button className="plain ed-icon" onClick={() => setMenu(!menu)} aria-expanded={menu} title={t('more')}>⋯</button>
          {menu && (
            <div className="ed-menu" onClick={() => setMenu(false)}>
              <button className="plain" disabled={saving || !connected || !doc.id} onClick={() => void save(true)}>📄 {t('saveCopy')}</button>
              <button className="plain" onClick={() => setDialog('resize')}>📐 {t('edResize')}</button>
              <button className="plain" onClick={() => setDialog('scatter')}>🌲 {t('edScatter')}</button>
              <button className="plain" onClick={() => { if (window.confirm(t('edClearConfirm'))) doc.clearTerrain(); }}>🧹 {t('edClear')}</button>
              <button className="plain" onClick={exportFile}>⬇️ {t('edExport')}</button>
              <button className="plain" onClick={() => fileRef.current?.click()}>⬆️ {t('edImport')}</button>
            </div>
          )}
        </div>
        <button className="plain ed-icon ed-side-toggle" onClick={() => setSide(!side)} aria-expanded={side} title={t('edPanel')}>☰</button>
        <input ref={fileRef} type="file" accept=".rookmap,.json,application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importFile(f); }} />
      </div>

      <div className="ed-body">
        <div className="ed-tools" role="toolbar">
          {TOOLS.map((x) => (
            <button key={x.tool} className={`ed-tool ${opts.tool === x.tool ? 'active' : ''}`} title={`${t(x.label)} (${x.hotkey})`} aria-pressed={opts.tool === x.tool} onClick={() => setOpts({ tool: x.tool })}>
              <span aria-hidden="true">{x.icon}</span>
            </button>
          ))}
        </div>

        <div className="ed-stage">
          <canvas ref={canvasRef} className="ed-canvas" />
          <div className="ed-zoom">
            <button className="plain ed-icon" onClick={() => viewRef.current?.zoomBy(1 / 1.4)} title={t('zoomOut')}>−</button>
            <button className="plain ed-icon" onClick={() => viewRef.current?.fit()} title={`${t('edFit')} (F)`}>⤢</button>
            <button className="plain ed-icon" onClick={() => viewRef.current?.zoomBy(1.4)} title={t('zoomIn')}>+</button>
          </div>
          {toast && <div key={toast.id} className={`ed-toast ${toast.kind}`} role="status">{toast.text}</div>}
        </div>

        <aside className={`ed-side ${side ? 'open' : ''}`}>
          <section>
            <h4>{t('edTerrain')}</h4>
            <div className="ed-terrains">
              {TERRAINS.map((x, i) => (
                <button key={x.tile} className={`ed-terrain ${opts.terrain === x.tile ? 'active' : ''}`} title={`${t(x.key)} (${i + 1})`} aria-pressed={opts.terrain === x.tile}
                  onClick={() => setOpts({ terrain: x.tile, tool: PAINT_TOOLS.includes(opts.tool) ? opts.tool : lastPaint.current })}>
                  <span className="swatch" style={{ background: rgb(x.tile) }} />
                  <span className="small">{t(x.key)}</span>
                </button>
              ))}
            </div>
            <p className="tiny muted">{t('edTerrainNote')}</p>
          </section>

          {brushLike && (
            <section>
              <h4>{t('edBrush')}</h4>
              <div className="row ed-brush">
                <input type="range" min={1} max={32} value={opts.size} onChange={(e) => setOpts({ size: Number(e.target.value) })} aria-label={t('edBrushSize')} className="grow" />
                <span className="ed-num">{opts.size}</span>
              </div>
              <div className="seg">
                <button className={!opts.square ? 'gold' : 'plain'} onClick={() => setOpts({ square: false })}>● {t('edRound')}</button>
                <button className={opts.square ? 'gold' : 'plain'} onClick={() => setOpts({ square: true })}>■ {t('edSquare')}</button>
              </div>
            </section>
          )}

          <section>
            <h4>{t('edSymmetry')}</h4>
            <div className="ed-syms">
              {SYMMETRIES.map((s) => (
                <button key={s} className={`ed-sym ${opts.symmetry === s ? 'active' : ''}`} title={t(SYM[s].key)} aria-pressed={opts.symmetry === s}
                  disabled={s === 'rot4' && doc.w !== doc.h} onClick={() => setOpts({ symmetry: s })}>{SYM[s].icon}</button>
              ))}
            </div>
            <p className="tiny muted">{t(SYM[opts.symmetry].key)}{opts.symmetry !== 'none' ? ` — ${t('edSymNote')}` : ''}</p>
          </section>

          {opts.tool === 'mine' && (
            <section>
              <h4>{t('edGold')}</h4>
              <GoldInput value={opts.gold} onChange={(gold) => setOpts({ gold })} />
            </section>
          )}

          {opts.tool === 'start' && (
            <section>
              <h4>{t('edZone')}</h4>
              <div className="ed-zones">
                {Array.from({ length: zonesShown }, (_, z) => (
                  <button key={z} className={`ed-zone ${opts.zone === z ? 'active' : ''}`} style={{ background: hex(PLAYER_COLORS[z]) }} aria-pressed={opts.zone === z}
                    title={t('edZoneN', { n: z + 1, c: zoneCount(z) })} onClick={() => setOpts({ zone: z })}>
                    {z + 1}{zoneCount(z) ? <sup>{zoneCount(z)}</sup> : null}
                  </button>
                ))}
              </div>
              <p className="tiny muted">{t('edZoneNote', { n: MAP_STARTS_PER_ZONE_MAX })}</p>
            </section>
          )}

          {(selMine || selStart) && sel && (
            <section className="ed-selected">
              <h4>{selMine ? t('edSelMine') : t('edSelStart')} <span className="muted small">({(selMine ?? selStart)!.x}, {(selMine ?? selStart)!.y})</span></h4>
              {selMine && <GoldInput value={selMine.gold} onChange={(gold) => doc.updateMine(sel.index, gold)} />}
              {selStart && (
                <div className="ed-zones">
                  {Array.from({ length: zonesShown }, (_, z) => (
                    <button key={z} className={`ed-zone ${selStart.zone === z ? 'active' : ''}`} style={{ background: hex(PLAYER_COLORS[z]) }} onClick={() => doc.updateStartZone(sel.index, z)}>{z + 1}</button>
                  ))}
                </div>
              )}
              <div className="row end"><button className="danger small-btn" onClick={() => { viewRef.current?.select(null); doc.removeObject(sel.kind, sel.index); }}>🗑 {t('delete')}</button></div>
            </section>
          )}

          <section>
            <h4>{t('edCheck')} {errors.length ? <span className="ed-badge err">⛔ {errors.length}</span> : <span className="ed-badge ok">✓</span>}{warnings.length ? <span className="ed-badge warn">⚠ {warnings.length}</span> : null}</h4>
            {issues.length === 0 && <p className="small ok-text">{t('edCheckOk')}</p>}
            <ul className="ed-issues">
              {issues.map((is, i) => (
                <li key={i}>
                  <button className={`ed-issue ${is.error ? 'err' : 'warn'}`} disabled={is.x === undefined} onClick={() => { if (is.x !== undefined && is.y !== undefined) viewRef.current?.centerOn(is.x, is.y); }}>
                    {is.error ? '⛔' : '⚠'} {t(ISSUE_KEYS[is.code], { zone: (is.zone ?? 0) + 1, n: MAP_STARTS_PER_ZONE_MAX, min: MAP_SIZE_MIN, max: MAP_SIZE_MAX })}
                  </button>
                </li>
              ))}
            </ul>
            <p className="tiny muted">{t('edStats', { zones, mines: doc.mines.length, gold: totalGold.toLocaleString() })}</p>
          </section>
        </aside>
      </div>

      <div className="ed-status small">
        <span className="ed-coords">{hover ? `${hover.x}, ${hover.y} · ${tileName}` : '—'}</span>
        <span className="muted ed-hint">{t(TOOL_HINTS[opts.tool])}</span>
      </div>

      {dialog === 'resize' && <ResizeDialog doc={doc} close={() => setDialog(null)} done={() => { setDialog(null); viewRef.current?.fit(); }} />}
      {dialog === 'scatter' && <ScatterDialog symmetry={opts.symmetry} close={() => setDialog(null)} apply={(density) => { doc.scatter(opts.symmetry, density, (Math.random() * 0x7fffffff) | 0); setDialog(null); }} />}
    </div>
  );
}

function GoldInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = (s: string) => {
    const v = Math.round(Number(s) / 100) * 100;
    if (Number.isFinite(v) && v >= MINE_GOLD_MIN && v <= MINE_GOLD_MAX) onChange(v); else setText(String(value));
  };
  return (
    <div className="col">
      <div className="ed-golds">
        {GOLD_PRESETS.map((g) => <button key={g} className={value === g ? 'gold' : 'plain'} onClick={() => onChange(g)}>{g / 1000}k</button>)}
      </div>
      <input type="number" min={MINE_GOLD_MIN} max={MINE_GOLD_MAX} step={500} value={text} onChange={(e) => setText(e.target.value)}
        onBlur={(e) => commit(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') commit((e.target as HTMLInputElement).value); }} />
    </div>
  );
}

function Modal({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [close]);
  return (
    <div className="overlay modal-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="card narrow" role="dialog" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

function ResizeDialog({ doc, close, done }: { doc: EditorDoc; close: () => void; done: () => void }) {
  const t = useT();
  const [w, setW] = useState(doc.w);
  const [h, setH] = useState(doc.h);
  const [anchor, setAnchor] = useState<[number, number]>([0.5, 0.5]);
  const ok = w >= MAP_SIZE_MIN && w <= MAP_SIZE_MAX && h >= MAP_SIZE_MIN && h <= MAP_SIZE_MAX;
  const cut = w < doc.w || h < doc.h;
  return (
    <Modal title={t('edResize')} close={close}>
      <SizeFields w={w} h={h} setW={setW} setH={setH} />
      <h3>{t('edAnchor')}</h3>
      <div className="ed-anchor">
        {[0, 0.5, 1].flatMap((ay) => [0, 0.5, 1].map((ax) => (
          <button key={`${ax}-${ay}`} className={anchor[0] === ax && anchor[1] === ay ? 'gold' : 'plain'} onClick={() => setAnchor([ax, ay])} aria-label={`${ax},${ay}`}>
            {anchor[0] === ax && anchor[1] === ay ? '■' : '·'}
          </button>
        )))}
      </div>
      {cut && <p className="small muted">{t('edResizeCut')}</p>}
      <div className="row end">
        <button className="plain" onClick={close}>{t('cancel')}</button>
        <button className="primary" disabled={!ok} onClick={() => { doc.resize(w, h, anchor[0], anchor[1]); done(); }}>{t('apply')}</button>
      </div>
    </Modal>
  );
}

function ScatterDialog({ symmetry, close, apply }: { symmetry: Symmetry; close: () => void; apply: (density: number) => void }) {
  const t = useT();
  const [density, setDensity] = useState(1);
  return (
    <Modal title={t('edScatter')} close={close}>
      <p className="small muted">{t('edScatterNote')}</p>
      <div className="seg">
        {([[0.5, 'edSparse'], [1, 'edNormal'], [1.8, 'edDense']] as [number, TKey][]).map(([d, k]) => (
          <button key={d} className={density === d ? 'gold' : 'plain'} onClick={() => setDensity(d)}>{t(k)}</button>
        ))}
      </div>
      <p className="small muted">{t('edSymmetry')}: {t(SYM[symmetry].key)}</p>
      <div className="row end">
        <button className="plain" onClick={close}>{t('cancel')}</button>
        <button className="primary" onClick={() => apply(density)}>{t('edGenerate')}</button>
      </div>
    </Modal>
  );
}

/** width and height, with the common sizes one click away */
export function SizeFields({ w, h, setW, setH }: { w: number; h: number; setW: (v: number) => void; setH: (v: number) => void }) {
  const t = useT();
  const presets = [64, 96, 128, 192, 256, 384, 512];
  const num = (v: string) => Math.round(Number(v) || 0);
  return (
    <div className="col">
      <div className="row">
        <label className="field grow"><span className="small muted">{t('mapWidth')}</span>
          <input type="number" min={MAP_SIZE_MIN} max={MAP_SIZE_MAX} value={w} onChange={(e) => setW(num(e.target.value))} /></label>
        <span className="muted" style={{ marginTop: 18 }}>×</span>
        <label className="field grow"><span className="small muted">{t('mapHeight')}</span>
          <input type="number" min={MAP_SIZE_MIN} max={MAP_SIZE_MAX} value={h} onChange={(e) => setH(num(e.target.value))} /></label>
      </div>
      <div className="ed-presets">
        {presets.map((p) => <button key={p} className={w === p && h === p ? 'gold' : 'plain'} onClick={() => { setW(p); setH(p); }}>{p}</button>)}
      </div>
      <p className="tiny muted">{t('mapSizeRange', { min: MAP_SIZE_MIN, max: MAP_SIZE_MAX })}</p>
    </div>
  );
}
