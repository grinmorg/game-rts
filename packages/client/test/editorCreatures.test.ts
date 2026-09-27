/**
 * Golems in the map editor: placed with the symmetry, undone and redone like any object, carried through a move, a
 * resize and the payload - and a map without any keeps the payload it always had.
 */
import { describe, expect, it } from 'vitest';
import { blankCustomMap, decodeCustomSource, encodeCustomMap } from '@rookfall/sim';
import { EditorDoc } from '../src/editor/doc';

describe('golems in the editor', () => {
  it('are placed mirrored, one step of history each, and survive the payload', () => {
    const doc = new EditorDoc(blankCustomMap('Golems', 64, 64));
    const plain = encodeCustomMap(doc.toSource());
    expect(doc.addCreature(20, 30, 2, 'x')).toBe(true);
    expect(doc.creatures).toEqual([{ x: 20, y: 30, size: 2 }, { x: 43, y: 30, size: 2 }]);
    // a second click on the same cells adds nothing more
    doc.addCreature(20, 30, 0, 'x');
    expect(doc.creatures).toHaveLength(2);
    expect(doc.objectAt(43, 30)).toEqual({ kind: 'creature', index: 1 });

    doc.updateCreatureSize(1, 0);
    expect(doc.creatures[1].size).toBe(0);
    doc.undo();
    expect(doc.creatures[1].size).toBe(2);
    doc.undo();
    expect(doc.creatures).toEqual([]);
    expect(encodeCustomMap(doc.toSource())).toBe(plain);
    doc.redo();
    expect(doc.creatures).toHaveLength(2);

    const before = doc.snapshotObjects();
    doc.dragObject('creature', 0, 22, 31);
    doc.commitMove(before);
    expect(doc.creatures[0]).toEqual({ x: 22, y: 31, size: 2 });
    doc.undo();
    expect(doc.creatures[0]).toEqual({ x: 20, y: 30, size: 2 });

    expect(decodeCustomSource(encodeCustomMap(doc.toSource()))!.creatures).toEqual(doc.creatures);
    doc.removeObject('creature', 0);
    expect(doc.creatures).toEqual([{ x: 43, y: 30, size: 2 }]);
  });

  it('move with the map when it is resized, and fall off with its edge', () => {
    const doc = new EditorDoc(blankCustomMap('Golems', 64, 64));
    doc.addCreature(5, 5, 1, 'none');
    doc.addCreature(60, 60, 1, 'none');
    doc.resize(48, 48, 0, 0);
    expect(doc.creatures).toEqual([{ x: 5, y: 5, size: 1 }]);
    doc.undo();
    expect(doc.creatures).toHaveLength(2);
  });
});
