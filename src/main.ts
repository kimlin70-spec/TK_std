import "./style.css";
import { Editor, type Tool } from "./editor";
import * as platform from "./platform";
import type { LoadedFile } from "./platform";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const stageEl = $<HTMLDivElement>("stage");
const wrap = $<HTMLDivElement>("canvas-wrap");
const textarea = $<HTMLTextAreaElement>("text-editor");
const fileInput = $<HTMLInputElement>("file-input");
const emptyHint = $<HTMLDivElement>("empty-hint");
const toastEl = $<HTMLDivElement>("toast");

interface SavePlan {
  annotated: string;
  original: string | null;
  originalWritten: boolean;
}

interface Session {
  source: "file" | "pasted";
  /** Base name without extension, used for the download / dialog default. */
  name: string;
  plan: SavePlan | null;
}

let session: Session | null = null;

const editor = new Editor(stageEl, textarea, { onChange: refreshToolbar });

const toolButtons: Record<Tool, HTMLButtonElement> = {
  select: $("btn-select"),
  arrow: $("btn-arrow"),
  rect: $("btn-rect"),
  polygon: $("btn-polygon"),
  text: $("btn-text"),
};
for (const [tool, btn] of Object.entries(toolButtons)) {
  btn.addEventListener("click", () => editor.setTool(tool as Tool));
}
// Keep keyboard focus off the buttons so Space/Enter never re-trigger them.
$<HTMLDivElement>("toolbar").addEventListener("click", (e) => {
  (e.target as HTMLElement).closest("button")?.blur();
});
$("btn-open").addEventListener("click", () => void openFile());
$("btn-undo").addEventListener("click", () => editor.undo());
$("btn-save").addEventListener("click", () => void save());
$("btn-copy").addEventListener("click", () => void copy());

function refreshToolbar(): void {
  for (const [tool, btn] of Object.entries(toolButtons)) {
    btn.classList.toggle("active", editor.tool === tool);
    btn.disabled = !editor.hasImage;
  }
  $<HTMLButtonElement>("btn-undo").disabled = !editor.canUndo;
  $<HTMLButtonElement>("btn-save").disabled = !editor.hasImage;
  $<HTMLButtonElement>("btn-copy").disabled = !editor.hasImage;
  emptyHint.style.display = editor.hasImage ? "none" : "";
  wrap.dataset.tool = editor.tool;
}

let toastTimer = 0;
function toast(message: string): void {
  toastEl.textContent = message;
  toastEl.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove("show"), 2600);
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function toPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG 인코딩 실패"))), "image/png"),
  );
}

// ---------------------------------------------------------------- loading

async function loadBlob(blob: Blob, next: Session): Promise<void> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    toast("이미지를 불러올 수 없습니다");
    return;
  }
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
  bitmap.close();
  session = next;
  editor.loadImage(canvas);
  editor.setTool("select");
  toast(`${next.name} (${canvas.width}×${canvas.height})`);
}

async function loadFromFile(f: LoadedFile): Promise<void> {
  const plan: SavePlan | null = f.path
    ? { annotated: `${platform.stripExtension(f.path)}_주석.png`, original: null, originalWritten: true }
    : null;
  await loadBlob(new Blob([f.bytes as BlobPart], { type: platform.mimeForName(f.name) }), {
    source: "file",
    name: platform.stripExtension(f.name),
    plan,
  });
}

function pastedSession(): Session {
  return { source: "pasted", name: `캡처_${timestamp()}`, plan: null };
}

async function openFile(): Promise<void> {
  try {
    const f = await platform.pickImageFile(fileInput);
    if (f) await loadFromFile(f);
  } catch (err) {
    toast(`열기 실패: ${String(err)}`);
  }
}

async function pasteFromClipboard(): Promise<void> {
  try {
    const blob = await platform.readClipboardImage();
    await loadBlob(blob, pastedSession());
  } catch (err) {
    toast(String(err));
  }
}

// Browser paste (also works in the webview when the OS clipboard holds an image).
window.addEventListener("paste", (e) => {
  if (e.target === textarea) return;
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) {
        e.preventDefault();
        void loadBlob(file, pastedSession());
        return;
      }
    }
  }
});

// HTML5 drag & drop (browser); Tauri delivers OS drops through its own event.
document.addEventListener("dragover", (e) => {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
});
document.addEventListener("drop", (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  if (!file.type.startsWith("image/") && !platform.isImageName(file.name)) {
    toast("이미지 파일이 아닙니다");
    return;
  }
  void (async () => loadFromFile({ bytes: await file.arrayBuffer(), name: file.name, path: null }))();
});
platform.onNativeFileDrop((paths) => {
  const path = paths.find(platform.isImageName);
  if (!path) {
    toast("이미지 파일이 아닙니다");
    return;
  }
  void (async () => {
    try {
      await loadFromFile(await platform.readFile(path));
    } catch (err) {
      toast(`열기 실패: ${String(err)}`);
    }
  })();
});

// ---------------------------------------------------------------- save & copy

async function save(): Promise<void> {
  if (!editor.hasImage || !session || !editor.original) {
    toast("먼저 사진을 불러오세요");
    return;
  }
  editor.finishEditing();
  const annotated = await toPng(editor.renderComposite());
  if (platform.isTauri) {
    if (!session.plan) {
      const chosen = await platform.askSavePath(`${session.name}_주석.png`);
      if (!chosen) return;
      const base = platform.stripExtension(chosen).replace(/_(주석|원본)$/u, "");
      session.plan = { annotated: `${base}_주석.png`, original: `${base}_원본.png`, originalWritten: false };
    }
    const plan = session.plan;
    try {
      await platform.writeFile(plan.annotated, annotated);
      if (plan.original && !plan.originalWritten) {
        await platform.writeFile(plan.original, await toPng(editor.original));
        plan.originalWritten = true;
      }
      toast(`저장됨: ${plan.annotated}`);
    } catch (err) {
      toast(`저장 실패: ${String(err)}`);
    }
    return;
  }
  platform.downloadBlob(annotated, `${session.name}_주석.png`);
  if (session.source === "pasted" && !session.plan) {
    platform.downloadBlob(await toPng(editor.original), `${session.name}_원본.png`);
    session.plan = { annotated: `${session.name}_주석.png`, original: null, originalWritten: true };
  }
  toast(`저장됨: ${session.name}_주석.png`);
}

async function copy(): Promise<void> {
  if (!editor.hasImage) {
    toast("먼저 사진을 불러오세요");
    return;
  }
  editor.finishEditing();
  try {
    await platform.writeClipboardImage(await toPng(editor.renderComposite()));
    toast("클립보드에 복사됨");
  } catch (err) {
    toast(`복사 실패: ${String(err)}`);
  }
}

// ---------------------------------------------------------------- keyboard

// WebView2 keeps the browser's own accelerators (reload, find, print, caret
// browsing, dev tools). A reload would silently throw away the photo and
// every annotation, so they are blocked at the page level.
const BLOCKED_KEYS = new Set(["F5", "F3", "F7", "F12"]);
const BLOCKED_CTRL_CODES = new Set(["KeyR", "KeyP", "KeyF"]);

window.addEventListener("keydown", (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  const ctrl = e.ctrlKey || e.metaKey;
  if (BLOCKED_KEYS.has(e.key) || (ctrl && BLOCKED_CTRL_CODES.has(e.code))) {
    e.preventDefault();
    return;
  }
  // These also work while typing in a text box; the box is closed first.
  if (ctrl && e.code === "KeyS") {
    e.preventDefault();
    void save();
    return;
  }
  if (ctrl && e.shiftKey && e.code === "KeyC") {
    e.preventDefault();
    void copy();
    return;
  }
  if (ctrl && e.code === "KeyO") {
    e.preventDefault();
    void openFile();
    return;
  }
  if (e.target === textarea) return;
  if (ctrl && e.code === "KeyZ" && !e.shiftKey) {
    e.preventDefault();
    editor.undo();
  } else if (ctrl && (e.code === "KeyY" || (e.code === "KeyZ" && e.shiftKey))) {
    e.preventDefault();
    editor.redo();
  } else if (ctrl && e.code === "KeyV") {
    if (platform.isTauri) {
      e.preventDefault();
      void pasteFromClipboard();
    }
  } else if (e.key === "Delete" || e.key === "Backspace") {
    if (editor.isPlacing) {
      e.preventDefault();
      editor.removeLastPolygonPoint();
    } else if (editor.selection) {
      e.preventDefault();
      editor.deleteSelected();
    }
  } else if (e.key === "Enter") {
    if (!editor.isPlacing && editor.selection) {
      e.preventDefault();
      editor.editSelected();
    }
  } else if (e.key === "Escape") {
    editor.escape();
  }
});

refreshToolbar();

// Exposed for the browser check script.
declare global {
  interface Window {
    __editor: Editor;
  }
}
window.__editor = editor;
