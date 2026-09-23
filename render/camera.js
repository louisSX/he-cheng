// 相机：跟随玩家 + 随体型缩放（成长时视野拉远，agar.io 式）。
export function createCamera(viewW, viewH) {
  let x = 0;
  let y = 0;
  let scale = 1.9;

  function follow(px, py, radius, worldW, worldH, dt) {
    // 目标缩放：玩家越大看得越远。上限 1.85、下限 0.8（高级段视野大幅拉远，缓解拥挤）
    const targetScale = Math.max(0.8, Math.min(1.85, 1.85 - (radius - 10) * 0.006));
    scale += (targetScale - scale) * Math.min(1, dt * 2);

    // 平滑跟随
    const tx = px;
    const ty = py;
    x += (tx - x) * Math.min(1, dt * 5);
    y += (ty - y) * Math.min(1, dt * 5);

    // 钳制在世界内（避免露黑边）：可见半宽 = viewW/2/scale
    const halfW = viewW / 2 / scale;
    const halfH = viewH / 2 / scale;
    if (worldW > viewW / scale) x = Math.min(worldW - halfW, Math.max(halfW, x));
    else x = worldW / 2;
    if (worldH > viewH / scale) y = Math.min(worldH - halfH, Math.max(halfH, y));
    else y = worldH / 2;
  }

  // 应用世界变换：世界坐标 → 屏幕
  function apply(ctx) {
    ctx.setTransform(scale, 0, 0, scale, viewW / 2 - x * scale, viewH / 2 - y * scale);
  }

  function screenToWorldX(sx) {
    return (sx - viewW / 2) / scale + x;
  }
  function screenToWorldY(sy) {
    return (sy - viewH / 2) / scale + y;
  }

  return {
    follow,
    apply,
    screenToWorldX,
    screenToWorldY,
    get scale() { return scale; },
    get x() { return x; },
    get y() { return y; },
  };
}
