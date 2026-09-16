/**
 * 16.16 fixed-point arithmetic on int32 values.
 * All simulation-space quantities (positions, distances, speeds) are FP numbers.
 * Only +, -, *, /, floor and Math.sqrt are used on doubles; those are IEEE-754
 * correctly-rounded on every JS engine, so results are bit-identical everywhere.
 */
export const FP_SHIFT = 16;
export const FP_ONE = 1 << FP_SHIFT; // 65536
export const FP_HALF = FP_ONE >> 1;

/** number (cells) -> fixed */
export function fp(n: number): number {
  return Math.round(n * FP_ONE) | 0;
}
/** fixed -> float (for view layer only) */
export function toFloat(a: number): number {
  return a / FP_ONE;
}
/** fixed -> integer cell index (floor) */
export function fpFloor(a: number): number {
  return a >> FP_SHIFT;
}
export function fpRound(a: number): number {
  return (a + FP_HALF) >> FP_SHIFT;
}
export function fpMul(a: number, b: number): number {
  // |a*b| stays far below 2^53 for map-scale values (a,b < 2^24)
  return Math.floor((a * b) / FP_ONE) | 0;
}
export function fpDiv(a: number, b: number): number {
  if (b === 0) return 0;
  return Math.floor((a * FP_ONE) / b) | 0;
}
/** sqrt of a fixed value, returns fixed */
export function fpSqrt(a: number): number {
  if (a <= 0) return 0;
  // sqrt(a/ONE)*ONE = sqrt(a*ONE)
  return Math.floor(Math.sqrt(a * FP_ONE)) | 0;
}
/** length of a fixed vector */
export function fpLen(dx: number, dy: number): number {
  // avoid overflow: compute in doubles then round; dx,dy < 2^24 so dx*dx < 2^48
  return Math.floor(Math.sqrt(dx * dx + dy * dy)) | 0;
}
export function fpLenSq(dx: number, dy: number): number {
  return dx * dx + dy * dy; // double, may exceed int32 - compare only
}
export function fpAbs(a: number): number {
  return a < 0 ? -a : a;
}
export function fpClamp(a: number, lo: number, hi: number): number {
  return a < lo ? lo : a > hi ? hi : a;
}
export function fpMin(a: number, b: number): number {
  return a < b ? a : b;
}
export function fpMax(a: number, b: number): number {
  return a > b ? a : b;
}
/** integer percent: a * pct / 100 */
export function pct(a: number, p: number): number {
  return Math.floor((a * p) / 100) | 0;
}
