// 精灵加载：载入水彩素材 → 连通域抠图（吃掉背景渐变晕染）→ 居中裁剪。
// 素材在 assets/sprites/watercolor/01_tadpole.png ~ 10_red_dragon.png（SPEC 1.10）。
import { MAX_LEVEL } from '../core/constants.js';

const FILE_NAMES = [
  '01_tadpole',
  '02_frog',
  '03_lobster',
  '04_carp',
  '05_turtle',
  '06_crocodile',
  '07_shark',
  '08_whale',
  '09_blue_dragon',
  '10_red_dragon',
  '11_sea_monster',
];

export const FROG_SWIM_KEYS = [
  'frog_top_01_glide',
  'frog_top_02_compress',
  'frog_top_03_kick',
  'frog_top_04_extend',
  'frog_top_05_retract',
  'frog_top_06_settle',
];

export const TADPOLE_SWIM_KEYS = [
  'tadpole_01_glide',
  'tadpole_02_compress',
  'tadpole_03_push',
  'tadpole_04_extend',
  'tadpole_05_retract',
  'tadpole_06_settle',
];

export const CARP_SWIM_KEYS = [
  'carp_01_glide',
  'carp_02_compress',
  'carp_03_push',
  'carp_04_extend',
  'carp_05_retract',
  'carp_06_settle',
];

const SWIM_FRAME_SUFFIXES = [
  '01_glide',
  '02_compress',
  '03_push',
  '04_extend',
  '05_retract',
  '06_settle',
];

const makeSwimSet = (level, id) => ({
  level,
  id,
  dir: `${id}_swim_v1`,
  keyPrefix: `${id}_`,
  filePrefix: `${id}_swim`,
  keys: SWIM_FRAME_SUFFIXES.map((suffix) => `${id}_${suffix}`),
});

// 其余生物的俯视六帧序列。level 与 EVOLUTION / ANIM 下标一致。
export const CREATURE_SWIM_SETS = {
  2: makeSwimSet(2, 'lobster'),
  4: makeSwimSet(4, 'turtle'),
  5: makeSwimSet(5, 'crocodile'),
  6: makeSwimSet(6, 'shark'),
  7: makeSwimSet(7, 'whale'),
  8: makeSwimSet(8, 'blue_dragon'),
  9: makeSwimSet(9, 'red_dragon'),
  10: makeSwimSet(10, 'sea_monster'),
};

const FROG_SWIM_FILES = FROG_SWIM_KEYS.map((key) => `${key}.png`);

// 加载单张图片（onload 事件 + 超时兜底，比 img.decode() 可靠）
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const timer = setTimeout(() => reject(new Error(`图片加载超时: ${src}`)), 8000);
    img.onload = () => {
      clearTimeout(timer);
      resolve(img);
    };
    img.onerror = () => {
      clearTimeout(timer);
      reject(new Error(`图片加载失败: ${src}`));
    };
    img.src = src;
  });
}

// 连通域抠图：从四角 BFS，只吃掉"严格白色（>235）"的连续背景区域。
// 关键：不设色差扩散容差 —— 水彩墨晕（浅灰渐变 <235）停在边缘被保留，
// 主体内部浅色（眼睛高光 >235 但被非白像素包围、不连通角落）也完整保留。
function extractSprite(img) {
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const src = document.createElement('canvas');
  src.width = w;
  src.height = h;
  const ctx = src.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const image = ctx.getImageData(0, 0, w, h);
  const d = image.data;
  const N = w * h;

  // 严格白判定：背景候选
  const isBg = (i) => d[i * 4] > 235 && d[i * 4 + 1] > 235 && d[i * 4 + 2] > 235;

  const bg = new Uint8Array(N);
  const queue = new Int32Array(N);
  let qh = 0;
  let qt = 0;
  const enqueue = (i) => {
    if (!bg[i] && isBg(i)) {
      bg[i] = 1;
      queue[qt++] = i;
    }
  };
  // 四角种子（主体居中，角必在背景）
  enqueue(0);
  enqueue(w - 1);
  enqueue(N - w);
  enqueue(N - 1);

  while (qh < qt) {
    const i = queue[qh++];
    const x = i % w;
    if (i >= w) enqueue(i - w);
    if (i < N - w) enqueue(i + w);
    if (x > 0) enqueue(i - 1);
    if (x < w - 1) enqueue(i + 1);
  }

  // 背景置透明
  for (let i = 0; i < N; i++) {
    if (bg[i]) d[i * 4 + 3] = 0;
  }
  ctx.putImageData(image, 0, 0);

  // 计算非透明像素 bbox 并裁剪
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) {
    // 全透明（异常图）→ 整图兜底
    return {
      canvas: src,
      w,
      h,
      anchorX: w / 2,
      anchorY: h / 2,
    };
  }
  const cw = maxX - minX + 1;
  const ch = maxY - minY + 1;
  const out = document.createElement('canvas');
  out.width = cw;
  out.height = ch;
  out.getContext('2d').drawImage(src, minX, minY, cw, ch, 0, 0, cw, ch);
  return {
    canvas: out,
    w: cw,
    h: ch,
    // 保留原图中心在裁剪图中的位置。关键帧用同一锚点绘制时，躯干不会随四肢伸缩漂移。
    anchorX: w / 2 - minX,
    anchorY: h / 2 - minY,
  };
}

export async function loadSprites() {
  const sprites = new Map();
  await Promise.all(
    FILE_NAMES.slice(0, MAX_LEVEL).map(async (name, level) => {
      const img = await loadImage(`assets/sprites/watercolor/${name}.png`);
      const trimmed = extractSprite(img);
      sprites.set(level, trimmed);
    })
  );
  // 青蛙俯视游动关键帧：背部视角、统一朝右、统一 512×512 原始锚点。
  await Promise.all(
    FROG_SWIM_FILES.map(async (file, index) => {
      try {
        const img = await loadImage(`assets/sprites/watercolor/frog_jump_top_v1/${file}`);
        const trimmed = extractSprite(img);
        sprites.set(FROG_SWIM_KEYS[index], trimmed);
      } catch (e) {
        console.warn(`青蛙姿态图 ${file} 加载失败:`, e.message);
      }
    })
  );
  // 俯视关键帧：切割自 3×2 sprite sheet，锚点使用切割时记录的单元格中心。
  // 通用加载器让所有动物共享同一套命名、透明抠图和加载失败兜底规则。
  const SWIM_SETS = [
    {
      keys: TADPOLE_SWIM_KEYS,
      dir: 'tadpole_swim_v1',
      keyPrefix: 'tadpole_',
      filePrefix: 'tadpole_swim',
    },
    {
      keys: CARP_SWIM_KEYS,
      dir: 'carp_swim_v1',
      keyPrefix: 'carp_',
      filePrefix: 'carp_swim',
    },
    ...Object.values(CREATURE_SWIM_SETS),
  ];
  for (const { keys, dir, keyPrefix, filePrefix } of SWIM_SETS) {
    try {
      const anchorsRes = await fetch(`assets/sprites/watercolor/${dir}/anchors.json`);
      const anchors = await anchorsRes.json();
      const files = keys.map((key) => `${filePrefix}_${key.replace(keyPrefix, '')}.png`);
      await Promise.all(
        files.map(async (file, index) => {
          try {
            const img = await loadImage(`assets/sprites/watercolor/${dir}/${file}`);
            const trimmed = extractSprite(img);
            const a = anchors[keys[index].replace(keyPrefix, '')];
            if (a) {
              trimmed.anchorX = a.anchorX;
              trimmed.anchorY = a.anchorY;
            }
            sprites.set(keys[index], trimmed);
          } catch (e) {
            console.warn(`${dir} 姿态图 ${file} 加载失败:`, e.message);
          }
        })
      );
    } catch (e) {
      console.warn(`${dir} 锚点 JSON 加载失败（退化为默认锚点）:`, e.message);
    }
  }
  return sprites;
}
