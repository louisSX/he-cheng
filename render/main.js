// 渲染层入口（SPEC Part 2.1）：只读 core 状态 + 绘制，不写游戏逻辑。
import { Game } from '../core/game.js';
import { CONFIG, EVOLUTION, GAIT } from '../core/constants.js';
import { createCamera } from './camera.js';
import { createInput } from './input.js';
import {
  CARP_SWIM_KEYS,
  CREATURE_SWIM_SETS,
  FROG_SWIM_KEYS,
  TADPOLE_SWIM_KEYS,
  loadSprites,
} from './sprites.js';

const BEST_KEY = 'he_cheng_best_score';
const FIXED_DT = CONFIG.fixedDt;
const UNIFORM_R = CONFIG.visualRadius; // 所有生物统一视觉半径（直径 48px）：与碰撞判定共用同一常量（SPEC 2.1）

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const hudLevel = document.getElementById('hud-level');
const hudProgress = document.getElementById('hud-progress');
const hudScore = document.getElementById('hud-score');
const hudTime = document.getElementById('hud-time');
const deathOverlay = document.getElementById('death-overlay');
const deathStats = document.getElementById('death-stats');
const restartBtn = document.getElementById('restart-btn');
const continueBtn = document.getElementById('continue-btn');
const pauseOverlay = document.getElementById('pause-overlay');
const minimapCanvas = document.getElementById('minimap');
const minimapCtx = minimapCanvas.getContext('2d');

const MINIMAP_W = 190;
const MINIMAP_H = 190;
minimapCanvas.width = MINIMAP_W;
minimapCanvas.height = MINIMAP_H;

let paused = false; // ESC 暂停（SPEC：暂停时模拟冻结，仅显示遮罩）

let viewW = 0;
let viewH = 0;
function resize() {
  viewW = window.innerWidth;
  viewH = window.innerHeight;
  canvas.width = viewW;
  canvas.height = viewH;
}
window.addEventListener('resize', resize);
resize();

// ESC 暂停切换
window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && game && !game.gameOver) {
    paused = !paused;
    pauseOverlay.classList.toggle('hidden', !paused);
    last = performance.now(); // 暂停不计入真实时间
  }
});

const camera = createCamera(viewW, viewH);
window.__camera = camera; // 调试/自动化验证用（与 __game 并列）
const input = createInput(canvas);

// 背景浮游生物（固定种子 → 世界坐标稳定，不随帧随机）
const plankton = [];
{
  let s = 42;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  for (let i = 0; i < 140; i++) {
    plankton.push({
      x: rnd() * CONFIG.worldWidth,
      y: rnd() * CONFIG.worldHeight,
      r: 2 + rnd() * 6,
      a: 0.05 + rnd() * 0.1,
    });
  }
}

// 进化粒子特效
const particles = [];
let evolveFx = null; // {t: 0..1}
let prevLevel = 0;
let game = null;
let bestScore = Number(localStorage.getItem(BEST_KEY) || 0);
let over = false;
let prevSnap = null; // 插值起点（上一次模拟步进前的状态）
let curSnap = null;  // 插值终点（最新模拟状态）

function newGame() {
  game = new Game((Date.now() & 0xffffffff) >>> 0);
  window.__game = game; // 调试/自动化验证用
  prevLevel = 0;
  over = false;
  particles.length = 0;
  evolveFx = null;
  prevSnap = null;
  curSnap = null;
  continueBtn.classList.add('hidden');
  deathOverlay.classList.add('hidden');
}

restartBtn.addEventListener('click', newGame);
continueBtn.addEventListener('click', () => {
  if (game && game.gameOver) {
    game.revive();
    over = false;
    prevSnap = null;
    curSnap = game.snapshot();
    lastStepTime = performance.now();
    deathOverlay.classList.add('hidden');
  }
});

// —— 绘制 ——
function drawBackground() {
  const g = ctx.createLinearGradient(0, -CONFIG.worldHeight, 0, 0);
  g.addColorStop(0, '#14607f');
  g.addColorStop(1, '#1e7fa6');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, CONFIG.worldWidth, CONFIG.worldHeight);

  ctx.fillStyle = 'rgba(220, 245, 255, 0.9)';
  for (const p of plankton) {
    ctx.globalAlpha = p.a;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // 世界边界
  ctx.strokeStyle = 'rgba(255, 240, 180, 0.55)';
  ctx.lineWidth = 4;
  ctx.strokeRect(0, 0, CONFIG.worldWidth, CONFIG.worldHeight);
}

// 生物动画类型配置（按 level）：每种生物有符合物种的游动姿态（用户需求 2026-08-06）
// 新素材统一使用严格俯视六帧；fallback 仅在对应序列加载失败时启用旧单图动画。
// freq 统一取自 core GAIT（划水节奏同时驱动真实速度起伏，SPEC 2.1 禁止双常量）；
// 真实加减速已由 core 步态承担，surge 只保留轻微视觉前冲。
// bend：转弯时身体弯曲程度（0 = 硬壳/四肢型不弯）。
const ANIM = [
  { type: 'tadpole-swim', surge: 0.05, yaw: 0.018, bend: 1.0 },         // 0 蝌蚪：快速双侧摆尾，身体只做轻微反向偏航
  { type: 'frog-swim', surge: 0.10, bend: 0 },                            // 1 青蛙：六帧俯视蛙泳
  { type: 'keyframe-swim', motion: 'limb', surge: 0.06, yaw: 0.006, extent: 1.95, bend: 0, fallback: 'sway', rock: 0.12, bob: 0.05, squash: 0.12 }, // 2 龙虾
  { type: 'carp-swim', surge: 0.04, yaw: 0.012, bend: 0.8 },             // 3 鲤鱼：稳定躯干、低频双侧摆尾
  { type: 'keyframe-swim', motion: 'limb', surge: 0.04, yaw: 0.004, extent: 1.95, bend: 0, fallback: 'sway', rock: 0.07, bob: 0.08, squash: 0.03 }, // 4 乌龟
  { type: 'keyframe-swim', motion: 'lateral', surge: 0.03, yaw: 0.016, extent: 2.05, bend: 0.6, fallback: 'wave', tailAmp: 0.85 }, // 5 鳄鱼
  { type: 'keyframe-swim', motion: 'lateral', surge: 0.04, yaw: 0.010, extent: 2.00, bend: 0.7, fallback: 'wave', tailAmp: 1.25 }, // 6 鲨鱼
  { type: 'keyframe-swim', motion: 'axial', surge: 0.03, yaw: 0.003, extent: 2.00, bend: 0.3, fallback: 'pitch', bob: 0.12, pitch: 0.08 }, // 7 鲸鱼
  { type: 'keyframe-swim', motion: 'serpentine', surge: 0.03, yaw: 0.010, extent: 2.10, bend: 1.2, fallback: 'wave', tailAmp: 1.35 }, // 8 青龙
  { type: 'keyframe-swim', motion: 'serpentine', surge: 0.03, yaw: 0.008, extent: 2.10, bend: 1.2, fallback: 'wave', tailAmp: 1.45 }, // 9 红龙
  { type: 'keyframe-swim', motion: 'tentacle', surge: 0.03, yaw: 0.006, extent: 2.05, bend: 0.3, fallback: 'wave', tailAmp: 1.1, bob: 0.10 }, // 10 深海巨兽
].map((a, level) => ({ ...a, freq: GAIT[level].freq }));

// —— 转弯弯身 ——
const TAU = Math.PI * 2;
const wrapAngle = (d) => d - TAU * Math.floor((d + Math.PI) / TAU);
const lerpAngle = (a, b, t) => a + wrapAngle(b - a) * t;

// 每个实体的平滑弯曲量（按 id 保存，每帧重建以清理已消失的生物）
let bendState = new Map();
let nextBendState = new Map();
function bodyBend(key, prevHeading, curHeading, level, maxTurnDeg, dt) {
  const k = ANIM[level]?.bend ?? 0;
  const prev = bendState.get(key) ?? 0;
  let target = 0;
  if (k > 0) {
    // 本 tick 实际转向角 / 该物种最大转向角 → -1..1（冲刺掉头时封顶）
    const w = wrapAngle(curHeading - prevHeading) / (maxTurnDeg * Math.PI / 180);
    target = Math.max(-1, Math.min(1, w)) * k;
  }
  const next = prev + (target - prev) * Math.min(1, dt * 10);
  nextBendState.set(key, next);
  return next;
}

// 在“头朝上”素材的局部坐标内绘制一帧。bend≠0 时沿身体长轴切成横条，
// 按到锚点距离的平方做横向偏移 → 身体弯成弧线（头尾都偏向弯道内侧）。
// 横向平移横条不会产生缝隙，比分段旋转更稳定。
const BEND_STRIPS = 14;
const BEND_MAX = 0.22; // 最大端点偏移 = 半身长 × 该比例
function blitFrame(frame, scale, alpha, mirror, bend) {
  const ax = frame.anchorX ?? frame.w / 2;
  const ay = frame.anchorY ?? frame.h / 2;
  ctx.save();
  if (mirror) ctx.scale(-1, 1);
  ctx.globalAlpha *= alpha;
  if (Math.abs(bend) < 0.01) {
    ctx.drawImage(frame.canvas, -ax * scale, -ay * scale, frame.w * scale, frame.h * scale);
  } else {
    // 镜像后局部 x 反向，偏移符号随之翻转，保证弯向与转向一致
    const half = Math.max(ay, frame.h - ay);
    const maxOff = half * scale * BEND_MAX * bend * (mirror ? -1 : 1);
    const stripH = frame.h / BEND_STRIPS;
    for (let i = 0; i < BEND_STRIPS; i++) {
      const sy = i * stripH;
      const sh = Math.min(stripH + 1, frame.h - sy); // 多取 1px 防接缝
      const u = (sy + stripH / 2 - ay) / half;
      ctx.drawImage(
        frame.canvas,
        0, sy, frame.w, sh,
        -ax * scale + maxOff * u * u, (sy - ay) * scale, frame.w * scale, sh * scale
      );
    }
  }
  ctx.restore();
}

function drawCreature(spr, x, y, radius, heading, animPhase, isPlayer, isThreat, level, bend = 0, lunge = 0) {
  const visualR = UNIFORM_R; // 所有生物统一视觉尺寸
  const fit = (visualR * 2) / Math.max(spr.w, spr.h);

  // 浅色圆形衬底：深色生物在海底背景上立刻醒目（可读性关键）
  ctx.beginPath();
  ctx.arc(x, y, visualR * 1.18, 0, Math.PI * 2);
  ctx.fillStyle = isPlayer ? 'rgba(255, 248, 215, 0.5)' : 'rgba(205, 240, 255, 0.3)';
  ctx.fill();

  // 扑击预警：蓄势期红圈快速脉动（给玩家 0.2s 反应窗口），猛冲期保留淡红圈
  if (lunge === 1 || lunge === 2) {
    const pulse = lunge === 1 ? 0.6 + 0.4 * Math.sin(performance.now() / 40) : 0.35;
    ctx.beginPath();
    ctx.arc(x, y, visualR * 1.3, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255, 50, 50, ${pulse})`;
    ctx.lineWidth = lunge === 1 ? 4 : 2.5;
    ctx.stroke();
  }

  // 捕食者标记：比玩家大的生物头顶红色三角（尺寸统一后靠标记识别天敌）
  if (isThreat) {
    ctx.beginPath();
    ctx.moveTo(x, y - visualR * 1.6);
    ctx.lineTo(x - 8, y - visualR * 2.0);
    ctx.lineTo(x + 8, y - visualR * 2.0);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255, 60, 60, 0.9)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // 朝向基角：朝左时水平翻转保持正立
  const flip = Math.cos(heading) < 0 ? -1 : 1;
  const base = Math.atan2(Math.sin(heading), Math.cos(heading) * flip);
  const a = ANIM[level] || ANIM[0];

  // 关键帧动物的四肢/触手可能越过进度环；先画环，避免圆环压住轮廓。
  const progressBehind = isPlayer && (a.type === 'frog-swim' || a.type === 'keyframe-swim');
  if (progressBehind) drawProgressRing(x, y, visualR, 0);

  if (a.type === 'wave') drawWaveBody(spr, x, y, visualR, flip, base, animPhase, a);
  else if (a.type === 'frog-swim') drawFrogSwim(spr, x, y, visualR, heading, animPhase, a);
  else if (a.type === 'tadpole-swim') drawTadpoleSwim(spr, x, y, visualR, heading, animPhase, a, bend);
  else if (a.type === 'carp-swim') drawCarpSwim(spr, x, y, visualR, heading, animPhase, a, bend);
  else if (a.type === 'keyframe-swim') {
    drawCreatureKeyframes(spr, x, y, visualR, heading, animPhase, a, level, flip, base, fit, bend);
  }
  else if (a.type === 'pitch') drawPitch(spr, x, y, visualR, flip, base, animPhase, a, fit);
  else drawSway(spr, x, y, visualR, flip, base, animPhase, a, fit);

  if (isPlayer && !progressBehind) drawProgressRing(x, y, visualR, 0);
}

// 分段 S 形游动（鱼/龙/鳄/海怪）：精灵沿长轴切 3 段，各段错相旋转 → 波浪扭动。
// 横构图（鱼/鳄/鲨）：尾段摆动大、头段小（鱼尾驱动）；竖构图（龙）：波浪沿身传递。
function drawWaveBody(spr, x, y, size, flip, base, phase, a) {
  const vertical = spr.h > spr.w;
  const fit = (size * 2) / Math.max(spr.w, spr.h);
  const total = vertical ? spr.h : spr.w;
  const segW = spr.w * fit;
  const segH = spr.h * fit;
  const segs = vertical
    ? [{ r: 0.34, amp: 0.45, off: 0.0 }, { r: 0.42, amp: 1.0, off: 0.9 }, { r: 0.34, amp: 0.55, off: 1.8 }]
    : [{ r: 0.34, amp: 1.0, off: 1.4 }, { r: 0.42, amp: 0.55, off: 0.7 }, { r: 0.34, amp: 0.2, off: 0.0 }];

  ctx.save();
  ctx.translate(x, y + Math.sin(phase * a.freq) * size * (a.bob ?? 0.06));
  ctx.scale(flip, 1);
  ctx.rotate(base);
  let acc = -(size * 2) * 0.5;
  let srcAcc = 0;
  for (const s of segs) {
    const segLenPx = total * s.r;
    const segDisp = segLenPx * fit;
    const ang = s.amp * a.tailAmp * Math.sin(phase * a.freq + s.off);
    ctx.save();
    ctx.translate(vertical ? 0 : acc, vertical ? acc : 0);
    ctx.rotate(ang);
    if (vertical) {
      ctx.drawImage(spr.canvas, 0, Math.round(srcAcc), spr.w, Math.round(segLenPx), -segW / 2, -segDisp / 2, segW, segDisp);
    } else {
      ctx.drawImage(spr.canvas, Math.round(srcAcc), 0, Math.round(segLenPx), spr.h, -segDisp / 2, -segH / 2, segDisp, segH);
    }
    ctx.restore();
    acc += segDisp;
    srcAcc += segLenPx;
  }
  ctx.restore();
}

// 其余动物共用的六帧播放骨架。姿态来自各自独立素材；这里只统一处理
// 时间采样、锚点、朝向和极轻的推进，避免再用代码强行扭曲单张侧视图。
const CREATURE_SWIM_TIMELINE = [
  { at: 0.000, frame: 0 },
  { at: 0.170, frame: 1 },
  { at: 0.340, frame: 2 },
  { at: 0.510, frame: 3 },
  { at: 0.680, frame: 4 },
  { at: 0.850, frame: 5 },
  { at: 1.000, frame: 0 },
];

function sampleCreatureTimeline(frames, t) {
  for (let i = 0; i < CREATURE_SWIM_TIMELINE.length - 1; i++) {
    const curKey = CREATURE_SWIM_TIMELINE[i];
    const nextKey = CREATURE_SWIM_TIMELINE[i + 1];
    if (t <= nextKey.at) {
      const local = (t - curKey.at) / (nextKey.at - curKey.at);
      return {
        cur: frames[curKey.frame],
        next: frames[nextKey.frame],
        // 六帧均为同一画布锚点；让淡化覆盖段落中间 84%，既连续又保留清晰轮廓。
        mix: smoother((local - 0.08) / 0.84),
      };
    }
  }
  return { cur: frames[0], next: frames[0], mix: 0 };
}

function drawCreatureKeyframes(spr, x, y, size, heading, phase, a, level, flip, base, fit, bend) {
  const set = CREATURE_SWIM_SETS[level];
  const loadedFrames = set?.keys.map((key) => sprites.get(key)) ?? [];

  // 单套素材缺帧时回到原实现，保证部分资源失败也不会影响游戏运行。
  if (!set || !loadedFrames.every(Boolean)) {
    if (a.fallback === 'wave') drawWaveBody(spr, x, y, size, flip, base, phase, a);
    else if (a.fallback === 'pitch') drawPitch(spr, x, y, size, flip, base, phase, a, fit);
    else drawSway(spr, x, y, size, flip, base, phase, a, fit);
    return;
  }

  const T = (((phase * a.freq) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) / (Math.PI * 2);
  const { cur, next, mix } = sampleCreatureTimeline(loadedFrames, T);
  const referenceLong = Math.max(loadedFrames[0].w, loadedFrames[0].h);
  const frameScale = (size * a.extent) / referenceLong;

  const beatCount = a.motion === 'lateral' || a.motion === 'serpentine' ? 2 : 1;
  const stroke = 0.5 - 0.5 * Math.cos(T * Math.PI * 2 * beatCount);
  const surge = smoother(stroke) * size * a.surge;
  const yaw = Math.cos(T * Math.PI * 2) * a.yaw;
  const breathe = a.motion === 'axial' ? 0.008 * Math.sin(T * Math.PI * 2) : 0;

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(heading + yaw);
  ctx.translate(surge, 0);
  // 所有新序列图头朝上；转 +90° 后，素材前方与局部 +X/世界 heading 对齐。
  ctx.rotate(Math.PI / 2);
  ctx.scale(1 - breathe * 0.5, 1 + breathe);

  if (cur === next) {
    blitFrame(cur, frameScale, 1, false, bend);
  } else {
    blitFrame(cur, frameScale, 1 - mix, false, bend);
    blitFrame(next, frameScale, mix, false, bend);
  }
  ctx.restore();
}

// 六帧俯视蛙泳：滑行→收腿蓄力→蹬水→四肢完全伸展→回收→滑行。
// 时间轴故意不均匀：蹬水短促、伸展略停留、回收平滑接回起点。
const FROG_SWIM_TIMELINE = [
  { at: 0.00, frame: 0 },
  { at: 0.18, frame: 1 },
  { at: 0.31, frame: 2 },
  { at: 0.44, frame: 3 },
  { at: 0.62, frame: 3 },
  { at: 0.78, frame: 4 },
  { at: 0.91, frame: 5 },
  { at: 1.00, frame: 0 },
];

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const smoother = (k) => {
  const t = clamp01(k);
  return t * t * t * (t * (t * 6 - 15) + 10);
};

function phasePulse(t, start, peak, end) {
  if (t <= start || t >= end) return 0;
  if (t < peak) return smoother((t - start) / (peak - start));
  return 1 - smoother((t - peak) / (end - peak));
}

function sampleFrogTimeline(frames, t) {
  for (let i = 0; i < FROG_SWIM_TIMELINE.length - 1; i++) {
    const curKey = FROG_SWIM_TIMELINE[i];
    const nextKey = FROG_SWIM_TIMELINE[i + 1];
    if (t <= nextKey.at) {
      const local = (t - curKey.at) / (nextKey.at - curKey.at);
      return {
        cur: frames[curKey.frame],
        next: frames[nextKey.frame],
        // 完整位图长时间叠化会出现双头/多肢重影；只在段尾约 35% 做短促平滑换帧。
        // 连续感主要由位移、俯仰和形变承担，姿态图负责清晰轮廓。
        mix: smoother((local - 0.65) / 0.35),
      };
    }
  }
  return { cur: frames[0], next: frames[0], mix: 0 };
}

function drawFrogSwim(spr, x, y, size, heading, phase, a) {
  // 归一化相位 T ∈ [0,1)，由模拟层相位驱动，暂停/插值行为与其他生物一致。
  const T = (((phase * a.freq) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) / (Math.PI * 2);

  const loadedFrames = FROG_SWIM_KEYS.map((key) => sprites.get(key));
  const frames = loadedFrames.every(Boolean) ? loadedFrames : [spr];
  const { cur, next, mix } = frames.length > 1
    ? sampleFrogTimeline(frames, T)
    : { cur: frames[0], next: frames[0], mix: 0 };

  // 同一套生成素材沿用同一个缩放比例，不再逐帧按裁剪高度放大，避免身体忽大忽小。
  const targetH = size * 1.05;
  const frameScale = targetH / frames[0].h;

  // 俯视视角不再做离水上跳或侧面俯仰，只保留蹬水造成的前冲与极轻微呼吸形变。
  // 所有曲线首尾速度均为 0，循环连接处不会跳变。
  const rise = smoother((T - 0.12) / 0.34);
  const fall = smoother((T - 0.64) / 0.30);
  const lift = rise * (1 - fall);
  const thrust = smoother((T - 0.17) / 0.23) * (1 - smoother((T - 0.67) / 0.27));
  const compress = phasePulse(T, 0.00, 0.15, 0.31);
  const stretch = phasePulse(T, 0.25, 0.47, 0.72);
  const landing = phasePulse(T, 0.78, 0.91, 1.00);

  const surge = thrust * size * a.surge;
  const floatScale = 1 + lift * 0.018;
  const scaleX = floatScale * (1 + compress * 0.025 + stretch * 0.012 + landing * 0.012);
  const scaleY = floatScale * (1 - compress * 0.035 + stretch * 0.008 - landing * 0.015);

  ctx.save();
  ctx.translate(x, y);
  // 素材是严格俯视背部且统一朝右，直接按世界朝向旋转；禁止左右镜像。
  ctx.rotate(heading);
  ctx.translate(surge, 0);
  ctx.scale(scaleX, scaleY);

  const baseAlpha = ctx.globalAlpha;
  const drawFrame = (frame, alpha) => {
    const anchorX = frame.anchorX ?? frame.w / 2;
    const anchorY = frame.anchorY ?? frame.h / 2;
    ctx.globalAlpha = baseAlpha * alpha;
    ctx.drawImage(
      frame.canvas,
      -anchorX * frameScale,
      -anchorY * frameScale,
      frame.w * frameScale,
      frame.h * frameScale
    );
  };

  if (cur === next) {
    drawFrame(cur, 1);
  } else {
    drawFrame(cur, 1 - mix);
    drawFrame(next, mix);
  }
  ctx.restore();
}

// 蝌蚪序列图的六格均偏向同一侧；通过沿身体中轴镜像补出另一侧，
// 再按“强摆→中摆→轻摆→过中→反侧强摆”重排，形成真正连续的双侧尾波。
const TADPOLE_SWIM_TIMELINE = [
  { at: 0.00, frame: 1, mirror: false },
  { at: 0.12, frame: 2, mirror: false },
  { at: 0.23, frame: 0, mirror: false },
  { at: 0.27, frame: 0, mirror: true },
  { at: 0.38, frame: 2, mirror: true },
  { at: 0.50, frame: 1, mirror: true },
  { at: 0.62, frame: 2, mirror: true },
  { at: 0.73, frame: 0, mirror: true },
  { at: 0.77, frame: 0, mirror: false },
  { at: 0.88, frame: 2, mirror: false },
  { at: 1.00, frame: 1, mirror: false },
];

function drawTadpoleSwim(spr, x, y, size, heading, phase, a, bend) {
  // 归一化相位 T ∈ [0,1)
  const T = (((phase * a.freq) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) / (Math.PI * 2);

  const loadedFrames = TADPOLE_SWIM_KEYS.map((key) => sprites.get(key));
  const frames = loadedFrames.every(Boolean) ? loadedFrames : [spr];
  const { cur, next, curMirror, nextMirror, mix } = frames.length > 1
    ? sampleTadpoleTimeline(frames, T)
    : { cur: frames[0], next: frames[0], curMirror: false, nextMirror: false, mix: 0 };

  // 同一套素材统一缩放比例（不逐帧适配，防忽大忽小）
  const targetH = size * 1.1;
  const frameScale = targetH / frames[0].h;

  // 每次尾巴穿过中线产生一次小推进；一个循环包含左右两次推进。
  const stroke = 0.5 - 0.5 * Math.cos(T * Math.PI * 4);
  const surge = smoother(stroke) * size * a.surge;
  const yaw = Math.cos(T * Math.PI * 2) * a.yaw;

  ctx.save();
  ctx.translate(x, y);
  // 新序列图头朝上：先按世界 heading 定向，再补 +90° 的素材朝向偏移。
  ctx.rotate(heading + yaw);
  ctx.translate(surge, 0);
  ctx.rotate(Math.PI / 2);

  if (cur === next && curMirror === nextMirror) {
    blitFrame(cur, frameScale, 1, curMirror, bend);
  } else {
    blitFrame(cur, frameScale, 1 - mix, curMirror, bend);
    blitFrame(next, frameScale, mix, nextMirror, bend);
  }
  ctx.restore();
}

function sampleTadpoleTimeline(frames, t) {
  for (let i = 0; i < TADPOLE_SWIM_TIMELINE.length - 1; i++) {
    const curKey = TADPOLE_SWIM_TIMELINE[i];
    const nextKey = TADPOLE_SWIM_TIMELINE[i + 1];
    if (t <= nextKey.at) {
      const local = (t - curKey.at) / (nextKey.at - curKey.at);
      return {
        cur: frames[curKey.frame],
        next: frames[nextKey.frame],
        curMirror: curKey.mirror,
        nextMirror: nextKey.mirror,
        // 小尺寸尾巴允许整段柔和混合，消除“停住—突然换帧”的节拍感。
        mix: smoother(local),
      };
    }
  }
  return { cur: frames[0], next: frames[0], curMirror: false, nextMirror: false, mix: 0 };
}

// 鲤鱼序列图只有直尾和单侧弯尾；用中轴镜像合成另一侧，
// 形成“强摆→轻摆→直尾→反侧轻摆→反侧强摆”的对称循环。
const CARP_SWIM_TIMELINE = [
  { at: 0.000, frame: 1, mirror: false },
  { at: 0.125, frame: 3, mirror: false },
  { at: 0.250, frame: 0, mirror: false },
  { at: 0.375, frame: 3, mirror: true },
  { at: 0.500, frame: 1, mirror: true },
  { at: 0.625, frame: 3, mirror: true },
  { at: 0.750, frame: 0, mirror: false },
  { at: 0.875, frame: 3, mirror: false },
  { at: 1.000, frame: 1, mirror: false },
];

function drawCarpSwim(spr, x, y, size, heading, phase, a, bend) {
  // 归一化相位 T ∈ [0,1)
  const T = (((phase * a.freq) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) / (Math.PI * 2);

  const loadedFrames = CARP_SWIM_KEYS.map((key) => sprites.get(key));
  const frames = loadedFrames.every(Boolean) ? loadedFrames : [spr];
  const { cur, next, curMirror, nextMirror, mix } = frames.length > 1
    ? sampleCarpTimeline(frames, T)
    : { cur: frames[0], next: frames[0], curMirror: false, nextMirror: false, mix: 0 };

  // 同一套素材统一缩放比例（不逐帧适配，防忽大忽小）
  const targetH = size * 1.3;
  const frameScale = targetH / frames[0].h;

  const stroke = 0.5 - 0.5 * Math.cos(T * Math.PI * 4);
  const surge = smoother(stroke) * size * a.surge;
  const yaw = Math.cos(T * Math.PI * 2) * a.yaw;

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(heading + yaw);
  ctx.translate(surge, 0);
  ctx.rotate(Math.PI / 2);

  if (cur === next && curMirror === nextMirror) {
    blitFrame(cur, frameScale, 1, curMirror, bend);
  } else {
    blitFrame(cur, frameScale, 1 - mix, curMirror, bend);
    blitFrame(next, frameScale, mix, nextMirror, bend);
  }
  ctx.restore();
}

function sampleCarpTimeline(frames, t) {
  for (let i = 0; i < CARP_SWIM_TIMELINE.length - 1; i++) {
    const curKey = CARP_SWIM_TIMELINE[i];
    const nextKey = CARP_SWIM_TIMELINE[i + 1];
    if (t <= nextKey.at) {
      const local = (t - curKey.at) / (nextKey.at - curKey.at);
      return {
        cur: frames[curKey.frame],
        next: frames[nextKey.frame],
        curMirror: curKey.mirror,
        nextMirror: nextKey.mirror,
        mix: smoother(local),
      };
    }
  }
  return { cur: frames[0], next: frames[0], curMirror: false, nextMirror: false, mix: 0 };
}

// 鲸式：尾鳍上下拍水 → 身体俯仰 + 大起伏
function drawPitch(spr, x, y, size, flip, base, phase, a, fit) {
  const wv = Math.sin(phase * a.freq);
  const bobY = wv * size * a.bob;
  const pitch = wv * a.pitch;
  const dw = spr.w * fit;
  const dh = spr.h * fit;
  ctx.save();
  ctx.translate(x, y + bobY);
  ctx.scale(flip, 1);
  ctx.rotate(base + pitch * flip);
  ctx.drawImage(spr.canvas, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
}

// 摆动式（蝌蚪/龙虾/乌龟）：左右摇 + 上下浮 + 挤压拉伸
function drawSway(spr, x, y, size, flip, base, phase, a, fit) {
  const rock = Math.sin(phase * a.freq) * a.rock;
  const bobY = Math.sin(phase * a.freq * 1.7) * size * a.bob;
  const dw = spr.w * fit;
  const dh = spr.h * fit;
  ctx.save();
  ctx.translate(x, y + bobY);
  ctx.scale(flip, 1);
  ctx.rotate(base + rock * flip);
  const sw = 1 + a.squash * Math.abs(Math.sin(phase * a.freq));
  ctx.scale(sw, 2 - sw);
  ctx.drawImage(spr.canvas, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
}

// 玩家头顶合成进度环（0..3）
function drawProgressRing(x, y, radius, rock) {
  const r = radius + 10 + Math.abs(rock) * 4;
  ctx.strokeStyle = 'rgba(0,0,0,0.45)';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = '#ffd75e';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + (game.player.progress / CONFIG.progressToEvolve) * Math.PI * 2);
  ctx.stroke();
}

function drawDangerVignette() {
  // 最近捕食者距离 → 屏幕边缘泛红预警（SPEC 1.5）
  let minPred = Infinity;
  for (const c of game.snapshot().creatures) {
    if (c.level > game.player.level) {
      const d = Math.hypot(c.x - game.player.x, c.y - game.player.y);
      if (d < minPred) minPred = d;
    }
  }
  if (minPred < 600 && minPred !== Infinity) {
    const a = (1 - minPred / 600) * 0.35;
    const g = ctx.createRadialGradient(viewW / 2, viewH / 2, Math.min(viewW, viewH) * 0.3, viewW / 2, viewH / 2, Math.max(viewW, viewH) * 0.7);
    g.addColorStop(0, 'rgba(255,0,0,0)');
    g.addColorStop(1, `rgba(255,40,40,${a})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, viewW, viewH);
  }
}

function drawEvolveFx(dt) {
  if (evolveFx) {
    evolveFx.t += dt / 0.7;
    if (evolveFx.t >= 1) {
      evolveFx = null;
    } else {
      // 全屏闪光
      ctx.fillStyle = `rgba(255, 240, 180, ${(1 - evolveFx.t) * 0.5})`;
      ctx.fillRect(0, 0, viewW, viewH);
      // 玩家处扩散光环
      const p = game.player;
      const r = p.radius * (1 + evolveFx.t * 3);
      ctx.strokeStyle = `rgba(255, 220, 120, ${1 - evolveFx.t})`;
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

function updateParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;
    if (p.life <= 0) {
      particles.splice(i, 1);
      continue;
    }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
  }
  for (const p of particles) {
    ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function spawnEvolveParticles(x, y, radius) {
  for (let i = 0; i < 26; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = 40 + Math.random() * 120;
    particles.push({
      x,
      y,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp,
      life: 0.5 + Math.random() * 0.4,
      maxLife: 0.9,
      size: 3 + Math.random() * 4,
      color: ['#ffd75e', '#ffe9a8', '#fff6d8'][Math.floor(Math.random() * 3)],
    });
  }
}

// —— 渲染帧（用插值状态：prev→cur 平滑过渡，消除步进跳变）——
function render(dt) {
  const p = curSnap.player;
  const prevP = prevSnap ? prevSnap.player : curSnap.player;
  // 插值因子：距上次模拟步进的经过时间 / FIXED_DT
  const t = Math.min(1, (performance.now() - lastStepTime) / (FIXED_DT * 1000));
  const ix = prevP.x + (p.x - prevP.x) * t;
  const iy = prevP.y + (p.y - prevP.y) * t;
  const iHeading = lerpAngle(prevP.heading, p.heading, t); // 朝向同样插值，转身无步进台阶
  const iRadius = p.radius;
  const iPhase = prevP.animPhase + (p.animPhase - prevP.animPhase) * t;

  camera.follow(ix, iy, iRadius, CONFIG.worldWidth, CONFIG.worldHeight, dt);

  camera.apply(ctx);
  drawBackground();

  // 生物从大到小绘制，玩家最后置顶；所有生物统一视觉尺寸，等级靠外观+标记区分
  const drawList = curSnap.creatures
    .map((c) => ({ c, spr: sprites.get(c.level) }))
    .sort((a, b) => b.c.radius - a.c.radius);
  const prevById = new Map((prevSnap ? prevSnap.creatures : []).map((c) => [c.id, c]));
  for (const { c, spr } of drawList) {
    const pc = prevById.get(c.id) || c;
    const cx = pc.x + (c.x - pc.x) * t;
    const cy = pc.y + (c.y - pc.y) * t;
    const ph = pc.animPhase + (c.animPhase - pc.animPhase) * t;
    const hd = lerpAngle(pc.heading, c.heading, t);
    const bend = bodyBend(c.id, pc.heading, c.heading, c.level, GAIT[c.level].turnDeg, dt);
    drawCreature(spr, cx, cy, UNIFORM_R, hd, ph, false, c.level > p.level, c.level, bend, c.lunge);
  }
  // 复活无敌：玩家闪烁（保护中）
  const playerBend = bodyBend('player', prevP.heading, p.heading, p.level, CONFIG.turnRateDeg, dt);
  const invulnerable = curSnap.invulnerableTicks > 0;
  if (invulnerable) ctx.globalAlpha = 0.35 + 0.3 * Math.sin(performance.now() / 90);
  drawCreature(sprites.get(p.level), ix, iy, UNIFORM_R, iHeading, iPhase, true, false, p.level, playerBend);
  ctx.globalAlpha = 1;
  // 交换弯曲状态表：本帧未出现的生物（被吃/消失）自动清理
  [bendState, nextBendState] = [nextBendState, bendState];
  nextBendState.clear();

  // 屏幕空间特效
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  updateParticles(dt);
  drawDangerVignette();
  drawEvolveFx(dt);

  updateHud();
}

function updateHud() {
  const snap = curSnap;
  hudLevel.textContent = `Lv.${snap.player.level + 1} · ${EVOLUTION[snap.player.level].name}`;
  hudScore.textContent = `得分 ${snap.score}`;
  hudTime.textContent = `${Math.floor(snap.tick * FIXED_DT)}s`;
  const frac = Math.min(1, snap.player.progress / CONFIG.progressToEvolve);
  hudProgress.style.width = `${frac * 100}%`;
}

// 小地图：左下角，世界全览（玩家黄点、AI 生物白点、视野白框）
function drawMinimap() {
  const snap = curSnap;
  const { worldWidth: W, worldHeight: H } = CONFIG;
  const sx = (wx) => (wx / W) * MINIMAP_W;
  const sy = (wy) => (wy / H) * MINIMAP_H;

  minimapCtx.clearRect(0, 0, MINIMAP_W, MINIMAP_H);
  minimapCtx.fillStyle = 'rgba(10, 40, 60, 0.6)';
  minimapCtx.fillRect(0, 0, MINIMAP_W, MINIMAP_H);

  // AI 生物（白色小点，捕食者红色）
  minimapCtx.fillStyle = 'rgba(220, 245, 255, 0.7)';
  for (const c of snap.creatures) {
    if (c.x === undefined) continue;
    minimapCtx.fillStyle = c.level > snap.player.level ? 'rgba(255, 90, 90, 0.85)' : 'rgba(220, 245, 255, 0.7)';
    minimapCtx.beginPath();
    minimapCtx.arc(sx(c.x), sy(c.y), c.level > snap.player.level ? 2.4 : 1.6, 0, Math.PI * 2);
    minimapCtx.fill();
  }

  // 视野框（白框：当前屏幕覆盖的世界范围）
  const halfW = viewW / 2 / camera.scale;
  const halfH = viewH / 2 / camera.scale;
  minimapCtx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
  minimapCtx.lineWidth = 1;
  minimapCtx.strokeRect(
    sx(snap.player.x - halfW),
    sy(snap.player.y - halfH),
    sx(snap.player.x + halfW) - sx(snap.player.x - halfW),
    sy(snap.player.y + halfH) - sy(snap.player.y - halfH)
  );

  // 玩家（黄色，最醒目）
  minimapCtx.fillStyle = '#ffd75e';
  minimapCtx.beginPath();
  minimapCtx.arc(sx(snap.player.x), sy(snap.player.y), 4, 0, Math.PI * 2);
  minimapCtx.fill();
  minimapCtx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
  minimapCtx.lineWidth = 1;
  minimapCtx.stroke();
}

// —— 主循环：固定步进模拟 + 插值渲染 ——
let acc = 0;
let last = performance.now();
let lastStepTime = performance.now();

function frame(now) {
  const realDt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!game) {
    requestAnimationFrame(frame);
    return;
  }

  // 暂停：模拟冻结，仅继续渲染（画面静止 + 小地图不更新）
  if (paused) {
    render(realDt);
    requestAnimationFrame(frame);
    return;
  }

  // 固定步进：先累积真实时间，攒够一个 FIXED_DT 才步进一次（上限 8 步防螺旋死）
  acc += realDt;
  let steps = 0;
  while (acc >= FIXED_DT && steps < 8) {
    prevSnap = curSnap;
    const snap = game.snapshot();
    const dir = input.direction(snap.player.x, snap.player.y, camera);
    game.step(dir);
    curSnap = game.snapshot();
    lastStepTime = now;
    acc -= FIXED_DT;
    steps++;

    // 进化检测 → 特效
    if (game.player.level > prevLevel) {
      evolveFx = { t: 0 };
      spawnEvolveParticles(game.player.x, game.player.y, game.player.radius);
    }
    prevLevel = game.player.level;

    if (game.gameOver) {
      handleGameOver();
      break;
    }
  }

  if (!game) return;
  render(realDt);
  drawMinimap();
  requestAnimationFrame(frame);
}

function handleGameOver() {
  if (over) return;
  over = true;
  const info = game.deathInfo;
  const stats = curSnap;
  const elapsed = game.tick * FIXED_DT;
  const score = game.score;
  const isBest = score > bestScore;
  if (isBest) {
    bestScore = score;
    localStorage.setItem(BEST_KEY, String(bestScore));
  }
  const revived = stats.deaths > 0;
  deathStats.innerHTML = `
    <div class="stat">最终等级 <b>Lv.${stats.player.level + 1} · ${EVOLUTION[stats.player.level].name}</b></div>
    <div class="stat">总分 <b>${score}</b> ${isBest ? '<span class="newbest">🏆 新纪录!</span>' : ''}</div>
    <div class="stat">存活 <b>${Math.floor(elapsed)}s</b></div>
    <div class="stat">被 <b>${EVOLUTION[info.predator_level].name}</b> 吞噬${revived ? `（已复活 ${stats.deaths} 次）` : ''}</div>
    <div class="stat">历史最高 <b>${bestScore}</b></div>
  `;
  continueBtn.classList.toggle('hidden', !revived); // 复活过一次后可见
  deathOverlay.classList.remove('hidden');
}

// —— 启动 ——
const loadingEl = document.getElementById('loading');
let sprites;
try {
  sprites = await loadSprites();
  loadingEl.remove();
} catch (e) {
  console.error('素材加载失败:', e);
  loadingEl.textContent = '素材加载失败：' + e.message;
  throw e;
}
newGame();
prevSnap = null;
curSnap = game.snapshot();
// 调试/自动化验证：暴露青蛙关键帧序列状态
window.__frogFrames = () => {
  return FROG_SWIM_KEYS.map((k) => {
    const s = sprites.get(k);
    return s ? `${k}:${s.w}x${s.h}` : `${k}:MISSING`;
  });
};
window.__creatureFrames = () => {
  return Object.values(CREATURE_SWIM_SETS).map((set) => ({
    level: set.level,
    id: set.id,
    frames: set.keys.map((key) => {
      const frame = sprites.get(key);
      return frame ? `${key}:${frame.w}x${frame.h}` : `${key}:MISSING`;
    }),
  }));
};
requestAnimationFrame(frame);
