/**
 * The annotation editor: a Konva stage with the photo, the annotation views
 * and a small UI layer (selection box, arrow-tip handle). All annotation
 * geometry lives in the model in original-image pixels; the image and
 * annotation layers carry the zoom/pan transform, the UI layer does not.
 */
import Konva from "konva";
import {
  MAGENTA,
  WHITE,
  cloneDoc,
  findAnnotation,
  newId,
  numberMap,
  styleFor,
  type Annotation,
  type ArrowAnnotation,
  type Doc,
  type Label,
  type Point,
  type RectAnnotation,
  type Style,
} from "./model";
import { type Box, clamp, dist, normalizeBox } from "./geometry";
import {
  ANN_NAME,
  PART_LABEL,
  createView,
  syncView,
  type AnnotationView,
  type RenderContext,
} from "./views";

export type Tool = "select" | "arrow" | "rect" | "text";
export type Part = "shape" | "label";
export interface Selection {
  id: string;
  part: Part;
}

interface ViewTransform {
  scale: number;
  x: number;
  y: number;
}

type Drag =
  | { kind: "pan"; startScreen: Point; startView: ViewTransform }
  | { kind: "move"; id: string; part: Part; start: Point; snapshot: Doc; moved: boolean }
  | { kind: "tip"; id: string; moved: boolean }
  | { kind: "create"; tool: "arrow" | "rect"; start: Point; current: Point; preview: Konva.Shape };

export interface EditorEvents {
  /** Fired whenever toolbar state (tool, selection, history, image) may have changed. */
  onChange(): void;
}

const ALL_ANCHORS = [
  "top-left",
  "top-center",
  "top-right",
  "middle-right",
  "middle-left",
  "bottom-left",
  "bottom-center",
  "bottom-right",
];
const MIN_SCALE = 0.05;
const MAX_SCALE = 40;
const HISTORY_LIMIT = 200;

export class Editor {
  readonly stage: Konva.Stage;
  private readonly imageLayer = new Konva.Layer({ listening: false });
  private readonly annLayer = new Konva.Layer();
  private readonly uiLayer = new Konva.Layer();
  private readonly transformer: Konva.Transformer;
  private readonly tipHandle: Konva.Circle;
  private readonly textarea: HTMLTextAreaElement;
  private readonly events: EditorEvents;

  private photo: Konva.Image | null = null;
  original: HTMLCanvasElement | null = null;
  imgW = 0;
  imgH = 0;
  style: Style = styleFor(1000, 1000);

  doc: Doc = { annotations: [] };
  private views = new Map<string, AnnotationView>();
  private undoStack: Doc[] = [];
  private redoStack: Doc[] = [];
  private committed: Doc = { annotations: [] };
  /** A freshly drawn annotation whose first text edit is still open. */
  private pendingCreate: string | null = null;

  view: ViewTransform = { scale: 1, x: 0, y: 0 };
  private autoFit = true;
  tool: Tool = "select";
  selection: Selection | null = null;
  private editing: { id: string; original: string } | null = null;
  private drag: Drag | null = null;
  private transformDirty = false;

  private readonly onWindowMove = (evt: MouseEvent) => this.handleWindowMove(evt);
  private readonly onWindowUp = (evt: MouseEvent) => this.handleWindowUp(evt);

  constructor(container: HTMLDivElement, textarea: HTMLTextAreaElement, events: EditorEvents) {
    this.events = events;
    this.textarea = textarea;
    this.stage = new Konva.Stage({
      container,
      width: Math.max(1, container.clientWidth),
      height: Math.max(1, container.clientHeight),
    });
    this.stage.add(this.imageLayer, this.annLayer, this.uiLayer);

    this.transformer = new Konva.Transformer({
      rotateEnabled: false,
      keepRatio: false,
      flipEnabled: false,
      ignoreStroke: true,
      anchorSize: 11,
      anchorStroke: MAGENTA,
      anchorFill: WHITE,
      anchorStrokeWidth: 2,
      anchorCornerRadius: 2,
      borderStroke: MAGENTA,
      borderStrokeWidth: 1.5,
      borderDash: [5, 4],
      boundBoxFunc: (oldBox, newBox) => (newBox.width < 2 || newBox.height < 2 ? oldBox : newBox),
    });
    this.tipHandle = new Konva.Circle({
      radius: 7,
      fill: WHITE,
      stroke: MAGENTA,
      strokeWidth: 2.5,
      hitStrokeWidth: 14,
      visible: false,
      name: "tip-handle",
    });
    this.uiLayer.add(this.transformer, this.tipHandle);

    this.stage.on("mousedown", (e) => this.handleMouseDown(e));
    this.stage.on("dblclick", (e) => this.handleDblClick(e));
    this.stage.on("wheel", (e) => this.handleWheel(e));
    this.stage.on("contextmenu", (e) => e.evt.preventDefault());
    this.stage.on("mouseover", (e) => this.updateCursor(e.target));
    this.stage.on("mouseout", () => this.updateCursor(null));
    this.transformer.on("transform", () => this.handleTransform());
    this.transformer.on("transformend", () => {
      // Konva skips hit-graph drawing while a transform is active, so the
      // annotation layer must be redrawn once it ends or the next click
      // would not find any shape.
      this.annLayer.batchDraw();
      if (this.transformDirty) {
        this.transformDirty = false;
        this.commit();
      }
    });

    textarea.addEventListener("input", () => this.handleTextInput());
    textarea.addEventListener("keydown", (e) => {
      // While an IME is composing (Korean input), Escape/Enter belong to the IME.
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        this.finishEditing();
      }
    });
    textarea.addEventListener("blur", () => this.finishEditing());

    new ResizeObserver(() => this.resize()).observe(container);
  }

  // ---------------------------------------------------------------- state

  get hasImage(): boolean {
    return this.original !== null;
  }
  get canUndo(): boolean {
    return this.undoStack.length > 0 || this.pendingCreate !== null;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
  get isEditing(): boolean {
    return this.editing !== null;
  }

  private ctx(): RenderContext {
    return { style: this.style, imgW: this.imgW, imgH: this.imgH, scale: this.view.scale };
  }

  // ---------------------------------------------------------------- image

  /** Replace the photo. `canvas` holds the original pixels and is kept for export. */
  loadImage(canvas: HTMLCanvasElement): void {
    this.finishEditing();
    this.cancelDrag();
    this.original = canvas;
    this.imgW = canvas.width;
    this.imgH = canvas.height;
    this.style = styleFor(this.imgW, this.imgH);
    this.photo?.destroy();
    this.photo = new Konva.Image({ image: canvas, x: 0, y: 0, width: this.imgW, height: this.imgH });
    this.imageLayer.add(this.photo);

    this.transformer.nodes([]);
    for (const v of this.views.values()) v.group.destroy();
    this.views.clear();
    this.annLayer.destroyChildren();
    this.doc = { annotations: [] };
    this.committed = { annotations: [] };
    this.undoStack = [];
    this.redoStack = [];
    this.pendingCreate = null;
    this.selection = null;
    this.fit();
    this.render();
    this.events.onChange();
  }

  /** Photo plus annotations at the original resolution. */
  renderComposite(): HTMLCanvasElement {
    if (!this.original) throw new Error("no image");
    this.finishEditing();
    const out = document.createElement("canvas");
    out.width = this.imgW;
    out.height = this.imgH;
    const ctx = out.getContext("2d")!;
    ctx.drawImage(this.original, 0, 0);
    const saved = { ...this.view };
    this.annLayer.scale({ x: 1, y: 1 });
    this.annLayer.position({ x: 0, y: 0 });
    try {
      const overlay = this.annLayer.toCanvas({
        x: 0,
        y: 0,
        width: this.imgW,
        height: this.imgH,
        pixelRatio: 1,
      });
      ctx.drawImage(overlay, 0, 0);
    } finally {
      this.annLayer.scale({ x: saved.scale, y: saved.scale });
      this.annLayer.position({ x: saved.x, y: saved.y });
      this.annLayer.batchDraw();
    }
    return out;
  }

  // ---------------------------------------------------------------- view

  private setView(v: ViewTransform): void {
    const scaleChanged = v.scale !== this.view.scale;
    this.view = v;
    for (const layer of [this.imageLayer, this.annLayer]) {
      layer.scale({ x: v.scale, y: v.scale });
      layer.position({ x: v.x, y: v.y });
    }
    if (scaleChanged) this.syncAll();
    this.imageLayer.batchDraw();
    this.annLayer.batchDraw();
    this.updateTipHandle();
    if (this.editing) this.layoutTextarea();
  }

  fit(): void {
    if (!this.original) return;
    const W = this.stage.width();
    const H = this.stage.height();
    const m = 16;
    const scale = Math.min((W - 2 * m) / this.imgW, (H - 2 * m) / this.imgH, 1);
    const s = Math.max(scale, MIN_SCALE);
    this.setView({ scale: s, x: (W - this.imgW * s) / 2, y: (H - this.imgH * s) / 2 });
    this.autoFit = true;
  }

  zoomAt(screen: Point, factor: number): void {
    const old = this.view.scale;
    const next = clamp(old * factor, MIN_SCALE, MAX_SCALE);
    if (next === old) return;
    this.autoFit = false;
    this.setView({
      scale: next,
      x: screen.x - ((screen.x - this.view.x) * next) / old,
      y: screen.y - ((screen.y - this.view.y) * next) / old,
    });
  }

  private resize(): void {
    const c = this.stage.container();
    const w = Math.max(1, c.clientWidth);
    const h = Math.max(1, c.clientHeight);
    if (w === this.stage.width() && h === this.stage.height()) return;
    this.stage.size({ width: w, height: h });
    if (this.original && this.autoFit) this.fit();
    else this.setView(this.view);
  }

  toImage(screen: Point): Point {
    return { x: (screen.x - this.view.x) / this.view.scale, y: (screen.y - this.view.y) / this.view.scale };
  }
  toScreen(p: Point): Point {
    return { x: p.x * this.view.scale + this.view.x, y: p.y * this.view.scale + this.view.y };
  }
  private screenFromEvent(evt: MouseEvent): Point {
    const r = this.stage.container().getBoundingClientRect();
    return { x: evt.clientX - r.left, y: evt.clientY - r.top };
  }
  private clampPoint(p: Point): Point {
    return { x: clamp(p.x, 0, this.imgW), y: clamp(p.y, 0, this.imgH) };
  }
  private clampLabel(label: Label, box: Box): void {
    label.x = clamp(label.x, 0, Math.max(0, this.imgW - box.w));
    label.y = clamp(label.y, 0, Math.max(0, this.imgH - box.h));
  }

  // ---------------------------------------------------------------- rendering

  /** Rebuild/refresh every view from the model. */
  render(): void {
    const ids = new Set(this.doc.annotations.map((a) => a.id));
    this.transformer.nodes([]);
    for (const [id, view] of this.views) {
      if (!ids.has(id)) {
        view.group.destroy();
        this.views.delete(id);
      }
    }
    const numbers = numberMap(this.doc);
    const ctx = this.ctx();
    for (const ann of this.doc.annotations) {
      let view = this.views.get(ann.id);
      if (!view || view.kind !== ann.kind) {
        view?.group.destroy();
        view = createView(ann);
        this.views.set(ann.id, view);
        this.annLayer.add(view.group);
      }
      syncView(view, ann, numbers.get(ann.id) ?? null, ctx);
      view.group.moveToTop();
    }
    if (this.selection && !ids.has(this.selection.id)) this.selection = null;
    this.annLayer.batchDraw();
    this.applySelection();
  }

  private syncAll(): void {
    const numbers = numberMap(this.doc);
    const ctx = this.ctx();
    for (const ann of this.doc.annotations) {
      const view = this.views.get(ann.id);
      if (view) syncView(view, ann, numbers.get(ann.id) ?? null, ctx);
    }
  }

  private syncOne(id: string): void {
    const ann = findAnnotation(this.doc, id);
    const view = this.views.get(id);
    if (!ann || !view) return;
    syncView(view, ann, numberMap(this.doc).get(id) ?? null, this.ctx());
    this.annLayer.batchDraw();
    this.updateTipHandle();
    if (this.editing?.id === id) this.layoutTextarea();
  }

  // ---------------------------------------------------------------- history

  private commit(): void {
    this.undoStack.push(this.committed);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.committed = cloneDoc(this.doc);
    this.pendingCreate = null;
    this.events.onChange();
  }

  undo(): void {
    this.finishEditing();
    this.cancelDrag();
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(this.committed);
    this.committed = prev;
    this.doc = cloneDoc(prev);
    this.render();
    this.events.onChange();
  }

  redo(): void {
    this.finishEditing();
    this.cancelDrag();
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.committed);
    this.committed = next;
    this.doc = cloneDoc(next);
    this.render();
    this.events.onChange();
  }

  // ---------------------------------------------------------------- tools & selection

  setTool(tool: Tool): void {
    if (this.tool === tool) return;
    this.finishEditing();
    this.tool = tool;
    if (tool !== "select") this.select(null);
    this.updateCursor(null);
    this.events.onChange();
  }

  select(sel: Selection | null): void {
    this.selection = sel;
    this.applySelection();
    this.events.onChange();
  }

  private applySelection(): void {
    const sel = this.selection;
    const view = sel ? this.views.get(sel.id) : undefined;
    if (!sel || !view) {
      this.selection = null;
      this.transformer.nodes([]);
      this.tipHandle.visible(false);
    } else if (sel.part === "label" || view.kind === "text") {
      this.transformer.setAttrs({ enabledAnchors: [], resizeEnabled: false });
      this.transformer.nodes([view.label.group]);
      this.tipHandle.visible(false);
    } else if (view.kind === "rect") {
      this.transformer.setAttrs({ enabledAnchors: ALL_ANCHORS, resizeEnabled: true });
      this.transformer.nodes([view.rect]);
      this.tipHandle.visible(false);
    } else {
      this.transformer.setAttrs({ enabledAnchors: [], resizeEnabled: false });
      this.transformer.nodes([view.group]);
      this.tipHandle.visible(true);
      this.updateTipHandle();
    }
    this.uiLayer.batchDraw();
  }

  private updateTipHandle(): void {
    const sel = this.selection;
    const ann = sel ? findAnnotation(this.doc, sel.id) : undefined;
    if (!sel || !ann || ann.kind !== "arrow" || sel.part !== "shape") {
      if (this.tipHandle.visible()) {
        this.tipHandle.visible(false);
        this.uiLayer.batchDraw();
      }
      return;
    }
    this.tipHandle.position(this.toScreen(ann.tip));
    this.tipHandle.visible(true);
    this.uiLayer.batchDraw();
  }

  deleteSelected(): void {
    if (!this.selection || this.editing) return;
    const id = this.selection.id;
    if (!findAnnotation(this.doc, id)) return;
    this.doc.annotations = this.doc.annotations.filter((a) => a.id !== id);
    this.selection = null;
    this.render();
    this.commit();
  }

  private resolveHit(target: Konva.Node | null): Selection | null {
    if (!target || target === this.stage || target === this.photo) return null;
    if (target === this.tipHandle || target.findAncestor("Transformer", true)) return null;
    const group = target.findAncestor(`.${ANN_NAME}`, true);
    if (!group) return null;
    const id = group.getAttr("annId") as string;
    const part: Part = target.findAncestor(`.${PART_LABEL}`, true) ? "label" : "shape";
    return { id, part };
  }

  private updateCursor(hover: Konva.Node | null): void {
    const c = this.stage.container();
    if (this.drag?.kind === "pan") c.style.cursor = "grabbing";
    else if (hover === this.tipHandle) c.style.cursor = "crosshair";
    else if (hover?.findAncestor("Transformer", true)) c.style.cursor = "";
    else if (this.tool !== "select") c.style.cursor = "crosshair";
    else c.style.cursor = this.resolveHit(hover) ? "move" : "default";
  }

  // ---------------------------------------------------------------- pointer input

  private handleMouseDown(e: Konva.KonvaEventObject<MouseEvent>): void {
    const evt = e.evt;
    if (evt.button === 1) {
      evt.preventDefault();
      this.finishEditing();
      this.startPan(evt);
      return;
    }
    if (evt.button !== 0) return;
    if (this.editing) {
      // The first click outside the text box only closes it.
      evt.preventDefault();
      this.finishEditing();
      return;
    }
    if (!this.original) return;
    if (e.target.findAncestor("Transformer", true)) return;
    const p = this.toImage(this.screenFromEvent(evt));
    evt.preventDefault();

    if (e.target === this.tipHandle && this.selection) {
      this.drag = { kind: "tip", id: this.selection.id, moved: false };
      this.bindWindowDrag();
      return;
    }

    switch (this.tool) {
      case "select": {
        const hit = this.resolveHit(e.target);
        if (hit) {
          this.select(hit);
          this.drag = { kind: "move", id: hit.id, part: hit.part, start: p, snapshot: cloneDoc(this.doc), moved: false };
          this.bindWindowDrag();
        } else {
          this.select(null);
          this.startPan(evt);
        }
        break;
      }
      case "arrow":
      case "rect": {
        const preview = this.makePreview(this.tool);
        this.annLayer.add(preview);
        this.drag = { kind: "create", tool: this.tool, start: p, current: p, preview };
        this.bindWindowDrag();
        break;
      }
      case "text": {
        const ann: Annotation = {
          id: newId(),
          kind: "text",
          label: { x: p.x, y: p.y, text: "" },
        };
        this.doc.annotations.push(ann);
        this.pendingCreate = ann.id;
        this.render();
        const view = this.views.get(ann.id)!;
        this.clampLabel(ann.label, view.label.getBox());
        this.syncOne(ann.id);
        this.select({ id: ann.id, part: "label" });
        this.startEditing(ann.id);
        break;
      }
    }
  }

  private handleDblClick(e: Konva.KonvaEventObject<MouseEvent>): void {
    if (!this.original || this.editing) return;
    const hit = this.resolveHit(e.target);
    if (!hit || hit.part !== "label") return;
    e.evt.preventDefault();
    this.cancelDrag();
    this.select(hit);
    this.startEditing(hit.id);
  }

  private handleWheel(e: Konva.KonvaEventObject<WheelEvent>): void {
    e.evt.preventDefault();
    if (!this.original) return;
    const p = this.stage.getPointerPosition();
    if (!p) return;
    // One mouse-wheel notch (deltaY = 100) zooms by 10%; trackpads scroll in
    // smaller steps and get proportionally smaller zoom changes.
    const notches = clamp(-e.evt.deltaY / 100, -5, 5);
    this.zoomAt(p, Math.pow(1.1, notches));
  }

  private startPan(evt: MouseEvent): void {
    this.drag = { kind: "pan", startScreen: this.screenFromEvent(evt), startView: { ...this.view } };
    this.updateCursor(null);
    this.bindWindowDrag();
  }

  private bindWindowDrag(): void {
    window.addEventListener("mousemove", this.onWindowMove);
    window.addEventListener("mouseup", this.onWindowUp);
  }

  private unbindWindowDrag(): void {
    window.removeEventListener("mousemove", this.onWindowMove);
    window.removeEventListener("mouseup", this.onWindowUp);
  }

  private cancelDrag(): void {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    this.unbindWindowDrag();
    if (d.kind === "create") d.preview.destroy();
    if (d.kind === "move" && d.moved) {
      this.doc = cloneDoc(d.snapshot);
      this.render();
    }
    this.annLayer.batchDraw();
    this.updateCursor(null);
  }

  private handleWindowMove(evt: MouseEvent): void {
    const d = this.drag;
    if (!d) return;
    const screen = this.screenFromEvent(evt);
    const p = this.toImage(screen);
    switch (d.kind) {
      case "pan":
        this.autoFit = false;
        this.setView({
          scale: d.startView.scale,
          x: d.startView.x + screen.x - d.startScreen.x,
          y: d.startView.y + screen.y - d.startScreen.y,
        });
        break;
      case "move": {
        const dx = p.x - d.start.x;
        const dy = p.y - d.start.y;
        if (!d.moved && Math.hypot(dx, dy) * this.view.scale < 2) return;
        d.moved = true;
        const src = findAnnotation(d.snapshot, d.id);
        const dst = findAnnotation(this.doc, d.id);
        const view = this.views.get(d.id);
        if (!src || !dst || !view) return;
        this.applyMove(src, dst, d.part, dx, dy);
        this.clampLabel(dst.label, view.label.getBox());
        this.syncOne(d.id);
        break;
      }
      case "tip": {
        const ann = findAnnotation(this.doc, d.id);
        if (!ann || ann.kind !== "arrow") return;
        ann.tip = this.clampPoint(p);
        d.moved = true;
        this.syncOne(d.id);
        break;
      }
      case "create":
        d.current = p;
        this.updatePreview(d);
        this.annLayer.batchDraw();
        break;
    }
  }

  private applyMove(src: Annotation, dst: Annotation, part: Part, dx: number, dy: number): void {
    dst.label.x = src.label.x + dx;
    dst.label.y = src.label.y + dy;
    if (part === "label") return;
    if (src.kind === "arrow" && dst.kind === "arrow") {
      dst.tip = this.clampPoint({ x: src.tip.x + dx, y: src.tip.y + dy });
    } else if (src.kind === "rect" && dst.kind === "rect") {
      dst.x = clamp(src.x + dx, 0, Math.max(0, this.imgW - src.w));
      dst.y = clamp(src.y + dy, 0, Math.max(0, this.imgH - src.h));
    }
  }

  private handleWindowUp(evt: MouseEvent): void {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    this.unbindWindowDrag();
    switch (d.kind) {
      case "move":
      case "tip":
        if (d.moved) this.commit();
        break;
      case "create":
        d.preview.destroy();
        d.current = this.toImage(this.screenFromEvent(evt));
        this.finishCreate(d);
        break;
      case "pan":
        break;
    }
    this.annLayer.batchDraw();
    this.updateCursor(null);
    this.events.onChange();
  }

  // ---------------------------------------------------------------- creating shapes

  private makePreview(tool: "arrow" | "rect"): Konva.Shape {
    const s = this.style;
    if (tool === "arrow") {
      return new Konva.Arrow({
        points: [0, 0, 0, 0],
        stroke: MAGENTA,
        fill: MAGENTA,
        strokeWidth: s.stroke,
        pointerLength: s.headLength,
        pointerWidth: s.headWidth,
        lineCap: "round",
        listening: false,
        opacity: 0.85,
        visible: false,
      });
    }
    return new Konva.Rect({
      stroke: MAGENTA,
      strokeWidth: s.stroke,
      dash: [s.stroke * 3, s.stroke * 2],
      listening: false,
      opacity: 0.85,
      visible: false,
    });
  }

  private updatePreview(d: Extract<Drag, { kind: "create" }>): void {
    const a = d.start;
    const b = d.current;
    if (d.tool === "arrow") {
      (d.preview as Konva.Arrow).points([a.x, a.y, b.x, b.y]);
    } else {
      const box = normalizeBox({ x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y });
      d.preview.setAttrs({ x: box.x, y: box.y, width: box.w, height: box.h });
    }
    d.preview.visible(true);
  }

  private finishCreate(d: Extract<Drag, { kind: "create" }>): void {
    const a = d.start;
    const b = d.current;
    let ann: Annotation;
    if (d.tool === "arrow") {
      if (dist(a, b) * this.view.scale < 6) return;
      ann = { id: newId(), kind: "arrow", tip: this.clampPoint(b), label: { x: a.x, y: a.y, text: "" } };
    } else {
      const box = normalizeBox({ x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y });
      if (box.w * this.view.scale < 4 || box.h * this.view.scale < 4) return;
      const x0 = clamp(box.x, 0, this.imgW);
      const y0 = clamp(box.y, 0, this.imgH);
      const x1 = clamp(box.x + box.w, 0, this.imgW);
      const y1 = clamp(box.y + box.h, 0, this.imgH);
      if (x1 - x0 < 1 || y1 - y0 < 1) return;
      ann = { id: newId(), kind: "rect", x: x0, y: y0, w: x1 - x0, h: y1 - y0, label: { x: 0, y: 0, text: "" } };
    }
    this.doc.annotations.push(ann);
    this.pendingCreate = ann.id;
    this.render();
    const view = this.views.get(ann.id)!;
    const box = view.label.getBox();
    if (ann.kind === "arrow") {
      ann.label.x = a.x - box.w / 2;
      ann.label.y = a.y - box.h / 2;
    } else {
      this.placeRectLabel(ann, box);
    }
    this.clampLabel(ann.label, box);
    this.syncOne(ann.id);
    this.select({ id: ann.id, part: "label" });
    this.startEditing(ann.id);
  }

  /** First outer corner position (right, left, below, above) that fits in the photo. */
  private placeRectLabel(ann: RectAnnotation, box: Box): void {
    const gap = this.style.stroke * 3;
    const candidates: Point[] = [
      { x: ann.x + ann.w + gap, y: ann.y },
      { x: ann.x - gap - box.w, y: ann.y },
      { x: ann.x, y: ann.y + ann.h + gap },
      { x: ann.x, y: ann.y - gap - box.h },
      { x: ann.x + gap, y: ann.y + gap },
    ];
    const fits = (p: Point) => p.x >= 0 && p.y >= 0 && p.x + box.w <= this.imgW && p.y + box.h <= this.imgH;
    const pos = candidates.find(fits) ?? candidates[candidates.length - 1];
    ann.label.x = pos.x;
    ann.label.y = pos.y;
  }

  // ---------------------------------------------------------------- transformer (rect resize)

  private handleTransform(): void {
    const sel = this.selection;
    const view = sel ? this.views.get(sel.id) : undefined;
    const ann = sel ? findAnnotation(this.doc, sel.id) : undefined;
    if (!sel || !view || !ann || view.kind !== "rect" || ann.kind !== "rect" || sel.part !== "shape") return;
    const node = view.rect;
    const w = node.width() * node.scaleX();
    const h = node.height() * node.scaleY();
    node.scale({ x: 1, y: 1 });
    const box = normalizeBox({ x: node.x(), y: node.y(), w, h });
    const x0 = clamp(box.x, 0, this.imgW);
    const y0 = clamp(box.y, 0, this.imgH);
    const x1 = clamp(box.x + box.w, 0, this.imgW);
    const y1 = clamp(box.y + box.h, 0, this.imgH);
    ann.x = x0;
    ann.y = y0;
    ann.w = Math.max(1, x1 - x0);
    ann.h = Math.max(1, y1 - y0);
    this.transformDirty = true;
    this.syncOne(sel.id);
  }

  // ---------------------------------------------------------------- text editing

  startEditing(id: string): void {
    if (this.editing?.id === id) return;
    this.finishEditing();
    const ann = findAnnotation(this.doc, id);
    const view = this.views.get(id);
    if (!ann || !view) return;
    this.editing = { id, original: ann.label.text };
    view.label.text.visible(false);
    this.annLayer.batchDraw();
    const ta = this.textarea;
    ta.value = ann.label.text;
    ta.style.display = "block";
    this.layoutTextarea();
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    this.events.onChange();
  }

  private layoutTextarea(): void {
    const ed = this.editing;
    const view = ed ? this.views.get(ed.id) : undefined;
    if (!ed || !view) return;
    const box = view.label.getBox();
    const tr = view.label.textRect();
    const s = this.view.scale;
    const st = this.style;
    const origin = this.toScreen({ x: box.x + tr.x, y: box.y + tr.y });
    const ta = this.textarea;
    ta.style.left = `${origin.x}px`;
    ta.style.top = `${origin.y}px`;
    ta.style.width = `${(tr.w + st.fontSize) * s}px`;
    ta.style.height = `${tr.h * s}px`;
    ta.style.fontSize = `${st.fontSize * s}px`;
    ta.style.lineHeight = String(st.lineHeight);
    ta.style.fontFamily = st.fontFamily;
  }

  private handleTextInput(): void {
    const ed = this.editing;
    if (!ed) return;
    const ann = findAnnotation(this.doc, ed.id);
    if (!ann) return;
    ann.label.text = this.textarea.value;
    this.syncOne(ed.id);
  }

  finishEditing(): void {
    const ed = this.editing;
    if (!ed) return;
    this.editing = null;
    const ta = this.textarea;
    const text = ta.value.replace(/\s+$/u, "");
    ta.style.display = "none";
    ta.value = "";
    const ann = findAnnotation(this.doc, ed.id);
    const view = this.views.get(ed.id);
    view?.label.text.visible(true);
    if (!ann) {
      this.annLayer.batchDraw();
      return;
    }
    ann.label.text = text;
    const wasPending = this.pendingCreate === ed.id;
    if (ann.kind === "text" && text === "") {
      // An empty stand-alone box is pointless; drop it again.
      this.doc.annotations = this.doc.annotations.filter((a) => a.id !== ed.id);
      if (this.selection?.id === ed.id) this.selection = null;
      this.render();
      if (wasPending) {
        this.pendingCreate = null;
        this.events.onChange();
      } else {
        this.commit();
      }
      return;
    }
    this.syncOne(ed.id);
    if (wasPending || text !== ed.original) this.commit();
    else this.events.onChange();
  }

  /** Starts editing the selected annotation's text, if any. */
  editSelected(): void {
    if (this.selection) this.startEditing(this.selection.id);
  }
}

export type { ArrowAnnotation };
