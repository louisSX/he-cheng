// 一次性工具：切割蝌蚪 sprite sheet → 6 帧独立透明 PNG + 锚点 JSON
// 用法: node tools/cut_tadpole_sheet.mjs
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHEET = join(ROOT, 'assets/sprites/watercolor/tadpole_swim_sheet_v1.png');
const OUT_DIR = join(ROOT, 'assets/sprites/watercolor/tadpole_swim_v1');
mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage();
// file:// 会污染 canvas，用 http 同源加载
await page.goto('http://localhost:8080/assets/sprites/watercolor/tadpole_swim_sheet_v1.png');
const result = await page.evaluate(async () => {
  const src = location.href;
  const img = new Image();
  img.src = src;
  await new Promise((res) => (img.onload = res));
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const CW = Math.floor(W / 3); // 416
  const CH = Math.floor(H / 2); // 416

  const names = ['01_glide', '02_compress', '03_push', '04_extend', '05_retract', '06_settle'];
  const out = [];
  for (let i = 0; i < 6; i++) {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const sx = col * CW;
    const sy = row * CH;
    // 格子内中心（相对格子局部坐标）——锚点必须用局部坐标
    const cellCenterX = CW / 2;
    const cellCenterY = CH / 2;

    // 切格子
    const cell = document.createElement('canvas');
    cell.width = CW;
    cell.height = CH;
    cell.getContext('2d').drawImage(img, sx, sy, CW, CH, 0, 0, CW, CH);

    // 严格白 flood fill 抠图（与 sprites.js extractSprite 一致）
    const cctx = cell.getContext('2d');
    const image = cctx.getImageData(0, 0, CW, CH);
    const d = image.data;
    const isBg = (i) => d[i * 4] > 235 && d[i * 4 + 1] > 235 && d[i * 4 + 2] > 235;
    const bg = new Uint8Array(CW * CH);
    const q = new Int32Array(CW * CH);
    let qh = 0, qt = 0;
    const enq = (i) => { if (!bg[i] && isBg(i)) { bg[i] = 1; q[qt++] = i; } };
    enq(0); enq(CW - 1); enq(CW * CH - CW); enq(CW * CH - 1);
    while (qh < qt) {
      const i = q[qh++];
      const x = i % CW;
      if (i >= CW) enq(i - CW);
      if (i < CW * CH - CW) enq(i + CW);
      if (x > 0) enq(i - 1);
      if (x < CW - 1) enq(i + 1);
    }
    for (let i = 0; i < CW * CH; i++) if (bg[i]) d[i * 4 + 3] = 0;
    cctx.putImageData(image, 0, 0);

    // bbox
    let minX = CW, minY = CH, maxX = -1, maxY = -1;
    for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) {
      if (d[(y * CW + x) * 4 + 3] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX < 0) { out.push({ name: names[i], error: 'empty' }); continue; }
    const cw = maxX - minX + 1;
    const ch = maxY - minY + 1;
    const trimmed = document.createElement('canvas');
    trimmed.width = cw;
    trimmed.height = ch;
    trimmed.getContext('2d').drawImage(cell, minX, minY, cw, ch, 0, 0, cw, ch);
    out.push({
      name: names[i],
      dataUrl: trimmed.toDataURL('image/png'),
      w: cw,
      h: ch,
      // 锚点 = 原始单元格中心在裁剪图中的相对位置（防躯干漂移，SOP）
      anchorX: cellCenterX - minX,
      anchorY: cellCenterY - minY,
    });
  }
  return out;
});

for (const f of result) {
  if (f.error) { console.error(`${f.name}: ${f.error}`); continue; }
  writeFileSync(join(OUT_DIR, `tadpole_swim_${f.name}.png`), Buffer.from(f.dataUrl.split(',')[1], 'base64'));
  console.log(`${f.name}: ${f.w}x${f.h} anchor=(${f.anchorX.toFixed(1)}, ${f.anchorY.toFixed(1)})`);
}
const anchors = Object.fromEntries(result.filter((f) => !f.error).map((f) => [f.name, { w: f.w, h: f.h, anchorX: f.anchorX, anchorY: f.anchorY }]));
writeFileSync(join(OUT_DIR, 'anchors.json'), JSON.stringify(anchors, null, 2));
console.log('锚点 JSON 已写盘');
await browser.close();
