// 确定性随机源：mulberry32
// 游戏内所有随机（生成、AI 转向、挣脱判定、进化奖励）都必须走这里，
// 保证模拟可复现（SPEC Part 2.2）。

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
