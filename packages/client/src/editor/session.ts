import { MINE_GOLD_DEFAULT, Tile } from '@rookfall/sim';
import { EditorDoc } from './doc';
import { Camera, ToolOptions } from './view';

/**
 * The map being edited lives outside React, so a test match, a trip to the menu or a language switch never
 * loses it: the editor screen picks the session up again where it was left, camera included.
 */
export interface EditorSession {
  doc: EditorDoc;
  cam?: Camera;
}

let current: EditorSession | null = null;

/** tool settings outlive any one map */
export let toolOptions: ToolOptions = { tool: 'brush', terrain: Tile.Forest, size: 3, square: false, symmetry: 'none', gold: MINE_GOLD_DEFAULT, zone: 0 };
export function setToolOptions(o: ToolOptions): void { toolOptions = o; }

export function editorSession(): EditorSession | null { return current; }
export function openEditor(doc: EditorDoc): EditorSession { current = { doc }; return current; }
export function closeEditor(): void { current = null; }

/** unsaved work in the editor (a reload or leaving the site would lose it) */
export function editorHasUnsaved(): boolean { return !!current?.doc.dirty; }

window.addEventListener('beforeunload', (e) => {
  if (!editorHasUnsaved()) return;
  e.preventDefault();
  e.returnValue = '';
});
