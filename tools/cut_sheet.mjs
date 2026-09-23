// 通用 sprite sheet 切割工具：3×2 → 6 帧透明 PNG + 锚点 JSON（SOP 第三部分）
// 用法: node tools/cut_sheet.mjs <sheet文件名> <输出目录名> <帧名前缀>
// 例:   node tools/cut_sheet.mjs carp_swim_sheet_v1.png carp_swim_v1 carp_swim
// 输出（OUT_DIR 相对 assets/sprites/watercolor/）: <prefix>_01_glide.png ... 06_settle.png + anchors.json
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const [sheetName, outDirName, prefix] = process.argv.slice(2);
if (!sheetName || !outDirName || !prefix) {
  console.error('用法: node tools/cut_sheet.mjs <sheet文件名> <输出目录名> <帧名前缀>');
  process.exit(1);
}
const OUT_DIR = join(ROOT, 'assets/sprites/watercolor', outDirName);
mkdirSync(OUT_DIR, { recursive: true });

const NAMES = ['01_glide', '02_compress', '03_push', '04_extend', '05_retract', '06_settle'];

const browser = await chromium.launch();
const page = await browser.newPage();
// file:// 会污染 canvas，用 http 同源加载
await page.goto(`http://localhost:8080/assets/sprites/watercolor/${sheetName}`);

const result = await page.evaluate((names) => {
  const img = new Image();
  img.src = location.href;
  return new Promise((resolve) => {
    img.onload = () => resolve(processSheet(img, names));
    img.onerror = () => resolve({ error: `图片加载失败: ${img.src}` });
  });

  function processSheet(img, names) {
    const W = img.naturalWidth;
    const H = img.naturalHeight;
    const CW = Math.floor(W / 3);
    const CH = Math.floor(H / 2);
    const out = [];
    for (let i = 0; i < 6; i++) {
      const col = i % 3;
      const row = Math.floor(i / 3);
      const sx = col * CW;
      const sy = row * CH;
      const cellCenterX = CW / 2;
      const cellCenterY = CH / 2;

      const cell = document.createElement('canvas');
      cell.width = CW;
      cell.height = CH;
      cell.getContext('2d').drawImage(img, sx, sy, CW, CH, 0, 0, CW, CH);

      // 步骤1：先整体内缩 TRIM 像素，裁掉 sheet 边缘的浅灰网格线（RGB~177，非纯白）
      const TRIM = 6;
      const inner = document.createElement('canvas');
      inner.width = CW - TRIM * 2;
      inner.height = CH - TRIM * 2;
      inner.getContext('2d').drawImage(cell, TRIM, TRIM, CW - TRIM * 2, CH - TRIM * 2, 0, 0, CW - TRIM * 2, CH - TRIM * 2);
      const iw = inner.width;
      const ih = inner.height;

      // 步骤2：对干净内图做严格白 flood fill（四角现在必为纯白）
      const cctx = inner.getContext('2d');
      const image = cctx.getImageData(0, 0, iw, ih);
      const d = image.data;
      const isBg = (i) => d[i * 4] > 235 && d[i * 4 + 1] > 235 && d[i * 4 + 2] > 235;
      const bg = new Uint8Array(iw * ih);
      const q = new Int32Array(iw * ih);
      let qh = 0, qt = 0;
      const enq = (i) => { if (!bg[i] && isBg(i)) { bg[i] = 1; q[qt++] = i; } };
      enq(0); enq(iw - 1); enq(iw * ih - iw); enq(iw * ih - 1);
      while (qh < qt) {
        const i = q[qh++];
        const x = i % iw;
        if (i >= iw) enq(i - iw);
        if (i < iw * ih - iw) enq(i + iw);
        if (x > 0) enq(i - 1);
        if (x < iw - 1) enq(i + 1);
      }
      for (let i = 0; i < iw * ih; i++) if (bg[i]) d[i * 4 + 3] = 0;
      cctx.putImageData(image, 0, 0);

      let minX = iw, minY = ih, maxX = -1, maxY = -1;
      for (let y = 0; y < ih; y++) for (let x = 0; x < iw; x++) {
        if (d[(y * iw + x) * 4 + 3] > 0) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
      if (maxX < 0) { out.push({ name: names[i], error: 'empty' }); continue; }
      const pw = maxX - minX + 1;
      const ph = maxY - minY + 1;
      const trimmed = document.createElement('canvas');
      trimmed.width = pw;
      trimmed.height = ph;
      trimmed.getContext('2d').drawImage(inner, minX, minY, pw, ph, 0, 0, pw, ph);
      out.push({
        name: names[i],
        dataUrl: trimmed.toDataURL('image/png'),
        w: pw,
        h: ph,
        // 锚点 = 原单元格中心（含网格线内缩修正）在裁剪图中的位置
        anchorX: cellCenterX - TRIM - minX,
        anchorY: cellCenterY - TRIM - minY,
      });
    }
    return out;
  }
}, NAMES);

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
for (const f of result) {
  if (f.error) { console.error(`${f.name}: ${f.error}`); continue; }
  writeFileSync(join(OUT_DIR, `${prefix}_${f.name}.png`), Buffer.from(f.dataUrl.split(',')[1], 'base64'));
  console.log(`${prefix}_${f.name}: ${f.w}x${f.h} anchor=(${f.anchorX.toFixed(1)}, ${f.anchorY.toFixed(1)})`);
}
const anchors = Object.fromEntries(result.filter((f) => !f.error).map((f) => [f.name, { w: f.w, h: f.h, anchorX: f.anchorX, anchorY: f.anchorY }]));
writeFileSync(join(OUT_DIR, 'anchors.json'), JSON.stringify(anchors, null, 2));
console.log(`锚点 JSON 已写盘: ${outDirName}/anchors.json`);
await browser.close();
