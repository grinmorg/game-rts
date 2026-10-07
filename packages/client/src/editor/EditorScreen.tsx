import { CSSProperties, ReactNode, useEffect, useReducer, useRef, useState } from 'react';
import {
  CREATURE_LEASH, CREATURE_PATROL_RADIUS, CREATURE_TYPES, KILL_BOUNTY_DIV, MAP_NAME_MAX, MAP_SIZE_MAX, MAP_SIZE_MIN, MAP_STARTS_PER_ZONE_MAX, MAX_PLAYERS,
  MINE_GOLD_MAX, MINE_GOLD_MIN, MapIssue, PLAYER_COLORS, Tile, UNITS, customMapThumb, decodeCustomSource, encodeCustomMap, mapHasErrors, validateCustomMap,
} from '@pocket-of-empire/sim';
import { TKey, useT } from '../i18n';
import { net } from '../net/client';
import { myMapById, saveMap } from '../net/maps';
import { useTouchUI } from '../touch';
import { ScaleBar, useDialog } from '../ui/CommunityMaps';
import { PickedMap } from '../ui/MapPicker';
import { ISSUE_KEYS, mapErrorKey } from '../ui/mapText';
import { EditorDoc, SYMMETRIES, Symmetry } from './doc';
import { closeEditor, editorSession, openEditor, setToolOptions, toolOptions } from './session';
import { EditorView, Selection, TILE_RGB, Tool, ToolOptions } from './view';
import { Icon, IconId } from '../ui/icons/Icon';

const TERRAINS: { tile: Tile; key: TKey }[] = [
  { tile: Tile.Grass, key: 'tileGrass' }, { tile: Tile.Dirt, key: 'tileDirt' }, { tile: Tile.Forest, key: 'tileForest' },
  { tile: Tile.Rock, key: 'tileRock' }, { tile: Tile.Water, key: 'tileWater' },
];
/** the tool rail, in three groups: terrain, objects, getting about */
const TOOLS: { tool: Tool; icon: IconId; code: string; hotkey: string; label: TKey; group: number }[] = [
  { tool: 'brush', icon: 'tool-brush', code: 'KeyB', hotkey: 'B', label: 'toolBrush', group: 0 },
  { tool: 'line', icon: 'tool-line', code: 'KeyL', hotkey: 'L', label: 'toolLine', group: 0 },
  { tool: 'rect', icon: 'tool-rect', code: 'KeyR', hotkey: 'R', label: 'toolRect', group: 0 },
  { tool: 'fill', icon: 'tool-fill', code: 'KeyG', hotkey: 'G', label: 'toolFill', group: 0 },
  { tool: 'pick', icon: 'tool-pick', code: 'KeyI', hotkey: 'I', label: 'toolPick', group: 0 },
  { tool: 'mine', icon: 'gold-vein', code: 'KeyM', hotkey: 'M', label: 'toolMine', group: 1 },
  { tool: 'start', icon: 'tool-spawn', code: 'KeyS', hotkey: 'S', label: 'toolStart', group: 1 },
  { tool: 'creature', icon: 'tool-golem', code: 'KeyC', hotkey: 'C', label: 'toolCreature', group: 1 },
  { tool: 'select', icon: 'tool-select', code: 'KeyV', hotkey: 'V', label: 'toolSelect', group: 2 },
  { tool: 'pan', icon: 'tool-pan', code: 'KeyH', hotkey: 'H', label: 'toolPan', group: 2 },
];
const TOOL_HINTS: Record<Tool, TKey> = {
  brush: 'hintBrush', line: 'hintLine', rect: 'hintRect', fill: 'hintFill', pick: 'hintPick', mine: 'hintMine', start: 'hintStart', creature: 'hintCreature',
  select: 'hintSelect', pan: 'hintPan',
};
/** the same hints for a finger: no Alt, no right button, no wheel, no Delete key */
const TOOL_HINTS_TOUCH: Record<Tool, TKey> = {
  brush: 'hintBrushTouch', line: 'hintLine', rect: 'hintRect', fill: 'hintFillTouch', pick: 'hintPickTouch', mine: 'hintMineTouch', start: 'hintStartTouch',
  creature: 'hintCreatureTouch', select: 'hintSelectTouch', pan: 'hintPanTouch',
};
const SYM: Record<Symmetry, { icon: IconId; key: TKey }> = {
  none: { icon: 'sym-none', key: 'symNone' }, x: { icon: 'sym-x', key: 'symX' }, y: { icon: 'sym-y', key: 'symY' },
  xy: { icon: 'sym-xy', key: 'symXY' }, rot: { icon: 'sym-rot', key: 'symRot' }, rot4: { icon: 'sym-rot4', key: 'symRot4' },
};
const GOLD_PRESETS = [3000, 6000, 8000, 10000, 15000];
const PAINT_TOOLS: Tool[] = ['brush', 'line', 'rect', 'fill'];
const hex = (c: number) => '#' + c.toString(16).padStart(6, '0');
const rgb = (t: number) => `rgb(${TILE_RGB[t].join(',')})`;
/** a team colour or a terrain colour goes in as a custom property, never as an inline background */
const tint = (name: '--team' | '--swatch', value: string) => ({ [name]: value }) as CSSProperties;

interface Toast { text: string; kind: 'ok' | 'error' | 'info'; id: number }
/** a step that waits for "yes": leaving or replacing unsaved work, wiping the terrain */
type Confirm = { kind: 'leave' } | { kind: 'clear' } | { kind: 'import'; doc: EditorDoc };

/**
 * The map editor: paint terrain, lay out gold and spawns, check the map, save it to the server, try it
 * against bots. The document and the camera live in the editor session (session.ts), so the screen can be
 * left for a test match and come back to the same state.
 */
export function EditorScreen({ back, test }: { back: () => void; test: (payload: string, picked: PickedMap) => void }) {
  const t = useT();
  const touch = useTouchUI();
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
  const [confirm, setConfirm] = useState<Confirm | null>(null);
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
      onRefused: (r) => flash(t(r === 'mines' ? 'edTooManyMines' : r === 'creatures' ? 'edTooManyCreatures' : 'edTooManyStarts', { n: MAP_STARTS_PER_ZONE_MAX, zones: MAX_PLAYERS }), 'error'),
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

  const leaveNow = () => { closeEditor(); back(); };
  const leave = () => { if (doc?.dirty) setConfirm({ kind: 'leave' }); else leaveNow(); };

  const exportFile = () => {
    if (!doc) return;
    const blob = new Blob([encodeCustomMap(doc.toSource())], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(doc.name || 'map').replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '') || 'map'}.rookmap`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  const adoptImported = (next: EditorDoc) => {
    openEditor(next);
    setDoc(next);
    setSel(null);
    flash(t('edImported'), 'ok');
  };
  const importFile = async (file: File) => {
    const src = decodeCustomSource(await file.text());
    if (!src) { flash(t('edImportBad'), 'error'); return; }
    const next = new EditorDoc(src);
    next.dirty = true;
    if (doc?.dirty) setConfirm({ kind: 'import', doc: next });
    else adoptImported(next);
  };

  // keyboard: tools, terrain, brush size, undo/redo, delete, save
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!doc || dialog || confirm) return;
      const el = e.target as HTMLElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA')) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.code === 'KeyZ') { e.preventDefault(); if (e.shiftKey) doc.redo(); else doc.undo(); return; }
      if (mod && e.code === 'KeyY') { e.preventDefault(); doc.redo(); return; }
      if (mod && e.code === 'KeyS') { e.preventDefault(); void save(); return; }
      if (mod || e.altKey || e.repeat) return;
      // Esc closes what is open first: the menu (it handles its own key), then the side drawer of a narrow screen
      if (e.code === 'Escape' && menu) return;
      if (e.code === 'Escape' && side && window.matchMedia('(max-width: 900px)').matches) { setSide(false); return; }
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
  const selCreature = sel?.kind === 'creature' ? doc.creatures[sel.index] : undefined;
  const selTitle = selMine ? t('edSelMine') : selStart ? t('edSelStart') : t('edSelCreature');
  const selAt = selMine ?? selStart ?? selCreature;
  const zoneCount = (z: number) => doc.starts.filter((s) => s.zone === z).length;
  // the first dozen zones, and as many more as the map uses plus the next free one - a hundred buttons for a duel
  // map would only be noise
  const zonesShown = Math.min(MAX_PLAYERS, Math.max(12, opts.zone + 2, ...doc.starts.map((s) => s.zone + 2)));
  const tileName = hover ? t(TERRAINS.find((x) => x.tile === doc.tileAt(hover.x, hover.y))?.key ?? 'tileGrass') : '';
  const totalGold = doc.mines.reduce((a, m) => a + m.gold, 0);
  const brushLike = opts.tool === 'brush' || opts.tool === 'line';
  const current = TOOLS.find((x) => x.tool === opts.tool) ?? TOOLS[0];
  const hint = touch ? `${t(TOOL_HINTS_TOUCH[opts.tool])}${opts.tool === 'pan' ? '' : ` ${t('edViewTouch')}`}` : t(TOOL_HINTS[opts.tool]);
  const square = doc.w === doc.h;

  return (
    <div className={`editor ${side ? 'is-side-open' : ''}`}>
      <div className="ed-top">
        <button type="button" className="btn btn--quiet ed-back" onClick={leave} aria-label={t('back')}><Icon name="back" /><span className="ed-label">{t('back')}</span></button>
        <input className="text ed-name" value={doc.name} placeholder={t('untitledMap')} maxLength={MAP_NAME_MAX} onChange={(e) => doc.rename(e.target.value)} aria-label={t('mapName')} enterKeyHint="done" />
        <span className="ed-meta num">{doc.w}×{doc.h} · {t('mapPlayersN', { n: zones })}</span>
        <span className="ed-top__spacer" />
        <div className="ed-top__group">
          <button type="button" className="btn btn--quiet btn--icon" title={`${t('undo')} (Ctrl+Z)`} aria-label={t('undo')} aria-keyshortcuts="Control+Z" disabled={!doc.canUndo} onClick={() => doc.undo()}><Icon name="undo" /></button>
          <button type="button" className="btn btn--quiet btn--icon" title={`${t('redo')} (Ctrl+Shift+Z)`} aria-label={t('redo')} aria-keyshortcuts="Control+Shift+Z" disabled={!doc.canRedo} onClick={() => doc.redo()}><Icon name="redo" /></button>
        </div>
        <div className="ed-top__group">
          <button
            type="button" className="btn btn--secondary btn--compact ed-save" onClick={() => void save()} disabled={saving || !connected}
            title={connected ? `${t('save')} (Ctrl+S)` : t('mapErrOffline')} aria-keyshortcuts="Control+S"
          >
            <Icon name="save" /><span className="ed-label">{saving ? t('saving') : t('save')}</span>
            {doc.dirty && <><span className="ed-dirty" aria-hidden="true" /><span className="sr-only">{t('edUnsaved')}</span></>}
          </button>
          <button type="button" className="btn btn--seal btn--compact ed-test" onClick={runTest} title={t('testMapHint')}><Icon name="play" /><span className="ed-label ed-label--keep">{t('testMap')}</span></button>
          <OverflowMenu open={menu} setOpen={setMenu} label={t('more')}>
            <button type="button" role="menuitem" className="ed-menu__item" disabled={saving || !connected || !doc.id} onClick={() => void save(true)}><Icon name="copy" />{t('saveCopy')}</button>
            <button type="button" role="menuitem" className="ed-menu__item" onClick={() => setDialog('resize')}><Icon name="resize" />{t('edResize')}</button>
            <button type="button" role="menuitem" className="ed-menu__item" onClick={() => setDialog('scatter')}><Icon name="scatter" />{t('edScatter')}</button>
            <button type="button" role="menuitem" className="ed-menu__item" onClick={() => setConfirm({ kind: 'clear' })}><Icon name="clear" />{t('edClear')}…</button>
            <span className="ed-menu__rule" role="separator" />
            <button type="button" role="menuitem" className="ed-menu__item" onClick={exportFile}><Icon name="export" />{t('edExport')}</button>
            <button type="button" role="menuitem" className="ed-menu__item" onClick={() => fileRef.current?.click()}><Icon name="import" />{t('edImport')}</button>
          </OverflowMenu>
          <button type="button" className="btn btn--quiet btn--icon ed-side-toggle" onClick={() => setSide(!side)} aria-expanded={side} aria-controls="ed-side" title={t('edPanel')} aria-label={t('edPanel')}><Icon name="panel" /></button>
        </div>
        <input ref={fileRef} type="file" accept=".rookmap,.json,application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importFile(f); }} />
      </div>

      <div className="ed-body">
        <div className="ed-tools" role="toolbar" aria-label={t('edTools')}>
          {TOOLS.map((x, i) => (
            <div key={x.tool} className="ed-tools__slot">
              {i > 0 && TOOLS[i - 1].group !== x.group && <span className="ed-tools__sep" aria-hidden="true" />}
              <button
                type="button" className="ed-tool" aria-pressed={opts.tool === x.tool} aria-label={t(x.label)} aria-keyshortcuts={x.hotkey}
                onClick={() => setOpts({ tool: x.tool })}
              >
                <Icon name={x.icon} />
                {!touch && <span className="ed-tool__key" aria-hidden="true">{x.hotkey}</span>}
                {!touch && <span className="ed-tool__tip" aria-hidden="true">{t(x.label)}<kbd className="keycap">{x.hotkey}</kbd></span>}
              </button>
            </div>
          ))}
        </div>

        <div className="ed-stage">
          <canvas ref={canvasRef} className="ed-canvas" />
          <div className="ed-zoom" role="group" aria-label={t('edZoom')}>
            <button type="button" className="btn btn--secondary btn--icon" onClick={() => viewRef.current?.zoomBy(1 / 1.4)} title={t('zoomOut')} aria-label={t('zoomOut')}><Icon name="zoom-out" /></button>
            <button type="button" className="btn btn--secondary btn--icon" onClick={() => viewRef.current?.fit()} title={`${t('edFit')} (F)`} aria-label={t('edFit')}><Icon name="fit" /></button>
            <button type="button" className="btn btn--secondary btn--icon" onClick={() => viewRef.current?.zoomBy(1.4)} title={t('zoomIn')} aria-label={t('zoomIn')}><Icon name="zoom-in" /></button>
          </div>
          <div className="ed-toast-slot" role="status" aria-live="polite">
            {toast && (
              <div key={toast.id} className={`toast toast--static ed-toast ${toast.kind === 'ok' ? 'toast--ok' : toast.kind === 'error' ? 'toast--danger' : ''}`}>
                <Icon name={toast.kind === 'ok' ? 'check' : toast.kind === 'error' ? 'error' : 'info'} />{toast.text}
              </div>
            )}
          </div>
        </div>

        <aside id="ed-side" className={`ed-side ${side ? 'open' : ''}`} aria-label={t('edPanel')}>
          <div className="ed-side__head">
            <span className="ed-side__title">{t('edPanel')}</span>
            <button type="button" className="btn btn--quiet btn--icon" onClick={() => setSide(false)} aria-label={t('close')}><Icon name="close" /></button>
          </div>

          <Section title={t('edTerrain')} meta={touch ? undefined : '1–5'}>
            <div className="ed-terrains">
              {TERRAINS.map((x, i) => (
                <button
                  key={x.tile} type="button" className="ed-terrain" title={`${t(x.key)} (${i + 1})`} aria-pressed={opts.terrain === x.tile}
                  onClick={() => setOpts({ terrain: x.tile, tool: PAINT_TOOLS.includes(opts.tool) ? opts.tool : lastPaint.current })}
                >
                  <span className="ed-swatch" style={tint('--swatch', rgb(x.tile))} aria-hidden="true" />
                  <span className="ed-terrain__name">{t(x.key)}</span>
                  {!touch && <span className="ed-terrain__key num" aria-hidden="true">{i + 1}</span>}
                </button>
              ))}
            </div>
            <p className="ed-note">{t('edTerrainNote')}</p>
          </Section>

          {brushLike && (
            <Section title={t('edBrush')} meta={touch ? undefined : '[ ]'}>
              <div className="ruler-row">
                <input
                  type="range" className="ruler" min={1} max={32} value={opts.size} onChange={(e) => setOpts({ size: Number(e.target.value) })}
                  aria-label={t('edBrushSize')} style={{ '--v': (opts.size - 1) / 31 } as CSSProperties}
                />
                <output className="ruler__value">{opts.size}</output>
              </div>
              <ScaleBar
                className="scalebar--words ed-fill-bar" label={t('edBrushShape')} value={opts.square ? 'square' : 'round'} onChange={(v) => setOpts({ square: v === 'square' })}
                items={[
                  { value: 'round', label: <><Icon name="shape-round" />{t('edRound')}</> },
                  { value: 'square', label: <><Icon name="shape-square" />{t('edSquare')}</> },
                ]}
              />
            </Section>
          )}

          <Section title={t('edSymmetry')}>
            <ScaleBar
              className="ed-fill-bar ed-syms" label={t('edSymmetry')} value={opts.symmetry} onChange={(s) => setOpts({ symmetry: s })}
              items={SYMMETRIES.map((s) => ({ value: s, label: <Icon name={SYM[s].icon} />, title: t(SYM[s].key), ariaLabel: t(SYM[s].key), disabled: s === 'rot4' && !square }))}
            />
            <p className="ed-note"><b>{t(SYM[opts.symmetry].key)}</b>{opts.symmetry !== 'none' ? ` — ${t('edSymNote')}` : ''}</p>
            {!square && <p className="ed-note">{t('edRot4Square')}</p>}
          </Section>

          {opts.tool === 'mine' && (
            <Section title={t('edGold')}>
              <GoldInput value={opts.gold} onChange={(gold) => setOpts({ gold })} />
            </Section>
          )}

          {opts.tool === 'creature' && (
            <Section title={t('edCreature')}>
              <CreatureSize value={opts.creature} onChange={(creature) => setOpts({ creature })} />
              <p className="ed-note">{t('edCreatureNote', {
                r: CREATURE_PATROL_RADIUS, leash: CREATURE_LEASH, gold: Math.floor(UNITS[CREATURE_TYPES[opts.creature]].cost / KILL_BOUNTY_DIV),
              })}</p>
            </Section>
          )}

          {opts.tool === 'start' && (
            <Section title={t('edZone')}>
              <div className="ed-zones">
                {Array.from({ length: zonesShown }, (_, z) => (
                  <ZoneButton key={z} z={z} count={zoneCount(z)} on={opts.zone === z} onClick={() => setOpts({ zone: z })} />
                ))}
              </div>
              <p className="ed-note">{t('edZoneNote', { n: MAP_STARTS_PER_ZONE_MAX })}</p>
            </Section>
          )}

          {selAt && sel && (
            <Section className="ed-sec--sel" title={selTitle} meta={`${selAt.x}, ${selAt.y}`}>
              {selMine && <GoldInput value={selMine.gold} onChange={(gold) => doc.updateMine(sel.index, gold)} />}
              {selCreature && <CreatureSize value={selCreature.size} onChange={(size) => doc.updateCreatureSize(sel.index, size)} />}
              {selStart && (
                <div className="ed-zones">
                  {Array.from({ length: zonesShown }, (_, z) => (
                    <ZoneButton key={z} z={z} count={zoneCount(z)} on={selStart.zone === z} onClick={() => doc.updateStartZone(sel.index, z)} />
                  ))}
                </div>
              )}
              <div className="ed-sec__actions">
                <button type="button" className="btn btn--secondary btn--small" onClick={() => { viewRef.current?.select(null); doc.removeObject(sel.kind, sel.index); }}>
                  <Icon name="delete" />{t('delete')}
                </button>
              </div>
            </Section>
          )}

          <Section
            title={t('edCheck')}
            meta={<>
              {errors.length > 0 && <span className="badge badge--danger"><Icon name="error" />{errors.length}<span className="sr-only"> {t('edErrorsSr')}</span></span>}
              {warnings.length > 0 && <span className="badge badge--warn"><Icon name="warning" />{warnings.length}<span className="sr-only"> {t('edWarningsSr')}</span></span>}
              {issues.length === 0 && <span className="badge badge--ok"><Icon name="check" />{t('edCheckOkShort')}</span>}
            </>}
          >
            {issues.length === 0 && <p className="ed-check-ok"><Icon name="check" />{t('edCheckOk')}</p>}
            {issues.length > 0 && (
              <ul className="ed-issues">
                {issues.map((is, i) => {
                  const text = t(ISSUE_KEYS[is.code], { zone: (is.zone ?? 0) + 1, n: MAP_STARTS_PER_ZONE_MAX, min: MAP_SIZE_MIN, max: MAP_SIZE_MAX });
                  const at = is.x !== undefined && is.y !== undefined;
                  return (
                    <li key={i}>
                      {at
                        ? (
                          <button type="button" className={`ed-issue ${is.error ? 'is-error' : 'is-warn'}`} onClick={() => { if (is.x !== undefined && is.y !== undefined) viewRef.current?.centerOn(is.x, is.y); }} title={t('edIssueShow')}>
                            <Icon name={is.error ? 'error' : 'warning'} /><span className="ed-issue__text">{text}</span><Icon name="pin" className="ed-issue__go" />
                          </button>
                        )
                        : <div className={`ed-issue ${is.error ? 'is-error' : 'is-warn'}`}><Icon name={is.error ? 'error' : 'warning'} /><span className="ed-issue__text">{text}</span></div>}
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="ed-stats num">{t('edStats', { zones, mines: doc.mines.length, gold: totalGold.toLocaleString() })}{doc.creatures.length ? t('edStatsCreatures', { n: doc.creatures.length }) : ''}</p>
          </Section>
        </aside>
      </div>

      <div className="ed-status">
        <span className="ed-coords num">{hover ? `${hover.x}, ${hover.y}` : '—'}{hover && <span className="ed-coords__tile"> · {tileName}</span>}</span>
        <span className="ed-hint"><Icon name={current.icon} /><b>{t(current.label)}</b><span className="ed-hint__text">{hint}</span></span>
        {!connected && <span className="badge badge--warn ed-offline"><Icon name="warning" />{t('edOffline')}</span>}
      </div>

      {dialog === 'resize' && <ResizeDialog doc={doc} close={() => setDialog(null)} done={() => { setDialog(null); viewRef.current?.fit(); }} />}
      {dialog === 'scatter' && <ScatterDialog symmetry={opts.symmetry} close={() => setDialog(null)} apply={(density) => { doc.scatter(opts.symmetry, density, (Math.random() * 0x7fffffff) | 0); setDialog(null); }} />}
      {confirm?.kind === 'leave' && (
        <ConfirmDialog title={t('edLeaveTitle')} text={t('edLeaveUnsaved')} yes={t('edLeaveAnyway')} close={() => setConfirm(null)} confirm={() => { setConfirm(null); leaveNow(); }} />
      )}
      {confirm?.kind === 'import' && (
        <ConfirmDialog title={t('edLeaveTitle')} text={t('edImportUnsaved')} yes={t('edReplace')} close={() => setConfirm(null)} confirm={() => { const next = confirm.doc; setConfirm(null); adoptImported(next); }} />
      )}
      {confirm?.kind === 'clear' && (
        <ConfirmDialog title={t('edClear')} text={t('edClearConfirm')} yes={t('edClear')} close={() => setConfirm(null)} confirm={() => { setConfirm(null); doc.clearTerrain(); }} />
      )}
    </div>
  );
}

/** a section of the side panel: a heading on a rule (a short note or badges at its right), then the controls */
function Section({ title, meta, className = '', children }: { title: string; meta?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={`ed-sec ${className}`}>
      <div className="ed-sec__head"><h3 className="ed-sec__title">{title}</h3>{meta !== undefined && <span className="ed-sec__meta">{meta}</span>}</div>
      {children}
    </section>
  );
}

/** a spawn zone: the team's pennant and the zone number, with how many spawn points it has so far */
function ZoneButton({ z, count, on, onClick }: { z: number; count: number; on: boolean; onClick: () => void }) {
  const t = useT();
  const name = t('edZoneN', { n: z + 1, c: count });
  return (
    <button type="button" className="ed-zone" style={tint('--team', hex(PLAYER_COLORS[z % PLAYER_COLORS.length]))} aria-pressed={on} title={name} aria-label={name} onClick={onClick}>
      <Icon name="flag" /><span className="ed-zone__no num">{z + 1}</span>{count > 0 && <span className="ed-zone__n num" aria-hidden="true">{count}</span>}
    </button>
  );
}

/** the "More" menu of the top bar: closes on a choice, a press outside it or Esc; arrow keys walk the items */
function OverflowMenu({ open, setOpen, label, children }: { open: boolean; setOpen: (v: boolean) => void; label: string; children: ReactNode }) {
  const wrap = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const items = () => [...(wrap.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
  useEffect(() => {
    if (!open) return;
    items()[0]?.focus();
    const onDown = (e: PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); setOpen(false); toggle.current?.focus(); } };
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown, true); window.removeEventListener('keydown', onKey); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return (
    <div className="ed-menu-wrap" ref={wrap}>
      <button
        type="button" ref={toggle} className="btn btn--quiet btn--compact ed-more" aria-haspopup="menu" aria-expanded={open} aria-label={label} title={label}
        onClick={() => setOpen(!open)}
      ><span className="ed-label">{label}</span><Icon name="more" /></button>
      {open && (
        <div
          className="ed-menu slip" role="menu" aria-label={label}
          onClick={(e) => { if ((e.target as HTMLElement).closest('[role="menuitem"]')) setOpen(false); }}
          onKeyDown={(e) => {
            const list = items();
            const i = list.indexOf(document.activeElement as HTMLButtonElement);
            const go = (k: number) => { e.preventDefault(); list[(k + list.length) % list.length]?.focus(); };
            if (e.key === 'ArrowDown') go(i + 1);
            else if (e.key === 'ArrowUp') go(i - 1);
            else if (e.key === 'Home') go(0);
            else if (e.key === 'End') go(list.length - 1);
            else if (e.key === 'Tab') setOpen(false);
          }}
        >{children}</div>
      )}
    </div>
  );
}

function GoldInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const t = useT();
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = (s: string) => {
    const v = Math.round(Number(s) / 100) * 100;
    if (Number.isFinite(v) && v >= MINE_GOLD_MIN && v <= MINE_GOLD_MAX) onChange(v); else setText(String(value));
  };
  return (
    <div className="ed-gold">
      <ScaleBar
        className="ed-fill-bar" label={t('edGold')} value={value} onChange={onChange}
        items={GOLD_PRESETS.map((g) => ({ value: g, label: `${g / 1000}k` }))}
      />
      <label className="ed-gold__exact">
        <span className="ed-note">{t('edGoldExact')}</span>
        <input
          className="text num" type="number" inputMode="numeric" min={MINE_GOLD_MIN} max={MINE_GOLD_MAX} step={500} value={text} onChange={(e) => setText(e.target.value)}
          onBlur={(e) => commit(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') commit((e.target as HTMLInputElement).value); }}
        />
      </label>
    </div>
  );
}

/** small, medium or large golem - the index into CREATURE_TYPES a map stores */
function CreatureSize({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const t = useT();
  const keys: TKey[] = ['edSizeS', 'edSizeM', 'edSizeL'];
  const u = UNITS[CREATURE_TYPES[value] ?? CREATURE_TYPES[0]];
  return (
    <>
      <ScaleBar
        className="scalebar--words ed-fill-bar" label={t('edCreature')} value={value} onChange={onChange}
        items={CREATURE_TYPES.map((_, i) => ({ value: i, label: t(keys[i]) }))}
      />
      <p className="ed-note num">{t('edCreatureStats', { hp: u.hp, dmg: u.damage })}</p>
    </>
  );
}

/** a dialog over the editor: a framed sheet, its title, the body, then the actions with the commit last */
function EdDialog({ title, close, children, foot, initial, className = '' }: {
  title: string; close: () => void; children: ReactNode; foot: ReactNode; initial?: () => HTMLElement | null | undefined; className?: string;
}) {
  const t = useT();
  const { scrimRef, boxRef, onBackdrop } = useDialog(close, initial);
  return (
    <div className="scrim maps-scrim" ref={scrimRef} onPointerDown={onBackdrop}>
      <div className={`dialog sheet sheet--framed maps-dialog ${className}`} role="dialog" aria-modal="true" aria-labelledby="ed-dlg-title" ref={boxRef} tabIndex={-1}>
        <div className="dialog__head">
          <h2 className="dialog__title" id="ed-dlg-title">{title}</h2>
          <button type="button" className="btn btn--quiet btn--icon dialog__close" aria-label={t('close')} onClick={close}><Icon name="close" /></button>
        </div>
        <div className="dialog__body">{children}</div>
        <div className="dialog__foot maps-dialog__foot">{foot}</div>
      </div>
    </div>
  );
}

/** "are you sure": the harmless choice has the focus, the one that loses work is hatched */
function ConfirmDialog({ title, text, yes, close, confirm }: { title: string; text: string; yes: string; close: () => void; confirm: () => void }) {
  const t = useT();
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <EdDialog
      title={title} close={close} initial={() => cancel.current} className="ed-confirm"
      foot={<>
        <button type="button" ref={cancel} className="btn btn--quiet" onClick={close}>{t('cancel')}</button>
        <button type="button" className="btn btn--danger" onClick={confirm}>{yes}</button>
      </>}
    >
      <p className="ed-confirm__text">{text}</p>
    </EdDialog>
  );
}

const ANCHORS: TKey[] = ['edAnchorTL', 'edAnchorT', 'edAnchorTR', 'edAnchorL', 'edAnchorC', 'edAnchorR', 'edAnchorBL', 'edAnchorB', 'edAnchorBR'];

function ResizeDialog({ doc, close, done }: { doc: EditorDoc; close: () => void; done: () => void }) {
  const t = useT();
  const [w, setW] = useState(doc.w);
  const [h, setH] = useState(doc.h);
  const [anchor, setAnchor] = useState<[number, number]>([0.5, 0.5]);
  const ok = w >= MAP_SIZE_MIN && w <= MAP_SIZE_MAX && h >= MAP_SIZE_MIN && h <= MAP_SIZE_MAX;
  const cut = w < doc.w || h < doc.h;
  return (
    <EdDialog
      title={t('edResize')} close={close}
      foot={<>
        <button type="button" className="btn btn--quiet" onClick={close}>{t('cancel')}</button>
        <button type="button" className="btn btn--seal btn--compact" disabled={!ok} onClick={() => { doc.resize(w, h, anchor[0], anchor[1]); done(); }}>{t('apply')}</button>
      </>}
    >
      <div className="ed-resize">
        <SizeFields w={w} h={h} setW={setW} setH={setH} />
        <div className="ed-resize__anchor">
          <span className="field__label" id="ed-anchor-label">{t('edAnchor')}</span>
          <div className="ed-anchor" role="group" aria-labelledby="ed-anchor-label">
            {[0, 0.5, 1].flatMap((ay, r) => [0, 0.5, 1].map((ax, c) => {
              const on = anchor[0] === ax && anchor[1] === ay;
              return (
                <button key={`${ax}-${ay}`} type="button" className="ed-anchor__cell" aria-pressed={on} aria-label={t(ANCHORS[r * 3 + c])} title={t(ANCHORS[r * 3 + c])} onClick={() => setAnchor([ax, ay])}>
                  {on ? <Icon name="anchor" /> : <span className="ed-anchor__dot" aria-hidden="true" />}
                </button>
              );
            }))}
          </div>
        </div>
      </div>
      {cut && <p className="ed-note is-warn"><Icon name="warning" />{t('edResizeCut')}</p>}
    </EdDialog>
  );
}

function ScatterDialog({ symmetry, close, apply }: { symmetry: Symmetry; close: () => void; apply: (density: number) => void }) {
  const t = useT();
  const [density, setDensity] = useState(1);
  return (
    <EdDialog
      title={t('edScatter')} close={close}
      foot={<>
        <button type="button" className="btn btn--quiet" onClick={close}>{t('cancel')}</button>
        <button type="button" className="btn btn--seal btn--compact" onClick={() => apply(density)}><Icon name="scatter" />{t('edGenerate')}</button>
      </>}
    >
      <p className="ed-note">{t('edScatterNote')}</p>
      <ScaleBar
        className="scalebar--words" label={t('edDensity')} value={density} onChange={setDensity}
        items={([[0.5, 'edSparse'], [1, 'edNormal'], [1.8, 'edDense']] as [number, TKey][]).map(([d, k]) => ({ value: d, label: t(k) }))}
      />
      <p className="ed-note">{t('edSymmetry')}: <b>{t(SYM[symmetry].key)}</b></p>
    </EdDialog>
  );
}

/** width and height, with the common sizes one click away */
export function SizeFields({ w, h, setW, setH }: { w: number; h: number; setW: (v: number) => void; setH: (v: number) => void }) {
  const t = useT();
  const presets = [64, 96, 128, 192, 256, 384, 512];
  const num = (v: string) => Math.round(Number(v) || 0);
  const bad = (v: number) => v < MAP_SIZE_MIN || v > MAP_SIZE_MAX;
  const anyBad = bad(w) || bad(h);
  return (
    <div className="size-fields">
      <div className="size-fields__wh">
        <label className="field">
          <span className="field__label">{t('mapWidth')}</span>
          <input className="text num" type="number" inputMode="numeric" min={MAP_SIZE_MIN} max={MAP_SIZE_MAX} value={w} aria-invalid={bad(w) || undefined} aria-describedby="size-range" onChange={(e) => setW(num(e.target.value))} />
        </label>
        <span className="size-fields__x" aria-hidden="true">×</span>
        <label className="field">
          <span className="field__label">{t('mapHeight')}</span>
          <input className="text num" type="number" inputMode="numeric" min={MAP_SIZE_MIN} max={MAP_SIZE_MAX} value={h} aria-invalid={bad(h) || undefined} aria-describedby="size-range" onChange={(e) => setH(num(e.target.value))} />
        </label>
      </div>
      <ScaleBar
        className="ed-fill-bar size-fields__presets" label={t('edSizePresets')} value={w === h ? w : -1} onChange={(p) => { setW(p); setH(p); }}
        items={presets.map((p) => ({ value: p, label: String(p) }))}
      />
      <p id="size-range" className={anyBad ? 'field__error' : 'field__hint'}>{t('mapSizeRange', { min: MAP_SIZE_MIN, max: MAP_SIZE_MAX })}</p>
    </div>
  );
}
