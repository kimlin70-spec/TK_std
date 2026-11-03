/**
 * Konva node trees for each annotation kind. A view is created once and then
 * kept in sync with its model object; nothing here mutates the model.
 */
import Konva from "konva";
import {
  BLACK,
  MAGENTA,
  WHITE,
  type Annotation,
  type ArrowAnnotation,
  type Label,
  type Point,
  type RectAnnotation,
  type Style,
  type TextAnnotation,
} from "./model";
import {
  type Box,
  boxCenter,
  boxContains,
  clamp,
  dist,
  nearestCorner,
  normalize,
  rayExit,
} from "./geometry";

export interface RenderContext {
  style: Style;
  imgW: number;
  imgH: number;
  /** Current zoom; keeps hit areas grabbable when the photo is zoomed out. */
  scale: number;
}

export const ANN_NAME = "ann";
export const PART_LABEL = "part-label";
export const PART_SHAPE = "part-shape";
export const PART_BADGE = "part-badge";

const hitWidth = (ctx: RenderContext, base: number) => Math.max(base, 18 / ctx.scale);

function digitFont(n: number, diameter: number): number {
  const digits = String(n).length;
  return diameter * (digits === 1 ? 0.78 : digits === 2 ? 0.66 : 0.52);
}

/** White text box with a black comment and an optional inline number. */
export class LabelView {
  readonly group: Konva.Group;
  readonly text: Konva.Text;
  private readonly bg: Konva.Rect;
  private readonly badge: Konva.Circle;
  private readonly badgeText: Konva.Text;
  private box: Box = { x: 0, y: 0, w: 0, h: 0 };

  constructor() {
    this.group = new Konva.Group({ name: PART_LABEL });
    this.bg = new Konva.Rect({ fill: WHITE, stroke: MAGENTA });
    this.badge = new Konva.Circle({ fill: MAGENTA, listening: false });
    this.badgeText = new Konva.Text({
      fill: WHITE,
      fontStyle: "bold",
      align: "center",
      verticalAlign: "middle",
      listening: false,
    });
    this.text = new Konva.Text({ fill: BLACK, listening: false });
    this.group.add(this.bg, this.badge, this.badgeText, this.text);
  }

  /** Applies the label to the nodes and returns its box in image coordinates. */
  sync(label: Label, number: number | null, ctx: RenderContext): Box {
    const s = ctx.style;
    const lineH = s.fontSize * s.lineHeight;
    this.text.setAttrs({
      text: label.text,
      fontSize: s.fontSize,
      fontFamily: s.fontFamily,
      lineHeight: s.lineHeight,
    });
    const textW = Math.max(this.text.getTextWidth(), s.fontSize * 0.6);
    const textH = this.text.height();
    let textX = s.labelPadX;
    if (number != null) {
      const r = s.fontSize * 0.5;
      this.badge.setAttrs({ x: s.labelPadX + r, y: s.labelPadY + lineH / 2, radius: r, visible: true });
      this.badgeText.setAttrs({
        x: s.labelPadX,
        y: s.labelPadY + lineH / 2 - r,
        width: 2 * r,
        height: 2 * r,
        text: String(number),
        fontSize: digitFont(number, 2 * r),
        fontFamily: s.fontFamily,
        visible: true,
      });
      textX += 2 * r + s.fontSize * 0.3;
    } else {
      this.badge.visible(false);
      this.badgeText.visible(false);
    }
    this.text.position({ x: textX, y: s.labelPadY });
    const w = textX + textW + s.labelPadX;
    const h = s.labelPadY * 2 + textH;
    this.bg.setAttrs({
      x: 0,
      y: 0,
      width: w,
      height: h,
      strokeWidth: s.labelBorder,
      cornerRadius: s.labelRadius,
    });
    this.group.position({ x: label.x, y: label.y });
    this.box = { x: label.x, y: label.y, w, h };
    return this.box;
  }

  /** Last computed box in image coordinates. */
  getBox(): Box {
    return this.box;
  }

  /** Where the editable text sits, relative to the label origin (image units). */
  textRect(): Box {
    return {
      x: this.text.x(),
      y: this.text.y(),
      w: Math.max(this.text.getTextWidth(), this.text.fontSize() * 0.6),
      h: this.text.height(),
    };
  }
}

/** Circled number: magenta disc with a white ring and white digits. */
class BadgeView {
  readonly group: Konva.Group;
  private readonly circle: Konva.Circle;
  private readonly text: Konva.Text;

  constructor() {
    this.group = new Konva.Group({ name: PART_BADGE });
    this.circle = new Konva.Circle({ fill: MAGENTA, stroke: WHITE });
    this.text = new Konva.Text({
      fill: WHITE,
      fontStyle: "bold",
      align: "center",
      verticalAlign: "middle",
      listening: false,
    });
    this.group.add(this.circle, this.text);
  }

  sync(center: Point, number: number, ctx: RenderContext): void {
    const s = ctx.style;
    const r = s.badgeRadius;
    const ring = Math.max(1.5, s.outline * 1.2);
    const c = {
      x: clamp(center.x, r + ring, ctx.imgW - r - ring),
      y: clamp(center.y, r + ring, ctx.imgH - r - ring),
    };
    this.group.position(c);
    this.circle.setAttrs({ x: 0, y: 0, radius: r, strokeWidth: ring });
    this.text.setAttrs({
      x: -r,
      y: -r,
      width: 2 * r,
      height: 2 * r,
      text: String(number),
      fontSize: digitFont(number, 2 * r),
      fontFamily: s.fontFamily,
    });
  }
}

function makeGroup(id: string): Konva.Group {
  const g = new Konva.Group({ name: ANN_NAME });
  g.setAttr("annId", id);
  return g;
}

export class ArrowView {
  readonly kind = "arrow" as const;
  readonly group: Konva.Group;
  readonly label = new LabelView();
  /** The magenta shaft; the transformer border is drawn around it. */
  readonly shaft: Konva.Line;
  private readonly whiteShaft: Konva.Line;
  private readonly whiteHead: Konva.Line;
  private readonly head: Konva.Line;
  private readonly badge = new BadgeView();

  constructor(id: string) {
    this.group = makeGroup(id);
    this.whiteShaft = new Konva.Line({ stroke: WHITE, lineCap: "round", listening: false });
    this.whiteHead = new Konva.Line({ fill: WHITE, closed: true, strokeEnabled: false, listening: false });
    this.shaft = new Konva.Line({ stroke: MAGENTA, lineCap: "round", name: PART_SHAPE });
    this.head = new Konva.Line({ fill: MAGENTA, closed: true, strokeEnabled: false, name: PART_SHAPE });
    this.group.add(this.whiteShaft, this.whiteHead, this.shaft, this.head, this.badge.group, this.label.group);
  }

  sync(ann: ArrowAnnotation, number: number, ctx: RenderContext): void {
    const s = ctx.style;
    const o = s.outline;
    const box = this.label.sync(ann.label, number, ctx);
    const c = boxCenter(box);
    const tip = ann.tip;
    const dir = normalize(tip.x - c.x, tip.y - c.y);
    const perp = { x: -dir.y, y: dir.x };
    const exit = rayExit(c, dir, box);
    const gap = s.stroke * 1.2;
    const start = { x: exit.x + dir.x * gap, y: exit.y + dir.y * gap };
    const L = s.headLength;
    const HW = s.headWidth / 2;
    const shaftEnd = { x: tip.x - dir.x * L * 0.8, y: tip.y - dir.y * L * 0.8 };
    const along = (shaftEnd.x - start.x) * dir.x + (shaftEnd.y - start.y) * dir.y;
    const showShaft = along > s.stroke * 0.5;
    const pts = [start.x, start.y, shaftEnd.x, shaftEnd.y];
    this.whiteShaft.setAttrs({ points: pts, strokeWidth: s.stroke + 2 * o, visible: showShaft });
    this.shaft.setAttrs({
      points: pts,
      strokeWidth: s.stroke,
      hitStrokeWidth: hitWidth(ctx, s.stroke + 2 * o),
      visible: showShaft,
    });
    const headPts = (len: number, hw: number) => {
      const bx = tip.x - dir.x * len;
      const by = tip.y - dir.y * len;
      return [tip.x, tip.y, bx + perp.x * hw, by + perp.y * hw, bx - perp.x * hw, by - perp.y * hw];
    };
    // The apex of both triangles sits exactly on the tip, so the outline never
    // extends past the point being indicated.
    this.whiteHead.points(headPts(L + o * 1.6, HW + o * 1.4));
    this.head.points(headPts(L, HW));

    // Number badge beside the head, flipped to the other side if it would
    // leave the photo.
    const r = s.badgeRadius;
    const off = r + HW + o + s.stroke * 0.6;
    const base = { x: tip.x - dir.x * L * 0.75, y: tip.y - dir.y * L * 0.75 };
    let center = { x: base.x + perp.x * off, y: base.y + perp.y * off };
    if (center.x < r || center.x > ctx.imgW - r || center.y < r || center.y > ctx.imgH - r) {
      center = { x: base.x - perp.x * off, y: base.y - perp.y * off };
    }
    this.badge.sync(center, number, ctx);
  }

  shapeNode(): Konva.Node {
    return this.shaft;
  }
}

export class RectView {
  readonly kind = "rect" as const;
  readonly group: Konva.Group;
  readonly label = new LabelView();
  /** The magenta rectangle; the transformer attaches to it. */
  readonly rect: Konva.Rect;
  private readonly whiteRect: Konva.Rect;
  private readonly whiteConnector: Konva.Line;
  private readonly connector: Konva.Line;
  private readonly badge = new BadgeView();

  constructor(id: string) {
    this.group = makeGroup(id);
    this.whiteRect = new Konva.Rect({ stroke: WHITE, listening: false });
    this.rect = new Konva.Rect({ stroke: MAGENTA, name: PART_SHAPE });
    this.whiteConnector = new Konva.Line({ stroke: WHITE, lineCap: "round", listening: false });
    this.connector = new Konva.Line({ stroke: MAGENTA, lineCap: "round", name: PART_SHAPE });
    this.group.add(
      this.whiteRect,
      this.rect,
      this.whiteConnector,
      this.connector,
      this.badge.group,
      this.label.group,
    );
  }

  sync(ann: RectAnnotation, number: number, ctx: RenderContext): void {
    const s = ctx.style;
    const o = s.outline;
    this.whiteRect.setAttrs({ x: ann.x, y: ann.y, width: ann.w, height: ann.h, strokeWidth: s.stroke + 2 * o });
    this.rect.setAttrs({
      x: ann.x,
      y: ann.y,
      width: ann.w,
      height: ann.h,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      strokeWidth: s.stroke,
      hitStrokeWidth: hitWidth(ctx, s.stroke + 2 * o),
    });

    const box = this.label.sync(ann.label, number, ctx);
    const c = boxCenter(box);
    const corner = nearestCorner({ x: ann.x, y: ann.y, w: ann.w, h: ann.h }, c);
    let show = !boxContains(box, corner);
    let pts: number[] = [];
    if (show) {
      const dir = normalize(corner.x - c.x, corner.y - c.y);
      const exit = rayExit(c, dir, box);
      const start = { x: exit.x + dir.x * s.stroke * 0.8, y: exit.y + dir.y * s.stroke * 0.8 };
      show = dist(start, corner) > s.stroke * 1.5;
      pts = [start.x, start.y, corner.x, corner.y];
    }
    this.whiteConnector.setAttrs({ points: pts, strokeWidth: s.connectorWidth + 2 * o * 0.8, visible: show });
    this.connector.setAttrs({
      points: pts,
      strokeWidth: s.connectorWidth,
      hitStrokeWidth: hitWidth(ctx, s.connectorWidth + 2 * o),
      visible: show,
    });

    this.badge.sync({ x: ann.x, y: ann.y }, number, ctx);
  }

  shapeNode(): Konva.Node {
    return this.rect;
  }
}

export class TextView {
  readonly kind = "text" as const;
  readonly group: Konva.Group;
  readonly label = new LabelView();

  constructor(id: string) {
    this.group = makeGroup(id);
    this.group.add(this.label.group);
  }

  sync(ann: TextAnnotation, _number: number | null, ctx: RenderContext): void {
    this.label.sync(ann.label, null, ctx);
  }

  shapeNode(): Konva.Node | null {
    return null;
  }
}

export type AnnotationView = ArrowView | RectView | TextView;

export function createView(ann: Annotation): AnnotationView {
  switch (ann.kind) {
    case "arrow":
      return new ArrowView(ann.id);
    case "rect":
      return new RectView(ann.id);
    case "text":
      return new TextView(ann.id);
  }
}

export function syncView(view: AnnotationView, ann: Annotation, number: number | null, ctx: RenderContext): void {
  if (view.kind === "arrow" && ann.kind === "arrow") view.sync(ann, number ?? 0, ctx);
  else if (view.kind === "rect" && ann.kind === "rect") view.sync(ann, number ?? 0, ctx);
  else if (view.kind === "text" && ann.kind === "text") view.sync(ann, null, ctx);
}
