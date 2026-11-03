/**
 * Everything that differs between the Tauri shell (native dialogs, files at
 * arbitrary paths, the system clipboard) and a plain browser, where the app
 * falls back to downloads and the web clipboard API.
 */
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface LoadedFile {
  bytes: ArrayBuffer | Uint8Array;
  name: string;
  /** Absolute path when the file came from disk through Tauri. */
  path: string | null;
}

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "bmp", "gif", "webp"];

export function fileName(path: string): string {
  return path.split(/[\\/]/u).pop() ?? path;
}

export function stripExtension(path: string): string {
  return path.replace(/\.[^.\\/]+$/u, "");
}

export function isImageName(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTENSIONS.includes(ext);
}

export function mimeForName(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "bmp":
      return "image/bmp";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    default:
      return "image/png";
  }
}

export async function readFile(path: string): Promise<LoadedFile> {
  const bytes = await invoke<ArrayBuffer>("read_file", { path });
  return { bytes, name: fileName(path), path };
}

/** Open-file dialog; in the browser this uses the hidden file input. */
export async function pickImageFile(fileInput: HTMLInputElement): Promise<LoadedFile | null> {
  if (isTauri) {
    const path = await openDialog({
      multiple: false,
      directory: false,
      filters: [{ name: "이미지", extensions: IMAGE_EXTENSIONS }],
    });
    if (!path) return null;
    return readFile(path);
  }
  return new Promise((resolve) => {
    fileInput.value = "";
    fileInput.onchange = async () => {
      const f = fileInput.files?.[0];
      if (!f) return resolve(null);
      resolve({ bytes: await f.arrayBuffer(), name: f.name, path: null });
    };
    fileInput.oncancel = () => resolve(null);
    fileInput.click();
  });
}

export async function askSavePath(defaultName: string): Promise<string | null> {
  const path = await saveDialog({
    defaultPath: defaultName,
    filters: [{ name: "PNG", extensions: ["png"] }],
  });
  return path ?? null;
}

export async function writeFile(path: string, blob: Blob): Promise<void> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  await invoke("write_file", bytes, { headers: { "x-path": encodeURIComponent(path) } });
}

/** Tauri only: PNG bytes of the clipboard image, or an error when there is none. */
export async function readClipboardImage(): Promise<Blob> {
  const bytes = await invoke<ArrayBuffer>("clipboard_read_image");
  return new Blob([bytes], { type: "image/png" });
}

export async function writeClipboardImage(blob: Blob): Promise<void> {
  if (isTauri) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    await invoke("clipboard_write_image", bytes);
    return;
  }
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Tauri intercepts OS file drops itself; HTML5 drop events never fire there. */
export function onNativeFileDrop(cb: (paths: string[]) => void): void {
  if (!isTauri) return;
  void getCurrentWebview().onDragDropEvent((event) => {
    if (event.payload.type === "drop") cb(event.payload.paths);
  });
}
