// 纯游戏逻辑（SPEC Part 2.1）：无渲染依赖，Node 可跑，确定性，可播种。
// 只有因果事件才计分（吃/进化），绝不按输入事实计分（SPEC 2.11 门槛）。

import { CONFIG, EVOLUTION, MAX_LEVEL, MAX_PLAYER_LEVEL } from './constants.js';
import { mulberry32 } from './rng.js';

const D2R = Math.PI / 180;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

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
      const c = {
        id: this._nextCreatureId++,
        x,
        y,
        level,
        heading: this.rng() * Math.PI * 2,
        nextDecision: this.tick + 30 + Math.floor(this.rng() * 60),
        escapeCooldown: 0,
        escapeBoost: 0,
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
    const speed = this.playerSpeed();
    p.x += Math.cos(p.heading) * speed * CONFIG.fixedDt;
    p.y += Math.sin(p.heading) * speed * CONFIG.fixedDt;
    const r = this.radiusOf(p.level);
    p.x = clamp(p.x, r, CONFIG.worldWidth - r);
    p.y = clamp(p.y, r, CONFIG.worldHeight - r);
    p.animPhase += 0.04 + speed * 0.0003; // 游动摆尾相位（渲染层据此画摇摆）
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
      if (c.dead) continue;
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

  _escape(c) {
    const ang = this.rng() * Math.PI * 2;
    const dist = CONFIG.escapeDist[0] + this.rng() * (CONFIG.escapeDist[1] - CONFIG.escapeDist[0]);
    c.x += Math.cos(ang) * dist;
    c.y += Math.sin(ang) * dist;
    c.escapeCooldown = CONFIG.escapeCooldown;
    c.escapeBoost = CONFIG.escapeBoostTicks;
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
    for (const c of this.creatures) {
      if (c.dead) continue;
      c.escapeCooldown = Math.max(0, c.escapeCooldown - 1);
      c.escapeBoost = Math.max(0, c.escapeBoost - 1);
      if (this.tick >= c.nextDecision) {
        this._decideCreature(c);
        c.nextDecision = this.tick + CONFIG.aiTurnInterval[0] + Math.floor(this.rng() * (CONFIG.aiTurnInterval[1] - CONFIG.aiTurnInterval[0]));
      }
      const speed = this.creatureSpeed(c) * (c.escapeBoost > 0 ? CONFIG.escapeBoostFactor : 1);
      c.x += Math.cos(c.heading) * speed * CONFIG.fixedDt;
      c.y += Math.sin(c.heading) * speed * CONFIG.fixedDt;
      // 边界反弹
      const r = this.radiusOf(c.level);
      if (c.x < r) { c.x = r; c.heading = Math.PI - c.heading; }
      else if (c.x > CONFIG.worldWidth - r) { c.x = CONFIG.worldWidth - r; c.heading = Math.PI - c.heading; }
      if (c.y < r) { c.y = r; c.heading = -c.heading; }
      else if (c.y > CONFIG.worldHeight - r) { c.y = CONFIG.worldHeight - r; c.heading = -c.heading; }
      c.animPhase += 0.04 + speed * 0.0003; // 游动摆尾相位（渲染层据此画摇摆）
    }
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

    if (nearestBigger && (!nearestSmaller || dBig < dSmall * 1.2)) {
      c.heading = Math.atan2(c.y - nearestBigger.y, c.x - nearestBigger.x);
    } else if (nearestSmaller) {
      c.heading = Math.atan2(nearestSmaller.y - c.y, nearestSmaller.x - c.x);
    } else {
      c.heading += (this.rng() - 0.5) * CONFIG.aiCruiseTurn;
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
        })),
      bounds: { width: CONFIG.worldWidth, height: CONFIG.worldHeight },
    };
  }
}
