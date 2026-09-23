// 游戏适配器（SPEC Part 2.3）：模拟器对 core 的薄封装。
import { Game } from '../core/game.js';
import { CONFIG } from '../core/constants.js';

export function createAdapter(seed, { maxTicks } = {}) {
  const game = new Game(seed);
  return {
    step(inputFrame) {
      return game.step(inputFrame);
    },
    score: () => game.score,
    elapsed: () => game.tick * CONFIG.fixedDt,
    ended: () => game.gameOver || game.tick >= maxTicks,
    tick: () => game.tick,
    isGameOver: () => game.gameOver,
    deathInfo: () => game.deathInfo,
    snapshot: () => game.snapshot(),
  };
}
