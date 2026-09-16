/**
 * Keyboard layout independence: hotkeys are bound to the *physical* key, so "A" on a Russian layout (Ф) still
 * means attack-move. `KeyboardEvent.code` names the physical key; we fold it back to the character the key
 * carries on a US layout, which is what the settings store and show.
 */
const PUNCTUATION: Record<string, string> = {
  BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
  Backquote: '`', Minus: '-', Equal: '=', Backslash: '\\',
};

/** the hotkey name of a keyboard event: a lower-case character for printable keys, the key name otherwise */
export function keyFromEvent(e: KeyboardEvent): string {
  const c = e.code;
  if (c.length === 4 && c.startsWith('Key')) return c[3].toLowerCase();
  if (c.length === 6 && c.startsWith('Digit')) return c[5];
  if (c in PUNCTUATION) return PUNCTUATION[c];
  if (c.startsWith('Arrow')) return c.toLowerCase();
  // Escape, Enter, Backspace, F1..F12, Space ... - and a fallback for keyboards that report no code
  if (e.key.length === 1) return e.key.toLowerCase();
  return e.key;
}
