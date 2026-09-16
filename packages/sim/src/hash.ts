/** FNV-1a 32-bit over int32 values (state hashing for desync detection). */
export class Fnv1a {
  h = 0x811c9dc5 | 0;
  int(v: number): void {
    let h = this.h;
    h ^= v & 0xff; h = Math.imul(h, 0x01000193);
    h ^= (v >>> 8) & 0xff; h = Math.imul(h, 0x01000193);
    h ^= (v >>> 16) & 0xff; h = Math.imul(h, 0x01000193);
    h ^= (v >>> 24) & 0xff; h = Math.imul(h, 0x01000193);
    this.h = h;
  }
  value(): number {
    return this.h >>> 0;
  }
}
export function hashString(s: string): number {
  const f = new Fnv1a();
  for (let i = 0; i < s.length; i++) f.int(s.charCodeAt(i));
  return f.value();
}
