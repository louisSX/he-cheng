// 输入策略（SPEC Part 2.6）：从可见状态 → {dx, dy}，只读 snapshot，不碰隐藏状态。
// 全部为工厂函数：每局一个实例，可持有目标锁存等局内状态。
import { CONFIG } from '../core/constants.js';
import { mulberry32 } from '../core/rng.js';

const norm = (dx, dy) => {
  const len = Math.hypot(dx, dy);
  return len > 0 ? { dx: dx / len, dy: dy / len } : { dx: 0, dy: 0 };
};

const findByPos = (snap, target) => {
  if (!target) return null;
  for (const c of snap.creatures) {
    if (c.id === target.id) return c;
  }
  return null;
};

// —— 单调策略 ——

// 不输入：角色保持直行（0,0 = 保持当前航向）
export function makeNoInput() {
  return () => ({ dx: 0, dy: 0 });
}

// 固定方向直行
export function makeFixedDirection() {
  return () => ({ dx: 1, dy: 0 });
}

// 通用"追最近可吃目标"（levelPred 决定目标等级范围），带目标锁存 + 逃跑。
// 锁存：目标存活就继续追，避免每 tick 换目标导致的锯齿形漂移。
export function makeNearestTarget(levelPred, opts = {}) {
  const lockTicks = opts.lockTicks ?? 90; // 最多锁 ~1.5s
  const fleeDist = opts.fleeDist ?? 350;
  let target = null;
  let lockLeft = 0;
  let fleeUntil = 0;

  return (snap) => {
    const p = snap.player;
    // 捕食者逃跑（带冷却：逃跑方向锁定 ~0.7s，避免犹豫抖动）
    let dPred = Infinity;
    for (const c of snap.creatures) {
      if (c.level <= p.level) continue;
      dPred = Math.min(dPred, Math.hypot(c.x - p.x, c.y - p.y));
    }
    if (dPred < fleeDist) {
      fleeUntil = snap.tick + 40;
      let px = p.x;
      let py = p.y;
      for (const c of snap.creatures) {
        if (c.level > p.level) {
          const d = Math.hypot(c.x - p.x, c.y - p.y);
          if (d < 500) {
            px += (p.x - c.x) / (d + 1);
            py += (p.y - c.y) / (d + 1);
          }
        }
      }
      return norm(px - p.x, py - p.y);
    }
    if (snap.tick < fleeUntil) return norm(Math.cos(p.heading), Math.sin(p.heading));

    // 目标锁存：目标还在且还在可吃范围内 → 继续追
    const held = findByPos(snap, target);
    if (held && lockLeft > 0 && levelPred(held, p)) {
      lockLeft--;
      return norm(held.x - p.x, held.y - p.y);
    }
    // 选新目标：最近的符合条件的
    let best = null;
    let dBest = Infinity;
    for (const c of snap.creatures) {
      if (!levelPred(c, p)) continue;
      const d = Math.hypot(c.x - p.x, c.y - p.y);
      if (d < dBest) {
        dBest = d;
        best = c;
      }
    }
    if (best) {
      target = best;
      lockLeft = lockTicks;
      return norm(best.x - p.x, best.y - p.y);
    }
    return norm(Math.cos(p.heading), Math.sin(p.heading));
  };
}

// 猥琐流：只吃低级（永不主动碰同级）
export const makeGreedyNearestPrey = () =>
  makeNearestTarget((c, p) => c.level < p.level, { lockTicks: 120 });

// 合成流：只追同级（涨进度）
export const makeGreedyNearestSame = () =>
  makeNearestTarget((c, p) => c.level === p.level, { lockTicks: 120 });

// —— 探索策略 ——
// 带风险感知的加权启发式。variant 决定本局参数（prey/same 权重、风险厌恶度、
// 进化激进度、目标选择扰动），用 variant 种子初始化 RNG —— 一局内固定。
export function makeExploratory(variantSeed) {
  const rng = mulberry32(variantSeed);
  const preyW = 0.8 + rng() * 0.6;        // 低级猎物权重
  const sameW = 0.8 + rng() * 1.2;        // 同级素材权重
  const riskAverse = 0.4 + rng() * 1.2;   // 风险厌恶度
  const aggressive = rng() < 0.5;         // 半数变体：接近进化时更激进
  const noise = rng() * 0.4;              // 目标选择扰动
  const fleeDist = 300 + rng() * 120;
  const lockTicks = 60 + Math.floor(rng() * 90);
  let target = null;
  let lockLeft = 0;

  return (snap) => {
    const p = snap.player;
    // 最近捕食者距离
    let dPred = Infinity;
    for (const c of snap.creatures) {
      if (c.level <= p.level) continue;
      dPred = Math.min(dPred, Math.hypot(c.x - p.x, c.y - p.y));
    }
    // 逃跑：捕食者太近 → 背向所有捕食者
    if (dPred < fleeDist) {
      let px = p.x;
      let py = p.y;
      for (const c of snap.creatures) {
        if (c.level > p.level) {
          const d = Math.hypot(c.x - p.x, c.y - p.y);
          if (d < 550) {
            px += (p.x - c.x) / (d + 1);
            py += (p.y - c.y) / (d + 1);
          }
        }
      }
      return norm(px - p.x, py - p.y);
    }

    // 接近进化时放大同级权重（半数变体激进）
    const nearEvolve = p.progress >= 2.5;
    const sameEff = sameW * (nearEvolve && aggressive ? 2.2 : 1);
    const preyEff = nearEvolve && aggressive ? preyW * 0.5 : preyW;

    // 目标锁存
    const held = findByPos(snap, target);
    if (held && lockLeft > 0 && held.level <= p.level) {
      lockLeft--;
      return norm(held.x - p.x, held.y - p.y);
    }

    let best = null;
    let bestU = -Infinity;
    for (const c of snap.creatures) {
      if (c.level > p.level) continue; // 不主动追捕食者
      const d = Math.hypot(c.x - p.x, c.y - p.y);
      if (d < 1) continue;
      const value =
        c.level < p.level
          ? (CONFIG.preyScore + CONFIG.progressPerPrey) * preyEff
          : (CONFIG.sameScore + CONFIG.progressPerSame) * sameEff;
      let u = value / (d + 80) + noise;
      // 风险惩罚：捕食者越近，目标价值越低（避免贴脸追猎物被秒）
      if (dPred < fleeDist) {
        u -= riskAverse * (1 - dPred / fleeDist) * 4;
      }
      if (u > bestU) {
        bestU = u;
        best = c;
      }
    }
    if (best) {
      target = best;
      lockLeft = lockTicks;
      return norm(best.x - p.x, best.y - p.y);
    }
    return norm(Math.cos(p.heading), Math.sin(p.heading));
  };
}

// 注册表：CLI 按名取工厂
export const POLICY_FACTORIES = {
  no_input: makeNoInput,
  fixed_direction: makeFixedDirection,
  greedy_nearest_prey: makeGreedyNearestPrey,
  greedy_nearest_same: makeGreedyNearestSame,
  exploratory: makeExploratory,
};
