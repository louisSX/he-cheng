// 输入采集（SPEC 1.4/2.4）：鼠标 / 键盘 WASD / 触摸 → 统一 {dx, dy} 方向轴。
// 优先级：键盘按下 > 触摸拖动 > 鼠标悬停指向。渲染层只认方向轴，core 无感知设备。
export function createInput(canvas) {
  const kbMap = {
    KeyW: [0, -1], KeyS: [0, 1], KeyA: [-1, 0], KeyD: [1, 0],
    ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
  };
  const keys = new Set();
  let mouseX = 0;
  let mouseY = 0;
  let mouseOver = false;
  let touchActive = false;
  let touchX = 0;
  let touchY = 0;

  window.addEventListener('keydown', (e) => {
    if (kbMap[e.code]) {
      keys.add(e.code);
      e.preventDefault();
    }
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  canvas.addEventListener('mousemove', (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
    mouseOver = true;
  });
  canvas.addEventListener('mouseleave', () => {
    mouseOver = false;
  });
  canvas.addEventListener(
    'touchstart',
    (e) => {
      touchActive = true;
      const t = e.touches[0];
      touchX = t.clientX;
      touchY = t.clientY;
      e.preventDefault();
    },
    { passive: false }
  );
  canvas.addEventListener(
    'touchmove',
    (e) => {
      const t = e.touches[0];
      touchX = t.clientX;
      touchY = t.clientY;
      e.preventDefault();
    },
    { passive: false }
  );
  canvas.addEventListener('touchend', () => {
    touchActive = false;
  });

  // 返回 {dx, dy, source} 或 null（无输入 → core 保持当前航向）
  function direction(playerWorldX, playerWorldY, camera) {
    // 1) 键盘优先
    let vx = 0;
    let vy = 0;
    for (const code of keys) {
      const [kx, ky] = kbMap[code];
      vx += kx;
      vy += ky;
    }
    if (vx || vy) {
      const l = Math.hypot(vx, vy);
      return { dx: vx / l, dy: vy / l, source: 'keyboard' };
    }
    // 2) 触摸（手指位置指向）
    if (touchActive) {
      const wx = camera.screenToWorldX(touchX);
      const wy = camera.screenToWorldY(touchY);
      return steerTo(playerWorldX, playerWorldY, wx, wy, 'touch');
    }
    // 3) 鼠标悬停指向
    if (mouseOver) {
      const wx = camera.screenToWorldX(mouseX);
      const wy = camera.screenToWorldY(mouseY);
      return steerTo(playerWorldX, playerWorldY, wx, wy, 'mouse');
    }
    return null;
  }

  return { direction };
}

function steerTo(px, py, tx, ty, source) {
  const dx = tx - px;
  const dy = ty - py;
  const l = Math.hypot(dx, dy);
  if (l < 1) return null;
  return { dx: dx / l, dy: dy / l, source };
}
