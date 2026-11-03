/* eslint-disable no-console */
/**
 * Drives the built app (dist/) in headless Chromium and exercises every
 * feature that can be checked without a Windows shell: loading images
 * (open / drop / paste), drawing arrows, rects and text boxes, numbering,
 * selection, move / resize / delete, undo / redo, zoom, save and copy.
 *
 *   npm run build && npm run check:browser
 *
 * Screenshots and the exported PNG land in tests/output/.
 */
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "tests", "output");
const PORT = 4173;
const URL = `http://localhost:${PORT}/`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(url) {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error(`server did not start at ${url}`);
}

function pngSize(buf) {
  assert.equal(buf.toString("ascii", 1, 4), "PNG", "not a PNG file");
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

/** Builds a screenshot-like sample image inside the page and returns it as a File handle. */
function makeSampleFile(page, w, h, name) {
  return page.evaluateHandle(
    async ({ w, h, name }) => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const g = c.getContext("2d");
      const grad = g.createLinearGradient(0, 0, w, h);
      grad.addColorStop(0, "#1d3557");
      grad.addColorStop(0.5, "#f1faee");
      grad.addColorStop(1, "#e63946");
      g.fillStyle = grad;
      g.fillRect(0, 0, w, h);
      g.fillStyle = "#ffffff";
      g.fillRect(w * 0.1, h * 0.12, w * 0.8, h * 0.7);
      g.fillStyle = "#333";
      g.font = `${Math.round(h * 0.04)}px sans-serif`;
      g.fillText("설정 화면 (sample UI)", w * 0.13, h * 0.2);
      const colors = ["#4361ee", "#2a9d8f", "#e9c46a", "#f4a261"];
      for (let i = 0; i < 4; i++) {
        g.fillStyle = colors[i];
        g.fillRect(w * 0.13 + i * w * 0.19, h * 0.3, w * 0.16, h * 0.08);
        g.fillStyle = "#fff";
        g.fillText(`버튼 ${i + 1}`, w * 0.15 + i * w * 0.19, h * 0.355);
      }
      let seed = 7;
      const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
      for (let i = 0; i < 40; i++) {
        g.strokeStyle = `hsl(${i * 9},60%,50%)`;
        g.lineWidth = 3;
        g.beginPath();
        g.moveTo(rnd() * w, h * 0.5 + rnd() * h * 0.3);
        g.lineTo(rnd() * w, h * 0.5 + rnd() * h * 0.3);
        g.stroke();
      }
      const blob = await new Promise((r) => c.toBlob(r, "image/png"));
      return new File([blob], name, { type: "image/png" });
    },
    { w, h, name },
  );
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const server = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], {
    cwd: ROOT,
    stdio: "ignore",
  });
  const browser = await chromium.launch();
  const errors = [];
  try {
    await waitForServer(URL);
    const context = await browser.newContext({
      viewport: { width: 1280, height: 820 },
      deviceScaleFactor: 1,
      acceptDownloads: true,
      locale: "ko-KR",
    });
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: URL.slice(0, -1) });
    const page = await context.newPage();
    // Blob downloads report "download" as the suggested name in headless
    // Chromium, so record the anchor's download attribute instead.
    await page.addInitScript(() => {
      window.__downloadNames = [];
      const click = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        if (this.download) window.__downloadNames.push(this.download);
        return click.call(this);
      };
    });
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    const downloads = [];
    page.on("download", (d) => downloads.push(d));

    await page.goto(URL);
    await page.waitForFunction(() => Boolean(window.__editor));
    await page.screenshot({ path: path.join(OUT, "01-empty.png") });
    assert.equal(await page.isDisabled("#btn-arrow"), true, "tools disabled without image");

    const ed = (fn, arg) => page.evaluate(fn, arg);
    const state = () =>
      ed(() => {
        const e = window.__editor;
        return {
          hasImage: e.hasImage,
          imgW: e.imgW,
          imgH: e.imgH,
          tool: e.tool,
          scale: e.view.scale,
          viewX: e.view.x,
          selection: e.selection,
          editing: e.isEditing,
          canUndo: e.canUndo,
          canRedo: e.canRedo,
          annotations: e.doc.annotations,
        };
      });
    const stageRect = await ed(() => {
      const r = document.getElementById("stage").getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    });
    const toScreen = async (p) => {
      const s = await ed((p) => window.__editor.toScreen(p), p);
      return { x: s.x + stageRect.left, y: s.y + stageRect.top };
    };
    const drag = async (from, to, steps = 12) => {
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps });
      await page.mouse.up();
      // Konva redraws on the next animation frame; a person cannot click sooner.
      await sleep(40);
    };
    const dragImage = async (a, b) => drag(await toScreen(a), await toScreen(b));
    const labelBox = (id) =>
      ed((id) => {
        const v = window.__editor.views.get(id);
        return v.label.getBox();
      }, id);

    // ---- 1. open via the 열기 button (file chooser) -----------------------
    const sample1 = await makeSampleFile(page, 1600, 900, "photo.png");
    const sample1b64 = await page.evaluate(async (f) => {
      const buf = new Uint8Array(await f.arrayBuffer());
      let s = "";
      buf.forEach((b) => (s += String.fromCharCode(b)));
      return btoa(s);
    }, sample1);
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.click("#btn-open")]);
    await chooser.setFiles({ name: "photo.png", mimeType: "image/png", buffer: Buffer.from(sample1b64, "base64") });
    await page.waitForFunction(() => window.__editor.imgW === 1600);
    let st = await state();
    assert.equal(st.imgH, 900, "open: height");
    assert.ok(st.scale < 1 && st.scale > 0.5, `open: fitted scale ${st.scale}`);
    console.log("open via dialog: ok", st.imgW, "x", st.imgH, "scale", st.scale.toFixed(3));

    // ---- 2. drag & drop ------------------------------------------------
    const sample2 = await makeSampleFile(page, 1200, 1500, "dropped.png");
    const dt = await page.evaluateHandle((f) => {
      const d = new DataTransfer();
      d.items.add(f);
      return d;
    }, sample2);
    await page.dispatchEvent("#stage", "drop", { dataTransfer: dt });
    await page.waitForFunction(() => window.__editor.imgW === 1200 && window.__editor.imgH === 1500);
    st = await state();
    assert.ok(st.scale < 0.6, `drop: tall image fitted (${st.scale})`);
    console.log("drag&drop: ok");

    // ---- 3. paste (synthetic ClipboardEvent, and the real clipboard) ------
    const sample3 = await makeSampleFile(page, 1920, 1080, "capture.png");
    await page.evaluate((f) => {
      const d = new DataTransfer();
      d.items.add(f);
      document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: d, bubbles: true, cancelable: true }));
    }, sample3);
    await page.waitForFunction(() => window.__editor.imgW === 1920);
    console.log("paste (synthetic event): ok");

    const sample4 = await makeSampleFile(page, 1000, 700, "capture2.png");
    await page.evaluate(async (f) => {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": f })]);
    }, sample4);
    await page.keyboard.press("Control+V");
    const realPaste = await page
      .waitForFunction(() => window.__editor.imgW === 1000, null, { timeout: 4000 })
      .then(() => true)
      .catch(() => false);
    console.log("paste (real clipboard + Ctrl+V):", realPaste ? "ok" : "not available in headless");
    // Final working image: 1920x1080 pasted capture.
    await page.evaluate((f) => {
      const d = new DataTransfer();
      d.items.add(f);
      document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: d, bubbles: true, cancelable: true }));
    }, sample3);
    await page.waitForFunction(() => window.__editor.imgW === 1920);
    st = await state();
    const fitScale = st.scale;

    // ---- 4. arrow -------------------------------------------------------
    await page.click("#btn-arrow");
    await dragImage({ x: 300, y: 720 }, { x: 420, y: 350 });
    await page.waitForSelector("#text-editor", { state: "visible" });
    assert.equal(await ed(() => document.activeElement && document.activeElement.id), "text-editor", "arrow: textarea focused");
    await page.keyboard.type("이 버튼 색을 파란색으로");
    await page.screenshot({ path: path.join(OUT, "02-editing.png") });
    await page.keyboard.press("Escape");
    st = await state();
    assert.equal(st.annotations.length, 1);
    assert.equal(st.annotations[0].kind, "arrow");
    assert.equal(st.annotations[0].label.text, "이 버튼 색을 파란색으로");
    assert.deepEqual([Math.round(st.annotations[0].tip.x), Math.round(st.annotations[0].tip.y)], [420, 350], "arrow tip at drag end");
    assert.equal(st.editing, false);
    assert.equal(st.canUndo, true);
    const arrow1 = st.annotations[0].id;
    console.log("arrow: ok");

    // ---- 5. rect --------------------------------------------------------
    await page.click("#btn-rect");
    await dragImage({ x: 1100, y: 310 }, { x: 1480, y: 430 });
    await page.waitForSelector("#text-editor", { state: "visible" });
    await page.keyboard.type("이 영역은 왼쪽 정렬");
    await page.keyboard.press("Escape");
    st = await state();
    assert.equal(st.annotations.length, 2);
    const rect = st.annotations[1];
    assert.equal(rect.kind, "rect");
    assert.deepEqual([rect.x, rect.y, rect.w, rect.h].map(Math.round), [1100, 310, 380, 120]);
    assert.ok(rect.label.x >= rect.x + rect.w, "rect label placed outside, to the right");
    console.log("rect: ok");

    // ---- 6. text box ----------------------------------------------------
    await page.click("#btn-text");
    const tp = await toScreen({ x: 1250, y: 880 });
    await page.mouse.click(tp.x, tp.y);
    await page.waitForSelector("#text-editor", { state: "visible" });
    await page.keyboard.type("전체 여백 줄이기");
    await page.keyboard.press("Escape");
    st = await state();
    assert.equal(st.annotations.length, 3);
    assert.equal(st.annotations[2].kind, "text");
    assert.equal(st.annotations[2].label.text, "전체 여백 줄이기");
    const textId = st.annotations[2].id;
    // An empty text box must vanish again.
    const tp2 = await toScreen({ x: 600, y: 950 });
    await page.mouse.click(tp2.x, tp2.y);
    await page.waitForSelector("#text-editor", { state: "visible" });
    await page.keyboard.press("Escape");
    st = await state();
    assert.equal(st.annotations.length, 3, "empty text box discarded");
    console.log("text box: ok");

    // ---- 7. second arrow + numbering -------------------------------------
    await page.click("#btn-arrow");
    await dragImage({ x: 1500, y: 820 }, { x: 1660, y: 590 });
    await page.waitForSelector("#text-editor", { state: "visible" });
    await page.keyboard.type("여기도 확인");
    await page.keyboard.press("Escape");
    st = await state();
    assert.equal(st.annotations.length, 4);
    const arrow2 = st.annotations[3].id;
    const numbers = () =>
      ed(() => {
        const e = window.__editor;
        const out = {};
        let n = 0;
        for (const a of e.doc.annotations) if (a.kind !== "text") out[a.id] = ++n;
        return out;
      });
    let nums = await numbers();
    assert.deepEqual([nums[arrow1], nums[rect.id], nums[arrow2]], [1, 2, 3]);
    console.log("numbering: ok");

    // ---- 7b. polygon: click points, Backspace, pan while placing, close on first point ----
    await page.click("#btn-polygon");
    const poly = [
      { x: 200, y: 250 },
      { x: 520, y: 230 },
      { x: 600, y: 420 },
      { x: 380, y: 520 },
      { x: 180, y: 430 },
    ];
    const clickImage = async (p) => {
      const sp = await toScreen(p);
      await page.mouse.click(sp.x, sp.y);
      await sleep(30);
    };
    const placedCount = () => ed(() => (window.__editor.placing ? window.__editor.placing.points.length : 0));
    for (const p of poly) await clickImage(p);
    assert.equal(await placedCount(), 5, "five points placed");
    await clickImage(poly[4]);
    assert.equal(await placedCount(), 5, "click on the previous point is ignored");
    await page.keyboard.press("Backspace");
    assert.equal(await placedCount(), 4, "Backspace drops the last point");
    await clickImage(poly[4]);
    assert.equal(await placedCount(), 5);
    const vx0 = (await state()).viewX;
    const panFrom = await toScreen({ x: 900, y: 150 });
    await drag(panFrom, { x: panFrom.x + 50, y: panFrom.y });
    st = await state();
    assert.ok(Math.abs(st.viewX - (vx0 + 50)) < 2, "dragging pans while placing");
    assert.equal(await placedCount(), 5, "a pan adds no point");
    await drag({ x: panFrom.x + 50, y: panFrom.y }, panFrom);
    await ed(() => window.__editor.renderComposite());
    assert.equal(await ed(() => window.__editor.isPlacing), true, "export keeps the polygon in progress");
    await page.screenshot({ path: path.join(OUT, "03b-polygon-placing.png") });
    await clickImage(poly[0]);
    await page.waitForSelector("#text-editor", { state: "visible" });
    await page.keyboard.type("이 부분은 잘라내기");
    await page.keyboard.press("Escape");
    st = await state();
    assert.equal(st.annotations.length, 5);
    const polyAnn = st.annotations[4];
    assert.equal(polyAnn.kind, "polygon");
    // Mouse positions are whole screen pixels, so allow ~1 screen pixel of error.
    polyAnn.points.forEach((p, i) => {
      assert.ok(Math.abs(p.x - poly[i].x) < 2 && Math.abs(p.y - poly[i].y) < 2, `corner ${i} is where it was clicked`);
    });
    assert.equal(polyAnn.label.text, "이 부분은 잘라내기");
    const polyId = polyAnn.id;
    nums = await numbers();
    assert.deepEqual([nums[arrow1], nums[rect.id], nums[arrow2], nums[polyId]], [1, 2, 3, 4]);
    // Fewer than three points cannot close; Esc and a tool switch discard the outline.
    await clickImage({ x: 900, y: 150 });
    await clickImage({ x: 950, y: 200 });
    await clickImage({ x: 900, y: 150 });
    assert.equal(await placedCount(), 2, "closing needs three points");
    await page.keyboard.press("Escape");
    assert.equal(await ed(() => window.__editor.isPlacing), false, "Esc discards");
    await clickImage({ x: 900, y: 150 });
    await clickImage({ x: 950, y: 200 });
    await clickImage({ x: 900, y: 220 });
    await page.click("#btn-select");
    assert.equal(await ed(() => window.__editor.isPlacing), false, "tool switch discards");
    st = await state();
    assert.equal(st.annotations.length, 5, "discarded outlines add nothing");
    await page.screenshot({ path: path.join(OUT, "03-annotated.png") });
    console.log("polygon: ok");

    // ---- 8. select + delete renumbers --------------------------------------
    const a1 = st.annotations[0];
    const box1 = await labelBox(arrow1);
    const mid = {
      x: (box1.x + box1.w / 2 + a1.tip.x) / 2,
      y: (box1.y + box1.h / 2 + a1.tip.y) / 2,
    };
    const midS = await toScreen(mid);
    await page.mouse.click(midS.x, midS.y);
    st = await state();
    assert.deepEqual(st.selection, { id: arrow1, part: "shape" }, "clicking the shaft selects the arrow");
    await page.screenshot({ path: path.join(OUT, "04-selected-arrow.png") });
    await page.keyboard.press("Delete");
    st = await state();
    assert.equal(st.annotations.length, 4);
    nums = await numbers();
    assert.deepEqual([nums[rect.id], nums[arrow2], nums[polyId]], [1, 2, 3], "renumbered after delete");
    console.log("delete + renumber: ok");

    // ---- 9. undo / redo ---------------------------------------------------
    await page.keyboard.press("Control+Z");
    st = await state();
    assert.equal(st.annotations.length, 5, "undo restores the arrow");
    assert.equal(st.canRedo, true);
    await page.keyboard.press("Control+Y");
    st = await state();
    assert.equal(st.annotations.length, 4, "redo deletes again");
    await page.click("#btn-undo");
    st = await state();
    assert.equal(st.annotations.length, 5, "undo button");
    nums = await numbers();
    assert.deepEqual([nums[arrow1], nums[rect.id], nums[arrow2], nums[polyId]], [1, 2, 3, 4]);
    console.log("undo/redo: ok");

    // ---- 10. move a label (connector follows) ---------------------------------
    const rbox = await labelBox(rect.id);
    const from = await toScreen({ x: rbox.x + rbox.w / 2, y: rbox.y + rbox.h / 2 });
    const to = await toScreen({ x: rbox.x + rbox.w / 2 - 400, y: rbox.y + rbox.h / 2 + 220 });
    await drag(from, to);
    st = await state();
    const movedRect = st.annotations.find((a) => a.id === rect.id);
    assert.ok(Math.abs(movedRect.label.x - (rbox.x - 400)) < 2, `label moved x ${rbox.x} -> ${movedRect.label.x}`);
    assert.ok(Math.abs(movedRect.label.y - (rbox.y + 220)) < 2, `label moved y ${rbox.y} -> ${movedRect.label.y}`);
    assert.deepEqual([movedRect.x, movedRect.y].map(Math.round), [1100, 310], "rect itself did not move");
    assert.deepEqual(st.selection, { id: rect.id, part: "label" });
    console.log("move label: ok");

    // ---- 11. move whole rect by its edge, then resize via transformer ------------
    const edge = await toScreen({ x: 1100 + 190, y: 310 });
    await drag(edge, { x: edge.x - 40, y: edge.y + 30 });
    st = await state();
    let r2 = st.annotations.find((a) => a.id === rect.id);
    assert.ok(Math.abs(r2.x - (1100 - 40 / fitScale)) < 2, "rect moved x");
    assert.ok(Math.abs(r2.label.x - (movedRect.label.x - 40 / fitScale)) < 2, "label followed rect");
    assert.deepEqual(st.selection, { id: rect.id, part: "shape" });
    const br = await toScreen({ x: r2.x + r2.w, y: r2.y + r2.h });
    await page.screenshot({ path: path.join(OUT, "05-selected-rect.png") });
    await drag(br, { x: br.x + 60, y: br.y + 40 });
    st = await state();
    const r3 = st.annotations.find((a) => a.id === rect.id);
    assert.ok(Math.abs(r3.w - (r2.w + 60 / fitScale)) < 2, `rect resized w ${r2.w} -> ${r3.w}`);
    assert.ok(Math.abs(r3.h - (r2.h + 40 / fitScale)) < 2, `rect resized h ${r2.h} -> ${r3.h}`);
    console.log("move/resize rect: ok");

    // ---- 12. drag the arrow tip ------------------------------------------------
    const a2 = st.annotations.find((a) => a.id === arrow2);
    const box2 = await labelBox(arrow2);
    const mid2 = await toScreen({
      x: (box2.x + box2.w / 2 + a2.tip.x) / 2,
      y: (box2.y + box2.h / 2 + a2.tip.y) / 2,
    });
    await page.mouse.click(mid2.x, mid2.y);
    st = await state();
    if (process.env.DEBUG_CHECK) {
      console.log("DEBUG arrow2", JSON.stringify(a2), "box", JSON.stringify(box2), "mid2", JSON.stringify(mid2), "sel", JSON.stringify(st.selection));
      await page.screenshot({ path: path.join(OUT, "debug-step12.png") });
    }
    assert.deepEqual(st.selection, { id: arrow2, part: "shape" });
    const tipS = await toScreen(a2.tip);
    await drag(tipS, { x: tipS.x - 80, y: tipS.y - 50 });
    st = await state();
    const a2b = st.annotations.find((a) => a.id === arrow2);
    assert.ok(Math.abs(a2b.tip.x - (a2.tip.x - 80 / fitScale)) < 2, "tip moved x");
    assert.ok(Math.abs(a2b.tip.y - (a2.tip.y - 50 / fitScale)) < 2, "tip moved y");
    console.log("arrow tip handle: ok");

    // ---- 12b. polygon: select by an edge, drag a corner handle, move the whole outline ----
    const edgeMid = await toScreen({ x: 360, y: 240 });
    await page.mouse.click(edgeMid.x, edgeMid.y);
    st = await state();
    assert.deepEqual(st.selection, { id: polyId, part: "shape" }, "clicking an edge selects the polygon");
    await page.screenshot({ path: path.join(OUT, "05b-selected-polygon.png") });
    const v2 = await toScreen({ x: 600, y: 420 });
    await drag(v2, { x: v2.x + 40, y: v2.y + 30 });
    st = await state();
    const pg = st.annotations.find((a) => a.id === polyId);
    assert.ok(Math.abs(pg.points[2].x - (600 + 40 / fitScale)) < 2, "corner dragged x");
    assert.ok(Math.abs(pg.points[2].y - (420 + 30 / fitScale)) < 2, "corner dragged y");
    assert.deepEqual([Math.round(pg.points[0].x), Math.round(pg.points[0].y)], [200, 250], "other corners untouched");
    const edge2 = await toScreen({ x: 360, y: 240 });
    await drag(edge2, { x: edge2.x + 30, y: edge2.y + 20 });
    st = await state();
    const pg2 = st.annotations.find((a) => a.id === polyId);
    assert.ok(Math.abs(pg2.points[0].x - (pg.points[0].x + 30 / fitScale)) < 2, "polygon moved");
    assert.ok(Math.abs(pg2.label.x - (pg.label.x + 30 / fitScale)) < 2, "polygon label followed");
    await page.keyboard.press("Control+Z");
    st = await state();
    assert.deepEqual(
      st.annotations.find((a) => a.id === polyId).points.map((p) => Math.round(p.x)),
      pg.points.map((p) => Math.round(p.x)),
      "undo reverts the move",
    );
    console.log("polygon edit: ok");

    // ---- 13. double-click to edit, Enter for a new line ----------------------------
    const tbox = await labelBox(textId);
    const tc = await toScreen({ x: tbox.x + tbox.w / 2, y: tbox.y + tbox.h / 2 });
    await page.mouse.dblclick(tc.x, tc.y);
    await page.waitForSelector("#text-editor", { state: "visible" });
    assert.equal(await page.inputValue("#text-editor"), "전체 여백 줄이기");
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("글자 크기는 유지");
    await page.keyboard.press("Escape");
    st = await state();
    assert.equal(st.annotations.find((a) => a.id === textId).label.text, "전체 여백 줄이기\n글자 크기는 유지");
    console.log("double-click edit + newline: ok");

    // ---- 14. zoom with the wheel, pan by dragging empty space --------------------------
    const center = { x: stageRect.left + stageRect.width / 2, y: stageRect.top + stageRect.height / 2 };
    await page.mouse.move(center.x, center.y);
    await page.mouse.wheel(0, -300);
    await sleep(100);
    st = await state();
    assert.ok(st.scale > fitScale * 1.2, `zoomed in: ${fitScale} -> ${st.scale}`);
    await page.screenshot({ path: path.join(OUT, "06-zoomed.png") });
    const vx = st.viewX;
    const empty = await toScreen({ x: 1500, y: 150 });
    await drag(empty, { x: empty.x - 120, y: empty.y + 10 });
    st = await state();
    assert.ok(Math.abs(st.viewX - (vx - 120)) < 2, "panned");
    assert.equal(st.selection, null, "clicking empty space deselects");
    await page.mouse.wheel(0, 300);
    await sleep(100);
    console.log("zoom/pan: ok");

    // ---- 15. save (browser fallback: downloads) -------------------------------------
    await page.keyboard.press("Control+S");
    for (let i = 0; i < 50 && downloads.length < 2; i++) await sleep(100);
    assert.equal(downloads.length, 2, "pasted image saves annotated + original");
    const names = (await ed(() => window.__downloadNames)).slice().sort();
    assert.ok(names[0].endsWith("_원본.png") && names[1].endsWith("_주석.png"), `download names ${names}`);
    for (const [i, d] of downloads.entries()) {
      const target = path.join(OUT, i === 0 ? "saved-annotated.png" : "saved-original.png");
      await d.saveAs(target);
      const size = pngSize(fs.readFileSync(target));
      assert.deepEqual(size, { w: 1920, h: 1080 }, "saved PNG keeps original resolution");
    }
    console.log("save: ok ->", names.join(", "));

    // ---- 16. copy to clipboard ---------------------------------------------------------
    await page.click("#btn-copy");
    await page.waitForFunction(() => document.getElementById("toast").textContent.includes("복사"));
    const clip = await ed(async () => {
      const items = await navigator.clipboard.read();
      const item = items[0];
      const blob = await item.getType("image/png");
      const bmp = await createImageBitmap(blob);
      return { types: item.types, w: bmp.width, h: bmp.height };
    });
    assert.ok(clip.types.includes("image/png"));
    assert.deepEqual([clip.w, clip.h], [1920, 1080], "clipboard image at original resolution");
    console.log("copy: ok");

    await page.screenshot({ path: path.join(OUT, "07-final.png") });
    assert.deepEqual(errors, [], "no page errors");
    console.log("\nALL CHECKS PASSED");
  } finally {
    await browser.close();
    server.kill();
  }
}

main().catch((err) => {
  console.error("\nCHECK FAILED:", err);
  process.exit(1);
});
