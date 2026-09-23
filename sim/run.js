#!/usr/bin/env node
// 平衡模拟器入口（SPEC Part 2.10）：跑单调策略 + 探索策略，输出四视角遥测报告。
// 用法: node sim/run.js [--policies a,b,c] [--seeds 1,2,3] [--ticks N] [--variants N] [--tag baseline] [--json]
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdapter } from './adapter.js';
import { POLICY_FACTORIES } from './policies.js';
import { aggregateRun, buildReport } from './analyze.js';
import { CONFIG } from '../core/constants.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const opts = {
    policies: ['no_input', 'fixed_direction', 'greedy_nearest_prey', 'greedy_nearest_same', 'exploratory'],
    seeds: [2001, 2002, 2003],
    ticks: 3600,
    variants: 20,
    tag: 'baseline',
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--policies') opts.policies = argv[++i].split(',');
    else if (a === '--seeds') opts.seeds = argv[++i].split(',').map(Number);
    else if (a === '--ticks') opts.ticks = Number(argv[++i]);
    else if (a === '--variants') opts.variants = Number(argv[++i]);
    else if (a === '--tag') opts.tag = argv[++i];
    else if (a === '--json') opts.json = true;
  }
  return opts;
}

// 单局运行：输入由 makeInput(snap) 提供（策略闭包），返回聚合片段
function runOnce(policy, seed, variant, maxTicks, makeInput, collectEvents) {
  const game = createAdapter(seed, { maxTicks });
  const rawEvents = [];
  const scoreAtTicks = [];
  const tickStep = Math.max(1, Math.floor(maxTicks / 6));

  for (let tick = 0; tick < maxTicks; tick++) {
    if (game.ended()) break;
    const snap = game.snapshot();
    const input = makeInput(snap);
    const events = game.step(input);
    if (collectEvents) {
      rawEvents.push({ tick, type: 'input', dx: input.dx, dy: input.dy });
      for (const ev of events) rawEvents.push(ev);
    }
    if (tick % tickStep === 0) scoreAtTicks.push({ tick, score: game.score() });
  }
  scoreAtTicks.push({ tick: game.tick(), score: game.score() });

  const snap = game.snapshot();
  return aggregateRun({
    policy,
    seed,
    variant: variant ?? null,
    score: game.score(),
    elapsed: game.elapsed(),
    ended: game.ended(),
    gameOver: game.isGameOver(),
    deathInfo: game.deathInfo(),
    finalLevel: snap.player.level,
    maxLevelReached: snap.player.level,
    rawEvents,
    scoreAtTicks,
  });
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { policies, seeds, ticks, variants, tag, json } = opts;
  const collectEvents = true; // 基线分析需要完整 raw events

  const runConfig = {
    seed_set: seeds,
    fixed_dt: CONFIG.fixedDt,
    max_ticks: ticks,
    policy_budget: `variants=${variants} per seed for exploratory`,
    input_schema: {
      move_x: { type: 'axis', range: [-1, 1], neutral: 0 },
      move_y: { type: 'axis', range: [-1, 1], neutral: 0 },
    },
    visible_state_schema: ['player_position', 'player_level', 'player_radius', 'progress', 'creatures', 'bounds'],
    policy_visibility: {
      no_input: [],
      fixed_direction: [],
      greedy_nearest_prey: ['player_position', 'creatures'],
      greedy_nearest_same: ['player_position', 'creatures'],
      exploratory: ['player_position', 'player_level', 'player_radius', 'progress', 'creatures', 'bounds'],
    },
  };

  const monotonousRuns = [];
  const exploratoryRuns = [];

  // 单调策略：每个 seed 1 局（每局一个实例，持有锁存状态）
  for (const p of policies) {
    if (p === 'exploratory') continue;
    const factory = POLICY_FACTORIES[p];
    if (!factory) {
      console.error(`未知策略: ${p}`);
      process.exit(1);
    }
    for (const seed of seeds) {
      const instance = factory();
      monotonousRuns.push(runOnce(p, seed, null, ticks, (snap) => instance(snap), collectEvents));
    }
  }

  // 探索策略：每个 seed × variants 局（variant 种子 = seed * 1000 + v，局内固定）
  if (policies.includes('exploratory')) {
    for (const seed of seeds) {
      for (let v = 0; v < variants; v++) {
        const variantSeed = seed * 1000 + v;
        const expFn = POLICY_FACTORIES.exploratory(variantSeed);
        const run = runOnce('exploratory', seed, v, ticks, (snap) => expFn(snap), collectEvents);
        exploratoryRuns.push(run);
      }
    }
  }

  const report = buildReport({ runConfig, monotonousRuns, exploratoryRuns });

  // 写盘
  const outDir = join(__dirname, '..', 'logs', 'balance');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${tag}.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`📄 报告已写入: ${outPath}`);

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printSummary(report, tag);
  }
}

function printSummary(report, tag) {
  const { monotonous, exploratory, exploratory_ratio, telemetry } = report;
  console.log('\n=== 平衡模拟摘要 ===');
  console.log(`标签: ${tag}`);
  console.log('\n单调策略 (每 seed 1 局):');
  for (const [name, c] of Object.entries(monotonous.cases)) {
    console.log(`  ${name.padEnd(22)} score=${String(c.score).padStart(5)} elapsed=${c.elapsed.toFixed(1)}s ended=${c.ended}`);
  }
  console.log(`  max_score = ${monotonous.max_score}`);
  const variants = report.run_config.policy_budget.match(/variants=(\d+)/)?.[1] ?? '?';
  console.log(`\n探索策略 (每 seed × ${variants} 变体):`);
  console.log(`  best score=${exploratory.best.score} elapsed=${exploratory.best.elapsed.toFixed(1)}s seed=${exploratory.best_seed} variant=${exploratory.best_variant}`);
  const ratio = exploratory_ratio === null ? 'N/A (分母为 0)' : exploratory_ratio.toFixed(2);
  console.log(`\nexploratory_ratio = ${ratio}`);

  const d = telemetry.death_analysis;
  const s = telemetry.spawn_analysis;
  const sc = telemetry.scoring_analysis;
  const i = telemetry.input_analysis;
  console.log('\n--- 遥测 ---');
  console.log(`死亡: ${d.total} 次 / 其中 ${d.game_over_runs} 局未活到上限`);
  console.log(`  按玩家等级: ${JSON.stringify(d.by_player_level)}`);
  console.log(`  按捕食者等级: ${JSON.stringify(d.by_predator_level)}`);
  console.log(`  生成安全距离: min=${s.min_dist_to_player?.toFixed(0)}px avg=${s.avg_dist_to_player?.toFixed(0)}px (阈值=玩家半径×${s.safety_factor_applied})`);
  console.log(`  生成等级分布: ${JSON.stringify(s.by_level)}`);
  console.log(`得分构成: ${JSON.stringify(sc.by_reason)}`);
  console.log(`输入(方向改变次数): ${JSON.stringify(
    Object.fromEntries(Object.entries(i.per_policy).map(([k, v]) => [k, v.changes]))
  )}`);
}

main();
