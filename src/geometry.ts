import type { Point } from "./model";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function dist(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function normalize(dx: number, dy: number): Point {
  const len = Math.hypot(dx, dy);
  return len < 1e-9 ? { x: 1, y: 0 } : { x: dx / len, y: dy / len };
}

export function boxCenter(b: Box): Point {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

export function boxContains(b: Box, p: Point): boolean {
  return p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
}

/**
 * Point where a ray starting inside `box` at `from` and travelling along the
 * unit vector `dir` leaves the box.
 */
export function rayExit(from: Point, dir: Point, box: Box): Point {
  let t = Infinity;
  if (dir.x > 1e-9) t = Math.min(t, (box.x + box.w - from.x) / dir.x);
  if (dir.x < -1e-9) t = Math.min(t, (box.x - from.x) / dir.x);
  if (dir.y > 1e-9) t = Math.min(t, (box.y + box.h - from.y) / dir.y);
  if (dir.y < -1e-9) t = Math.min(t, (box.y - from.y) / dir.y);
  if (!Number.isFinite(t) || t < 0) return { ...from };
  return { x: from.x + dir.x * t, y: from.y + dir.y * t };
}

export function corners(b: Box): Point[] {
  return [
    { x: b.x, y: b.y },
    { x: b.x + b.w, y: b.y },
    { x: b.x + b.w, y: b.y + b.h },
    { x: b.x, y: b.y + b.h },
  ];
}

export function nearestCorner(b: Box, p: Point): Point {
  let best = corners(b)[0];
  let bestD = Infinity;
  for (const c of corners(b)) {
    const d = dist(c, p);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

/** Normalise a box that may have negative width/height. */
export function normalizeBox(b: Box): Box {
  return {
    x: b.w < 0 ? b.x + b.w : b.x,
    y: b.h < 0 ? b.y + b.h : b.y,
    w: Math.abs(b.w),
    h: Math.abs(b.h),
  };
}
