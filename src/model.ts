/** Shared data model: everything is stored in original-image pixel coordinates. */

export interface Point {
  x: number;
  y: number;
}

/** A comment box. (x, y) is the top-left corner of the box. */
export interface Label {
  x: number;
  y: number;
  text: string;
}

export interface ArrowAnnotation {
  id: string;
  kind: "arrow";
  /** Where the arrowhead points. The tail is attached to the label box. */
  tip: Point;
  label: Label;
}

export interface RectAnnotation {
  id: string;
  kind: "rect";
  x: number;
  y: number;
  w: number;
  h: number;
  label: Label;
}

/** Closed outline through the clicked points; the badge sits on the first one. */
export interface PolygonAnnotation {
  id: string;
  kind: "polygon";
  points: Point[];
  label: Label;
}

export interface TextAnnotation {
  id: string;
  kind: "text";
  label: Label;
}

export type Annotation = ArrowAnnotation | RectAnnotation | PolygonAnnotation | TextAnnotation;

export interface Doc {
  annotations: Annotation[];
}

let counter = 0;
export function newId(): string {
  counter += 1;
  return `a${Date.now().toString(36)}${counter.toString(36)}`;
}

export function cloneDoc(doc: Doc): Doc {
  return structuredClone(doc);
}

export function findAnnotation(doc: Doc, id: string): Annotation | undefined {
  return doc.annotations.find((a) => a.id === id);
}

/**
 * Numbers are derived from the order of arrows/rects/polygons in the
 * document, so deleting one automatically renumbers the rest.
 */
export function numberMap(doc: Doc): Map<string, number> {
  const map = new Map<string, number>();
  let n = 0;
  for (const a of doc.annotations) {
    if (a.kind !== "text") {
      n += 1;
      map.set(a.id, n);
    }
  }
  return map;
}

/** Visual parameters, all proportional to the photo size. */
export interface Style {
  stroke: number;
  outline: number;
  fontSize: number;
  lineHeight: number;
  fontFamily: string;
  badgeRadius: number;
  headLength: number;
  headWidth: number;
  connectorWidth: number;
  labelBorder: number;
  labelPadX: number;
  labelPadY: number;
  labelRadius: number;
}

export const MAGENTA = "#FF00FF";
export const WHITE = "#FFFFFF";
export const BLACK = "#000000";

export const FONT_FAMILY =
  '"Malgun Gothic", "맑은 고딕", "Apple SD Gothic Neo", "NanumGothic", "Noto Sans KR", "Noto Sans CJK KR", Arial, sans-serif';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function styleFor(imgW: number, imgH: number): Style {
  const u = Math.max(imgW, imgH) / 1000;
  const stroke = clamp(Math.round(3.2 * u), 2, 80);
  const fontSize = clamp(Math.round(13 * u), 14, 400);
  return {
    stroke,
    outline: Math.max(1, Math.round(stroke * 0.45)),
    fontSize,
    lineHeight: 1.25,
    fontFamily: FONT_FAMILY,
    badgeRadius: Math.round(fontSize * 0.72),
    headLength: stroke * 7,
    headWidth: stroke * 3.6,
    connectorWidth: Math.max(1.5, stroke * 0.6),
    labelBorder: Math.max(1.5, stroke * 0.5),
    labelPadX: Math.round(fontSize * 0.4),
    labelPadY: Math.round(fontSize * 0.28),
    labelRadius: Math.round(fontSize * 0.2),
  };
}
