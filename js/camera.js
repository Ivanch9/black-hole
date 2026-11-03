// Орбитальная камера вокруг чёрной дыры. Диск лежит в плоскости y = 0.
// state.incl — наклон (угол между осью вращения диска и лучом зрения), градусы:
//   0° — вид сверху, 90° — строго с ребра.
export const LIMITS = { inclMin: 0.5, inclMax: 179.5, distMin: 8, distMax: 150 };

export const PRESETS = {
  edge: { incl: 85, label: 'С ребра (85°)' },
  m87: { incl: 17, label: 'M87* (17°)' },
  i60: { incl: 60, label: 'Наклон 60°' },
  top: { incl: 0.5, label: 'Сверху (0°)' },
};

export function cameraBasis(state) {
  const th = state.incl * Math.PI / 180, ph = state.azim * Math.PI / 180, D = state.dist;
  const pos = [D * Math.sin(th) * Math.cos(ph), D * Math.cos(th), D * Math.sin(th) * Math.sin(ph)];
  const fwd = pos.map(c => -c / D);
  // right = fwd × up(0,1,0)
  let right = [-fwd[2], 0, fwd[0]];
  const rl = Math.hypot(right[0], right[2]) || 1;
  right = right.map(c => c / rl);
  const up = [
    right[1] * fwd[2] - right[2] * fwd[1],
    right[2] * fwd[0] - right[0] * fwd[2],
    right[0] * fwd[1] - right[1] * fwd[0],
  ];
  return { pos, fwd, right, up };
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function attachControls(canvas, state, onChange) {
  const pointers = new Map();
  let pinchDist = 0;

  canvas.addEventListener('pointerdown', e => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    }
  });
  canvas.addEventListener('pointermove', e => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (pointers.size === 1) {
      const k = 0.25 * state.fov / 50;
      state.azim = ((state.azim - dx * k) % 360 + 360) % 360;
      state.incl = clamp(state.incl - dy * k, LIMITS.inclMin, LIMITS.inclMax);
      onChange();
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDist > 0) {
        state.dist = clamp(state.dist * pinchDist / d, LIMITS.distMin, LIMITS.distMax);
        onChange();
      }
      pinchDist = d;
    }
  });
  const up = e => { pointers.delete(e.pointerId); pinchDist = 0; };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    state.dist = clamp(state.dist * Math.exp(e.deltaY * 0.001), LIMITS.distMin, LIMITS.distMax);
    onChange();
  }, { passive: false });
}
