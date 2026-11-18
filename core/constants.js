// 玩法常量：渲染层与模拟层共用这一份（SPEC Part 2.1 硬性约束，禁止两处各写一份）。

// 进化链：10 级，3 合 1（SPEC 1.3）。radius = 直径 / 2。
// 尺寸曲线：前 4 级（新手期）保持原尺寸，第 5 级起用 1.22 缓等比增长；
// 鲸鱼/青龙/红龙再缩一圈（用户反馈高级段仍拥挤，2026-08-06）。
export const EVOLUTION = [
  { name: '蝌蚪', radius: 10 },   // 直径 20
  { name: '青蛙', radius: 16 },   // 32
  { name: '龙虾', radius: 24 },   // 48
  { name: '鲤鱼', radius: 29 },   // 58
  { name: '乌龟', radius: 35 },   // 70
  { name: '鳄鱼', radius: 43 },   // 86
  { name: '鲨鱼', radius: 52 },   // 104
  { name: '鲸鱼', radius: 56 },   // 112
  { name: '青龙', radius: 68 },   // 136
  { name: '红龙', radius: 82 },   // 164
  { name: '深海巨兽', radius: 100 }, // 直径 200（链外传奇捕食者：玩家不可进化，永远比红龙大）
];
export const MAX_LEVEL = EVOLUTION.length;

// 游动步态（按 level，与 EVOLUTION 下标一致）：划水节奏驱动真实速度起伏，渲染层动画同步读取。
//   freq  : 动画/划水频率（相位倍率，渲染关键帧也用此值）
//   beats : 每个动画循环内的发力次数（摆尾类左右各一次 = 2）
//   peak  : 发力峰值在单拍内的位置（0..1，对齐关键帧里的蹬水/摆尾过中线）
//   width : 发力脉冲宽度（越小越短促）
//   amp   : 速度起伏幅度（均值恒为 1，平均速度不变，平衡不受步态影响）
//   turnDeg: AI 每 tick 最大转向角（度）；体型越大转身越慢
export const GAIT = [
  { freq: 1.35, beats: 2, peak: 0.50, width: 0.14, amp: 0.25, turnDeg: 6.0 }, // 蝌蚪：左右摆尾，轻微脉动
  { freq: 1.05, beats: 1, peak: 0.40, width: 0.12, amp: 0.90, turnDeg: 5.0 }, // 青蛙：蹬水猛冲 → 滑行
  { freq: 1.15, beats: 1, peak: 0.45, width: 0.12, amp: 0.60, turnDeg: 4.5 }, // 龙虾：泳足划动
  { freq: 0.95, beats: 2, peak: 0.50, width: 0.16, amp: 0.20, turnDeg: 4.0 }, // 鲤鱼
  { freq: 0.72, beats: 1, peak: 0.45, width: 0.18, amp: 0.50, turnDeg: 3.0 }, // 乌龟：前鳍慢划
  { freq: 0.82, beats: 2, peak: 0.50, width: 0.18, amp: 0.15, turnDeg: 2.8 }, // 鳄鱼
  { freq: 1.55, beats: 2, peak: 0.50, width: 0.20, amp: 0.12, turnDeg: 3.2 }, // 鲨鱼：稳定巡航
  { freq: 0.78, beats: 1, peak: 0.50, width: 0.20, amp: 0.30, turnDeg: 1.8 }, // 鲸鱼：尾鳍拍水
  { freq: 0.70, beats: 2, peak: 0.50, width: 0.20, amp: 0.12, turnDeg: 2.2 }, // 青龙：S 波
  { freq: 0.58, beats: 2, peak: 0.50, width: 0.20, amp: 0.12, turnDeg: 2.0 }, // 红龙
  { freq: 0.66, beats: 1, peak: 0.50, width: 0.16, amp: 0.35, turnDeg: 1.6 }, // 深海巨兽：触手喷射
];
export const MAX_PLAYER_LEVEL = 10; // 玩家进化上限（红龙）；深海巨兽是链外威胁

export const CONFIG = {
  // 世界
  worldWidth: 2000,
  worldHeight: 2000,

  // 固定步进（SPEC Part 2.4）
  fixedDt: 1 / 60,

  // 玩家游动
  baseSpeed: 120,        // px/s 基础速度
  speedPerLevel: 10,     // 每级 +10 px/s
  turnRateDeg: 5,        // 每 tick 最大转向（度）≈ 300°/s

  // 吞噬判定（SPEC 1.5）
  eatDistFactor: 1.0,    // 碰撞距离 = (r1 + r2)，碰到即吃
  visualRadius: 24,      // 所有生物统一视觉半径（直径 48px）。碰撞判定也用此值，
                         // 保证"视觉接触 = 碰撞触发"（用户反馈"没碰上就被吃" 2026-08-06）
  preyScore: 1,          // 吃低级
  sameScore: 2,          // 吃同级
  evolveScore: 5,        // 进化奖励（SPEC 1.8）
  progressPerPrey: 0.1,  // 吃低级 +0.1 进度（0..3 刻度）
  progressPerSame: 1.0,  // 吃同级 +1
  progressToEvolve: 3.0, // 进度满 3 → 进化

  // 同级互吃（SPEC 1.5）：会挣脱，小概率跑掉
  escapeChance: 0.3,     // 挣脱概率
  escapeCooldown: 90,    // 挣脱后多少 tick 内不会再次挣脱（期间被追上即被吃）
  escapeSlipTicks: 30,   // 挣脱瞬间的滑脱窗口：该时段内与玩家接触不判定（替代原瞬移弹开）
  escapeBoostFactor: 1.35, // 挣脱后短暂加速逃跑
  escapeBurst: 2.0,      // 挣脱爆发额外倍率，按 (剩余/总时长)^3 衰减 → 起步猛冲后回落
  escapeBoostTicks: 120,
  escapeTurnFactor: 3,   // 挣脱冲刺期间转向速度倍率（快速掉头逃离）
  escapeJitter: 1.2,     // 逃离方向随机偏角幅度（弧度）

  // 进化奖励：小概率生成低级素材辅助下一阶段起手（SPEC 1.6 可选）
  evolveSpawnChance: 0.2,
  evolveSpawnDist: [300, 500],

  // 场景生成（SPEC 1.7）
  // 生物总量按"只数"管理（视觉统一 48px 后，拥挤只取决于只数，不再取决于等级体积）。
  // 场上只数不足 targetPopulation 时补位；minSmallCount 保证底层小鱼填充（世界不随等级变空）。
  targetPopulation: 80,
  minSmallCount: 25,     // 场上至少保留的低级小鱼数（等级 ≤ max(0, 玩家-2)）
  spawnMinGapFactor: 1.6, // 生成最小间距：距最近生物 ≥ 目标半径*该系数 + 最近生物半径
  spawnSafetyFactor: 3,   // 候选点距玩家 ≥ 玩家半径 * factor + 目标半径
  spawnAttempts: 20,
  maxSpawnPerTick: 3,    // 每 tick 最多补充几只（生成节奏）
  // 天敌保障：场上至少保持 N 只比玩家高 1 级 / 高 2+ 级（食物链存在感，SPEC 1.7）
  minThreatSameCount: 3,   // 高 1 级的天敌最低数量
  minThreatHigherCount: 1, // 高 2+ 级的天敌最低数量
  // 等级相对权重（相对玩家等级 L）：m2=低2级 … p3=高3级
  // p2/p3 仅在玩家中后期解锁（防新手期被秒），权重乘子 g(L) 见 game.js
  levelWeights: { m2: 0.20, m1: 0.30, m0: 0.25, p1: 0.15, p2: 0.07, p3: 0.03 },
  highThreatGainStart: 3, // L >= 3 开始解锁高 2 级威胁
  highThreatGainFull: 8,  // L >= 8 全量

  // AI 行为
  // 速度梯度（食物链结构）：低级猎物明显慢（轻松追上），同级略慢（努力能追上），
  // 高级捕食者明显更快（逃不掉）。相对玩家等级取系数。
  speedDiffFactors: { '-2': 0.55, '-1': 0.70, '0': 0.85, '1': 1.10, '2': 1.18, '3': 1.25 },
  aiChaseDist: 260,        // AI 追击更小生物的距离
  aiFleeDist: 320,         // AI 逃离更大生物/玩家的距离
  aiTurnInterval: [120, 300], // AI 决策间隔 tick 区间
  aiCruiseTurn: 0.5,       // 巡航随机转向弧度幅度
  aiWallMargin: 80,        // 距边界该距离内且朝向墙 → 提前转向离墙（平滑转身替代瞬间反弹）

  // 捕食者扑击（真实捕食行为）：比玩家大的生物近距离时 蓄势 → 猛冲追踪 → 冷却。
  // 平滑转向让捕食者变钝后，靠扑击把危险感补回来；蓄势期有红圈预警，保证死亡可读（SPEC 2.11）。
  lungeMinPlayerLevel: 2,  // 玩家 ≥ 该等级（Lv.3 龙虾）才会被扑击：新手期（蝌蚪/青蛙）不启用，防开局被秒
  lungeDist: 170,          // 触发距离（中心距 px）
  lungeWindupTicks: 21,    // 蓄势时长（0.35s，高于人类约 0.25s 反应时间）：减速 + 快速对准玩家
  lungeWindupSpeed: 0.55,  // 蓄势期速度倍率
  lungeStrikeTicks: 30,    // 猛冲时长（0.5s）：持续追踪玩家
  lungeStrikeBoost: 1.9,   // 猛冲起步速度倍率，按 (剩余/总时长)^2 衰减回 1
  lungeTurnFactor: 3,      // 蓄势/猛冲期间转向速度倍率
  lungeCooldownTicks: 180, // 扑击结束后冷却（3s）

  // AI 互吞（让场景活起来）：只吃比自己至少低 1 级，不给分
  gridCell: 180,           // 空间网格边长（AI 互吞碰撞用）
  aiEatDistFactor: 0.72,   // 互吃距离 = (r1+r2)*factor；0.72 需更贴近才吃（减缓生物消耗，场上存量更多）
};
