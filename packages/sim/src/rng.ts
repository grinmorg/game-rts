/** xorshift128+ style seeded PRNG on 32-bit halves (deterministic, no BigInt). */
export class Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(seed: number) {
    // splitmix-ish seeding
    let x = seed | 0;
    const next = () => {
      x = (x + 0x9e3779b9) | 0;
      let z = x;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
      return (z ^ (z >>> 16)) | 0;
    };
    this.s0 = next();
    this.s1 = next();
    this.s2 = next();
    this.s3 = next();
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1;
  }

  /** uint32 */
  nextU32(): number {
    // xoshiro128**
    const result = Math.imul(rotl(Math.imul(this.s1, 5), 7), 9) >>> 0;
    const t = this.s1 << 9;
    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = rotl(this.s3, 11);
    return result;
  }
  /** integer in [0, n) */
  nextInt(n: number): number {
    if (n <= 0) return 0;
    return this.nextU32() % n;
  }
  /** integer in [lo, hi] inclusive */
  range(lo: number, hi: number): number {
    return lo + this.nextInt(hi - lo + 1);
  }
  /** float in [0,1) - only for map generation / view, never for tick logic */
  nextFloat(): number {
    return this.nextU32() / 4294967296;
  }
  chance(p: number): boolean {
    return this.nextU32() < p * 4294967296;
  }
  state(): [number, number, number, number] {
    return [this.s0, this.s1, this.s2, this.s3];
  }
  setState(s: [number, number, number, number]) {
    [this.s0, this.s1, this.s2, this.s3] = s;
  }
}
function rotl(x: number, k: number): number {
  return (x << k) | (x >>> (32 - k));
}
