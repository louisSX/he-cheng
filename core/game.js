// 纯游戏逻辑（SPEC Part 2.1）：无渲染依赖，Node 可跑，确定性，可播种。
// 只有因果事件才计分（吃/进化），绝不按输入事实计分（SPEC 2.11 门槛）。

import { CONFIG, EVOLUTION, GAIT, MAX_LEVEL, MAX_PLAYER_LEVEL } from './constants.js';
import { mulberry32 } from './rng.js';

const D2R = Math.PI / 180;
const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const frac = (v) => v - Math.floor(v);

// 步态脉冲：单拍内以 peak 为中心的环绕高斯（0..1）
function gaitPulse(u, g) {
  let d = Math.abs(u - g.peak);
  d = Math.min(d, 1 - d);
  return Math.exp(-(d / g.width) * (d / g.width));
}
// 各等级脉冲均值（数值积分），用于让速度倍率均值恒为 1 → 平均速度与平衡不受步态影响
const GAIT_MEAN = GAIT.map((g) => {
  const N = 512;
  let s = 0;
  for (let i = 0; i < N; i++) s += gaitPulse(i / N, g);
  return s / N;
});

// 划水节奏带来的瞬时速度倍率。相位定义与渲染层关键帧一致：T = frac(phase * freq / 2π)
export function gaitMultiplier(level, phase) {
  const g = GAIT[level];
  const T = frac((phase * g.freq) / TAU);
  const u = frac(T * g.beats);
  return 1 + g.amp * (gaitPulse(u, g) - GAIT_MEAN[level]);
}

// 摆尾相位推进量：只随名义速度与冲刺倍率变化（不含步态起伏，保证时间平均 = 相位平均）
const phaseStep = (nominalSpeed, boostMul) => (0.04 + nominalSpeed * 0.0003) * boostMul;

export class Game {
  constructor(seed) {
    this.rng = mulberry32(seed);
    this.tick = 0;
    this.score = 0;
    this.gameOver = false;
    this.deathInfo = null;
    this.deaths = 0;            // 被吞次数（复活统计）
    this.invulnerableTicks = 0; // 复活无敌帧（原地复活保护）
    this._events = [];
    this._nextCreatureId = 0;

    const { worldWidth: W, worldHeight: H } = CONFIG;
    this.player = {
      x: W / 2,
      y: H / 2,
      level: 0,
      heading: this.rng() * Math.PI * 2,
      progress: 0, // 0..3
      animPhase: 0,
    };
    this.creatures = [];
    // 开局补足到目标只数
    for (let i = 0; i < 300 && this.creatures.length < CONFIG.targetPopulation; i++) {
      this.spawnCreature();
    }
  }

  // 小型填充数：等级 ≤ max(0, 玩家-2) 的生物数（食物链底层小鱼，SPEC 1.7）
  _countSmall() {
    const cap = Math.max(0, this.player.level - 2);
    let n = 0;
    for (const c of this.creatures) {
      if (!c.dead && c.level <= cap) n++;
    }
    return n;
  }

  // 小型填充等级：玩家-3 附近（保底 ≥ 0），让世界始终有底层小鱼
  _pickFillerLevel() {
    const base = Math.max(0, this.player.level - 3);
    const roll = Math.floor(this.rng() * 3); // 0..2
    return Math.max(0, Math.min(MAX_LEVEL - 1, base + roll));
  }

  radiusOf(level) {
    return EVOLUTION[level].radius;
  }
  playerSpeed() {
    return CONFIG.baseSpeed + this.player.level * CONFIG.speedPerLevel;
  }
  creatureSpeed(c) {
    // 速度梯度：按生物相对玩家的等级差取系数（食物链结构，见 constants.speedDiffFactors）
    const rel = String(clamp(c.level - this.player.level, -2, 3));
    const factor = CONFIG.speedDiffFactors[rel];
    return (CONFIG.baseSpeed + c.level * CONFIG.speedPerLevel) * factor;
  }

  // —— 生成（SPEC 1.7）：按玩家等级动态调配 + 安全距离 ——
  _pickSpawnLevel() {
    const L = this.player.level;
    // 高 2 级以上威胁仅在中后期解锁（防新手期被秒）
    const g = clamp((L - CONFIG.highThreatGainStart) / (CONFIG.highThreatGainFull - CONFIG.highThreatGainStart), 0, 1);
    const w = CONFIG.levelWeights;
    const raw = [
      [-2, w.m2],
      [-1, w.m1],
      [0, w.m0],
      [1, w.p1],
      [2, w.p2 * g],
      [3, w.p3 * g],
    ];
    const total = raw.reduce((s, [, wt]) => s + wt, 0);
    let roll = this.rng() * total;
    for (const [rel, wt] of raw) {
      roll -= wt;
      if (roll <= 0) {
        return clamp(L + rel, 0, MAX_LEVEL - 1);
      }
    }
    return clamp(L + raw[raw.length - 1][0], 0, MAX_LEVEL - 1);
  }

  spawnCreature() {
    const level = this._pickSpawnLevel();
    return this._spawnAt(level, null);
  }

  _spawnAt(level, nearPos) {
    const { worldWidth: W, worldHeight: H } = CONFIG;
    const r = this.radiusOf(level);
    const p = this.player;
    const safetyR = this.radiusOf(p.level) * CONFIG.spawnSafetyFactor + r;
    const x0 = nearPos ? nearPos.x : p.x;
    const y0 = nearPos ? nearPos.y : p.y;

    for (let i = 0; i < CONFIG.spawnAttempts; i++) {
      let x, y;
      if (nearPos) {
        // 进化奖励素材：玩家附近随机方向
        const ang = this.rng() * Math.PI * 2;
        const dist = CONFIG.evolveSpawnDist[0] + this.rng() * (CONFIG.evolveSpawnDist[1] - CONFIG.evolveSpawnDist[0]);
        x = x0 + Math.cos(ang) * dist;
        y = y0 + Math.sin(ang) * dist;
      } else {
        x = this.rng() * (W - r * 2) + r;
        y = this.rng() * (H - r * 2) + r;
      }
      // 安全距离：距玩家 ≥ 玩家半径 * factor + 目标半径（SPEC 5.1 安全距离模式）
      const dx = x - p.x;
      const dy = y - p.y;
      if (dx * dx + dy * dy < safetyR * safetyR) continue;
      // 最小间距：距最近生物 ≥ 目标半径*factor + 最近生物半径（防扎堆，SPEC 5.2 密度管理）
      let minDist2 = Infinity;
      let nearestR = 0;
      for (const o of this.creatures) {
        if (o.dead) continue;
        const ox = x - o.x;
        const oy = y - o.y;
        const d2 = ox * ox + oy * oy;
        if (d2 < minDist2) {
          minDist2 = d2;
          nearestR = this.radiusOf(o.level);
        }
      }
      const minGap = r * CONFIG.spawnMinGapFactor + nearestR;
      if (minDist2 < minGap * minGap) continue;
      if (x < r || x > W - r || y < r || y > H - r) continue;
      const heading = this.rng() * Math.PI * 2;
      const c = {
        id: this._nextCreatureId++,
        x,
        y,
        level,
        heading,
        targetHeading: heading, // AI 决策只改目标朝向，实际朝向按物种转向速度逐 tick 追随
        nextDecision: this.tick + 30 + Math.floor(this.rng() * 60),
        escapeCooldown: 0,
        escapeBoost: 0,
        slipTicks: 0,
        lungePhase: 0,    // 0 无 / 1 蓄势 / 2 猛冲
        lungeTicks: 0,
        lungeCooldown: 0,
        animPhase: this.rng() * Math.PI * 2,
        dead: false,
      };
      this.creatures.push(c);
      this._emit('spawn', { level, x, y, dist_to_player: Math.sqrt(dx * dx + dy * dy) });
      return c;
    }
    return null; // 无公平位置则跳过（不强制生成）
  }

  // —— 玩家 ——
  step(input) {
    if (this.gameOver) return [];
    this._events = [];
    this.tick++;
    this.invulnerableTicks = Math.max(0, this.invulnerableTicks - 1);
    this._movePlayer(input);
    this._updateCreatures();
    this._checkPlayerCollisions();
    if (!this.gameOver) this._checkCreatureEat();
    if (!this.gameOver) this._maintainPopulation();
    const ev = this._events;
    this._events = [];
    return ev;
  }

  _movePlayer(input) {
    const p = this.player;
    let target = p.heading;
    if (input && (input.dx !== 0 || input.dy !== 0)) {
      target = Math.atan2(input.dy, input.dx);
    }
    p.heading = this._turnToward(p.heading, target, CONFIG.turnRateDeg * D2R);
    const nominal = this.playerSpeed();
    const speed = nominal * gaitMultiplier(p.level, p.animPhase); // 蹬水/摆尾发力时加速，滑行时减速
    p.x += Math.cos(p.heading) * speed * CONFIG.fixedDt;
    p.y += Math.sin(p.heading) * speed * CONFIG.fixedDt;
    const r = this.radiusOf(p.level);
    p.x = clamp(p.x, r, CONFIG.worldWidth - r);
    p.y = clamp(p.y, r, CONFIG.worldHeight - r);
    p.animPhase += phaseStep(nominal, 1); // 游动摆尾相位（渲染层据此播放关键帧）
  }

  _turnToward(cur, target, maxStep) {
    let d = target - cur;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    if (Math.abs(d) <= maxStep) return target;
    return cur + Math.sign(d) * maxStep;
  }

  // —— 吞噬判定（SPEC 1.5）——
  _checkPlayerCollisions() {
    // 复活无敌期间穿过一切（不吞别人也不被吞），2 秒保护期
    if (this.invulnerableTicks > 0) return;
    const p = this.player;
    // 碰撞半径统一用视觉半径（24）：视觉接触 = 碰撞触发，等级差异由吃/死判定体现
    const eatD = (CONFIG.visualRadius + CONFIG.visualRadius) * CONFIG.eatDistFactor;
    for (const c of this.creatures) {
      if (c.dead || c.slipTicks > 0) continue; // 刚挣脱的生物处于滑脱窗口，接触不判定
      const dx = c.x - p.x;
      const dy = c.y - p.y;
      if (dx * dx + dy * dy > eatD * eatD) continue;

      if (c.level < p.level) {
        this._eat(c, 'prey');
      } else if (c.level === p.level) {
        if (c.escapeCooldown <= 0 && this.rng() < CONFIG.escapeChance) {
          this._escape(c);
        } else {
          this._eat(c, 'same');
        }
      } else {
        this._die(c);
        return;
      }
    }
  }

  _eat(c, reason) {
    const p = this.player;
    c.dead = true;
    const gain = reason === 'same' ? CONFIG.sameScore : CONFIG.preyScore;
    const progress = reason === 'same' ? CONFIG.progressPerSame : CONFIG.progressPerPrey;
    p.progress += progress;
    this.score += gain;
    this._emit('eat', {
      target_level: c.level,
      player_level: p.level,
      progress_delta: progress,
      score_gain: gain,
      reason,
    });
    if (p.progress >= CONFIG.progressToEvolve) this._evolve();
  }

  // 挣脱：不再瞬移，而是掉头背离玩家 + 爆发冲刺游走；滑脱窗口内玩家接触不判定
  _escape(c) {
    const p = this.player;
    const away = Math.atan2(c.y - p.y, c.x - p.x);
    c.targetHeading = away + (this.rng() - 0.5) * CONFIG.escapeJitter;
    c.escapeCooldown = CONFIG.escapeCooldown;
    c.escapeBoost = CONFIG.escapeBoostTicks;
    c.slipTicks = CONFIG.escapeSlipTicks;
    c.nextDecision = this.tick + CONFIG.escapeBoostTicks; // 冲刺期间保持逃离方向，不被 AI 决策打断
    this._emit('escape', { level: c.level, x: c.x, y: c.y });
  }

  _evolve() {
    const p = this.player;
    const from = p.level;
    p.level = Math.min(MAX_PLAYER_LEVEL - 1, p.level + 1); // 玩家进化上限：红龙（链外深海巨兽不可进化）
    p.progress -= CONFIG.progressToEvolve;
    this.score += CONFIG.evolveScore;
    this._emit('evolve', { from_level: from, to_level: p.level, score_gain: CONFIG.evolveScore });
    // 可选：小概率生成低级素材辅助下一阶段起手（仅玩家可进化范围内）
    if (p.level < MAX_PLAYER_LEVEL - 1 && this.rng() < CONFIG.evolveSpawnChance) {
      this._spawnAt(p.level - 1, { x: p.x, y: p.y });
    }
  }

  _die(predator) {
    this.gameOver = true;
    this.deaths++;
    this.deathInfo = {
      cause: 'eaten',
      predator_level: predator.level,
      player_level: this.player.level,
      x: this.player.x,
      y: this.player.y,
    };
    this._emit('death', this.deathInfo);
  }

  // 原地复活（零代价）：保留等级/进度/分数/位置，仅清除死亡状态并给无敌帧
  revive() {
    if (!this.gameOver) return;
    this.gameOver = false;
    this.deathInfo = null;
    this.invulnerableTicks = Math.round(2 / CONFIG.fixedDt); // 2 秒无敌保护
    this._emit('revive', { player_level: this.player.level, score: this.score });
  }

  // —— AI ——
  _updateCreatures() {
    const { worldWidth: W, worldHeight: H } = CONFIG;
    for (const c of this.creatures) {
      if (c.dead) continue;
      c.escapeCooldown = Math.max(0, c.escapeCooldown - 1);
      c.escapeBoost = Math.max(0, c.escapeBoost - 1);
      c.slipTicks = Math.max(0, c.slipTicks - 1);
      this._updateLunge(c);
      if (c.lungePhase === 0 && this.tick >= c.nextDecision) {
        this._decideCreature(c);
        c.nextDecision = this.tick + CONFIG.aiTurnInterval[0] + Math.floor(this.rng() * (CONFIG.aiTurnInterval[1] - CONFIG.aiTurnInterval[0]));
      }
      const r = this.radiusOf(c.level);
      this._steerFromWalls(c, r);

      // 挣脱冲刺：起步猛冲、按三次方衰减回到常规加速
      let boostMul = 1;
      let turnMul = 1;
      if (c.escapeBoost > 0) {
        const k = c.escapeBoost / CONFIG.escapeBoostTicks;
        boostMul = CONFIG.escapeBoostFactor + CONFIG.escapeBurst * k * k * k;
        turnMul = CONFIG.escapeTurnFactor;
      } else if (c.lungePhase === 1) {
        boostMul = CONFIG.lungeWindupSpeed;
        turnMul = CONFIG.lungeTurnFactor;
      } else if (c.lungePhase === 2) {
        const k = c.lungeTicks / CONFIG.lungeStrikeTicks;
        boostMul = 1 + (CONFIG.lungeStrikeBoost - 1) * k * k;
        turnMul = CONFIG.lungeTurnFactor;
      }
      // 平滑转向：按物种转向速度追随目标朝向（体型越大转身越慢），冲刺/扑击期间转向加快
      const turn = GAIT[c.level].turnDeg * D2R * turnMul;
      c.heading = this._turnToward(c.heading, c.targetHeading, turn);

      const nominal = this.creatureSpeed(c);
      const speed = nominal * boostMul * gaitMultiplier(c.level, c.animPhase);
      c.x = clamp(c.x + Math.cos(c.heading) * speed * CONFIG.fixedDt, r, W - r);
      c.y = clamp(c.y + Math.sin(c.heading) * speed * CONFIG.fixedDt, r, H - r);
      c.animPhase += phaseStep(nominal, boostMul); // 冲刺时划水更急
    }
  }

  // 捕食者扑击状态机：蓄势（减速对准）→ 猛冲（追踪玩家）→ 冷却
  _updateLunge(c) {
    const p = this.player;
    if (c.lungeCooldown > 0) c.lungeCooldown--;
    if (c.lungePhase !== 0) {
      // 玩家进化到同级/以上或进入无敌 → 中止扑击
      if (c.level <= p.level || this.invulnerableTicks > 0) {
        c.lungePhase = 0;
        c.lungeCooldown = CONFIG.lungeCooldownTicks;
        return;
      }
      c.targetHeading = Math.atan2(p.y - c.y, p.x - c.x); // 全程追踪玩家
      if (--c.lungeTicks > 0) return;
      if (c.lungePhase === 1) {
        c.lungePhase = 2;
        c.lungeTicks = CONFIG.lungeStrikeTicks;
        this._emit('lunge', { level: c.level, player_level: p.level });
      } else {
        c.lungePhase = 0;
        c.lungeCooldown = CONFIG.lungeCooldownTicks;
      }
      return;
    }
    if (p.level < CONFIG.lungeMinPlayerLevel) return; // 新手期不启用扑击（同高 2 级威胁的中后期解锁原则）
    if (c.level <= p.level || c.lungeCooldown > 0 || c.escapeBoost > 0 || this.invulnerableTicks > 0) return;
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    if (dx * dx + dy * dy < CONFIG.lungeDist * CONFIG.lungeDist) {
      c.lungePhase = 1;
      c.lungeTicks = CONFIG.lungeWindupTicks;
      c.targetHeading = Math.atan2(dy, dx);
    }
  }

  // 近墙转向：目标朝向指向墙时镜像到离墙方向，由平滑转向完成转身（替代瞬间反弹）
  _steerFromWalls(c, r) {
    const m = CONFIG.aiWallMargin + r;
    let tx = Math.cos(c.targetHeading);
    let ty = Math.sin(c.targetHeading);
    if ((c.x < m && tx < 0) || (c.x > CONFIG.worldWidth - m && tx > 0)) tx = -tx;
    if ((c.y < m && ty < 0) || (c.y > CONFIG.worldHeight - m && ty > 0)) ty = -ty;
    c.targetHeading = Math.atan2(ty, tx);
  }

  _decideCreature(c) {
    // 找最近的更小生物（可追）与更大的生物（要逃）
    let nearestSmaller = null;
    let dSmall = Infinity;
    let nearestBigger = null;
    let dBig = Infinity;
    const chase2 = CONFIG.aiChaseDist * CONFIG.aiChaseDist;
    const flee2 = CONFIG.aiFleeDist * CONFIG.aiFleeDist;

    for (const o of this.creatures) {
      if (o === c || o.dead) continue;
      const dx = o.x - c.x;
      const dy = o.y - c.y;
      const d2 = dx * dx + dy * dy;
      if (o.level < c.level && d2 < chase2 && d2 < dSmall) {
        dSmall = d2;
        nearestSmaller = o;
      }
      if (o.level > c.level && d2 < flee2 && d2 < dBig) {
        dBig = d2;
        nearestBigger = o;
      }
    }
    // 玩家也参与 AI 的追/逃
    const p = this.player;
    const pdx = p.x - c.x;
    const pdy = p.y - c.y;
    const pd2 = pdx * pdx + pdy * pdy;
    if (p.level > c.level && pd2 < chase2 && pd2 < dSmall) {
      dSmall = pd2;
      nearestSmaller = { x: p.x, y: p.y };
    }
    if (p.level < c.level && pd2 < flee2 && pd2 < dBig) {
      dBig = pd2;
      nearestBigger = { x: p.x, y: p.y };
    }

    // 只设定目标朝向，实际转身在 _updateCreatures 中按转向速度平滑完成
    if (nearestBigger && (!nearestSmaller || dBig < dSmall * 1.2)) {
      c.targetHeading = Math.atan2(c.y - nearestBigger.y, c.x - nearestBigger.x);
    } else if (nearestSmaller) {
      c.targetHeading = Math.atan2(nearestSmaller.y - c.y, nearestSmaller.x - c.x);
    } else {
      c.targetHeading = c.heading + (this.rng() - 0.5) * CONFIG.aiCruiseTurn;
    }
  }

  // —— AI 互吞（让场景活起来，不给分）—— 空间网格分桶
  _checkCreatureEat() {
    const cell = CONFIG.gridCell;
    const grid = new Map();
    for (const c of this.creatures) {
      if (c.dead) continue;
      const key = Math.floor(c.x / cell) * 65536 + Math.floor(c.y / cell);
      let bucket = grid.get(key);
      if (!bucket) {
        bucket = [];
        grid.set(key, bucket);
      }
      bucket.push(c);
    }
    for (const c of this.creatures) {
      if (c.dead) continue;
      const gx = Math.floor(c.x / cell);
      const gy = Math.floor(c.y / cell);
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const key = (gx + ox) * 65536 + (gy + oy);
          const bucket = grid.get(key);
          if (!bucket) continue;
          for (const o of bucket) {
            if (o === c || o.dead || o.level >= c.level) continue;
            const dx = o.x - c.x;
            const dy = o.y - c.y;
            // AI 互吃同样用视觉半径，与玩家判定一致
            const eatD = (CONFIG.visualRadius + CONFIG.visualRadius) * CONFIG.aiEatDistFactor;
            if (dx * dx + dy * dy <= eatD * eatD) {
              o.dead = true;
              this._emit('ai_eat', { eater_level: c.level, target_level: o.level });
            }
          }
        }
      }
    }
    // 清理
    if (this.creatures.some((c) => c.dead)) {
      this.creatures = this.creatures.filter((c) => !c.dead);
    }
  }

  _maintainPopulation() {
    const target = CONFIG.targetPopulation;
    let spawned = 0;
    // 1) 小鱼保底填充：底层小鱼不足时优先补小鱼（世界始终"活"着，不随等级变空）
    while (spawned < CONFIG.maxSpawnPerTick && this.creatures.length < target && this._countSmall() < CONFIG.minSmallCount) {
      this._spawnAt(this._pickFillerLevel(), null);
      spawned++;
    }
    // 2) 常规补位：总数不足目标只数
    while (spawned < CONFIG.maxSpawnPerTick && this.creatures.length < target) {
      this.spawnCreature();
      spawned++;
    }
    // 3) 天敌保障：场上至少保持高 1 级 × minThreatSameCount、高 2+ 级 × minThreatHigherCount
    // （保证任何等级段玩家都有捕食者，食物链存在感）
    if (this.player.level < MAX_LEVEL - 1) {
      let threat1 = 0;
      let threat2 = 0;
      for (const c of this.creatures) {
        if (c.dead) continue;
        if (c.level === this.player.level + 1) threat1++;
        else if (c.level >= this.player.level + 2) threat2++;
      }
      if (threat1 < CONFIG.minThreatSameCount) {
        this._spawnAt(this.player.level + 1, null);
      }
      if (threat2 < CONFIG.minThreatHigherCount && this.player.level + 2 < MAX_LEVEL) {
        this._spawnAt(this.player.level + 2, null);
      }
    }
  }

  // —— 事件 / 快照 ——
  _emit(type, data) {
    this._events.push({ tick: this.tick, type, ...data });
  }

  // 可见状态（SPEC 2.5）：策略可读 = 玩家能从屏幕推断的
  snapshot() {
    return {
      tick: this.tick,
      score: this.score,
      deaths: this.deaths,
      invulnerableTicks: this.invulnerableTicks,
      player: {
        x: this.player.x,
        y: this.player.y,
        level: this.player.level,
        radius: this.radiusOf(this.player.level),
        heading: this.player.heading,
        progress: this.player.progress,
        animPhase: this.player.animPhase,
      },
      creatures: this.creatures
        .filter((c) => !c.dead)
        .map((c) => ({
          id: c.id,
          x: c.x,
          y: c.y,
          level: c.level,
          radius: this.radiusOf(c.level),
          heading: c.heading,
          animPhase: c.animPhase,
          lunge: c.lungePhase, // 屏幕上可见（蓄势红圈 / 猛冲），属于可见状态
        })),
      bounds: { width: CONFIG.worldWidth, height: CONFIG.worldHeight },
    };
  }
}
