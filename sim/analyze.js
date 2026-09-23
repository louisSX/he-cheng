// 遥测聚合（SPEC Part 2.8/2.9）：把单局 raw events 聚合成四视角分析。
import { CONFIG, MAX_LEVEL } from '../core/constants.js';

// 单局聚合：接收一局里收集的 raw events + 局信息，产出该局的聚合片段
export function aggregateRun(run) {
  const agg = {
    policy: run.policy,
    seed: run.seed,
    variant: run.variant ?? null,
    score: run.score,
    elapsed: run.elapsed,
    ended: run.ended,
    gameOver: run.gameOver,
    finalLevel: run.finalLevel,
    maxLevelReached: run.maxLevelReached,
    deaths: [],
    spawns: { byLevel: new Array(MAX_LEVEL).fill(0), minDist: Infinity, maxDist: 0, sumDist: 0, count: 0 },
    scoring: {
      byReason: { prey: { count: 0, sum: 0 }, same: { count: 0, sum: 0 }, evolve: { count: 0, sum: 0 } },
      scoreAtTicks: run.scoreAtTicks || [],
      inputChangesAtDeath: null,
    },
    input: { changes: 0, ticks: 0 },
  };

  let lastInput = null;
  let lastInputsBeforeDeath = [];
  for (const ev of run.rawEvents) {
    switch (ev.type) {
      case 'input':
        agg.input.ticks++;
        if (lastInput && (ev.dx !== lastInput.dx || ev.dy !== lastInput.dy)) {
          agg.input.changes++;
        }
        lastInput = { dx: ev.dx, dy: ev.dy };
        lastInputsBeforeDeath.push(ev);
        if (lastInputsBeforeDeath.length > 3) lastInputsBeforeDeath.shift();
        break;
      case 'spawn': {
        const s = agg.spawns;
        s.byLevel[ev.level]++;
        s.count++;
        s.sumDist += ev.dist_to_player;
        if (ev.dist_to_player < s.minDist) s.minDist = ev.dist_to_player;
        if (ev.dist_to_player > s.maxDist) s.maxDist = ev.dist_to_player;
        break;
      }
      case 'eat':
        agg.scoring.byReason[ev.reason].count++;
        agg.scoring.byReason[ev.reason].sum += ev.score_gain;
        break;
      case 'evolve':
        agg.scoring.byReason.evolve.count++;
        agg.scoring.byReason.evolve.sum += ev.score_gain;
        break;
      case 'death':
        agg.deaths.push(ev);
        agg.scoring.inputChangesAtDeath = lastInputsBeforeDeath.map((i) => i.dx !== 0 || i.dy !== 0);
        break;
      default:
        break;
    }
  }
  agg.spawns.avgDist = agg.spawns.count > 0 ? agg.spawns.sumDist / agg.spawns.count : 0;
  return agg;
}

// 汇总：把多局聚合并成报告 telemetry 四视角（SPEC 2.9）
export function buildTelemetry(runs) {
  const t = {
    death_analysis: {},
    spawn_analysis: {},
    scoring_analysis: {},
    input_analysis: {},
  };

  // death
  const byPlayerLevel = {};
  const byPredatorLevel = {};
  const byCause = {};
  const posGrid = new Array(16).fill(0); // 4x4
  let deathTotal = 0;
  let deathsWithRecentInput = 0;
  const gameOverRuns = runs.filter((r) => r.gameOver);
  for (const r of gameOverRuns) {
    const ds = r.deaths;
    if (!ds || ds.length === 0) continue;
    for (const d of ds) {
      deathTotal++;
      byPlayerLevel[d.player_level] = (byPlayerLevel[d.player_level] ?? 0) + 1;
      byPredatorLevel[d.predator_level] = (byPredatorLevel[d.predator_level] ?? 0) + 1;
      byCause[d.cause] = (byCause[d.cause] ?? 0) + 1;
      const gx = Math.min(3, Math.floor((d.x / CONFIG.worldWidth) * 4));
      const gy = Math.min(3, Math.floor((d.y / CONFIG.worldHeight) * 4));
      posGrid[gy * 4 + gx]++;
    }
    if (r.inputChangesAtDeath && r.inputChangesAtDeath.some(Boolean)) deathsWithRecentInput++;
  }
  t.death_analysis = {
    total: deathTotal,
    game_over_runs: gameOverRuns.length,
    by_player_level: byPlayerLevel,
    by_predator_level: byPredatorLevel,
    by_cause: byCause,
    position_grid_4x4: posGrid,
    deaths_with_recent_input: deathsWithRecentInput,
    death_rate: gameOverRuns.length / (runs.length || 1),
  };

  // spawn
  const byLevel = new Array(MAX_LEVEL).fill(0);
  let count = 0;
  let minDist = Infinity;
  let sumDist = 0;
  let maxDist = 0;
  for (const r of runs) {
    const s = r.spawns;
    for (let i = 0; i < MAX_LEVEL; i++) byLevel[i] += s.byLevel[i];
    count += s.count;
    sumDist += s.sumDist;
    if (s.minDist < minDist) minDist = s.minDist;
    if (s.maxDist > maxDist) maxDist = s.maxDist;
  }
  t.spawn_analysis = {
    total: count,
    by_level: byLevel,
    min_dist_to_player: minDist === Infinity ? null : minDist,
    max_dist_to_player: maxDist,
    avg_dist_to_player: count > 0 ? sumDist / count : null,
    safety_factor_applied: CONFIG.spawnSafetyFactor,
  };

  // scoring
  const reasons = { prey: { count: 0, sum: 0 }, same: { count: 0, sum: 0 }, evolve: { count: 0, sum: 0 } };
  let totalScore = 0;
  for (const r of runs) {
    for (const k of Object.keys(reasons)) {
      reasons[k].count += r.scoring.byReason[k].count;
      reasons[k].sum += r.scoring.byReason[k].sum;
    }
    totalScore += r.score;
  }
  t.scoring_analysis = {
    total_score_all_runs: totalScore,
    by_reason: reasons,
    scoring_routes: Object.values(reasons).filter((v) => v.count > 0).length,
    score_is_input_fact: false, // 设计保证：分数只来自 eat/evolve 因果事件
  };

  // input
  const byPolicy = {};
  for (const r of runs) {
    if (!byPolicy[r.policy]) byPolicy[r.policy] = { changes: 0, ticks: 0, runs: 0 };
    byPolicy[r.policy].changes += r.input.changes;
    byPolicy[r.policy].ticks += r.input.ticks;
    byPolicy[r.policy].runs++;
  }
  t.input_analysis = {
    per_policy: byPolicy,
  };

  return t;
}

// 组装最终报告 JSON（遵循 log-contract.md 结构）
export function buildReport({ runConfig, monotonousRuns, exploratoryRuns }) {
  const monoCases = {};
  let monoMax = -Infinity;
  for (const r of monotonousRuns) {
    // 同策略多 seed 取最大分（与 exploratory 取 best 的口径一致）
    const cur = monoCases[r.policy];
    if (!cur || r.score > cur.score) {
      monoCases[r.policy] = { score: r.score, elapsed: r.elapsed, ended: r.ended };
    }
    if (r.score > monoMax) monoMax = r.score;
  }
  const bestExp = exploratoryRuns.reduce((b, r) => (r.score > b.score ? r : b), { score: -Infinity });
  const telemetry = buildTelemetry([...monotonousRuns, ...exploratoryRuns]);

  const report = {
    version: '1.0',
    timestamp_utc: new Date().toISOString(),
    run_config: runConfig,
    monotonous: {
      cases: monoCases,
      max_score: monoMax === -Infinity ? 0 : monoMax,
    },
    exploratory: {
      best: { score: bestExp.score === -Infinity ? 0 : bestExp.score, elapsed: bestExp.elapsed ?? 0, ended: bestExp.ended ?? true },
      best_seed: bestExp.seed ?? null,
      best_variant: bestExp.variant ?? null,
    },
    exploratory_ratio: null, // 下方计算
    telemetry,
  };

  const m = report.monotonous.max_score;
  const e = report.exploratory.best.score;
  if (m > 0) report.exploratory_ratio = e / m;
  else if (m === 0 && e === 0) report.exploratory_ratio = 1.0; // 显式约定：双方均为 0 记为 1.0（无差异）
  else report.exploratory_ratio = null; // m=0, e>0 → 无法除，分析中说明
  return report;
}
