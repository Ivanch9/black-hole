// Физическое ядро: чёрнотельные цвета, профиль температуры диска,
// эталонная (CPU) трассировка лучей в метрике Шварцшильда.
// Единицы: G = c = M = 1. Горизонт r = 2, фотонная сфера r = 3, ISCO r = 6.
// Модуль не использует DOM — его же проверяют тесты в Node.

// ---------- Цвет абсолютно чёрного тела ----------

// Аналитическая аппроксимация функций цветового соответствия CIE 1931
// (Wyman, Sloan, Shirley 2013, multi-lobe fit).
function lobe(l, mu, s1, s2) {
  const t = (l - mu) / (l < mu ? s1 : s2);
  return Math.exp(-0.5 * t * t);
}
function cieX(l) { return 1.056 * lobe(l, 599.8, 37.9, 31.0) + 0.362 * lobe(l, 442.0, 16.0, 26.7) - 0.065 * lobe(l, 501.1, 20.4, 26.2); }
function cieY(l) { return 0.821 * lobe(l, 568.8, 46.9, 40.5) + 0.286 * lobe(l, 530.9, 16.3, 31.1); }
function cieZ(l) { return 1.217 * lobe(l, 437.0, 11.8, 36.0) + 0.681 * lobe(l, 459.0, 26.0, 13.8); }

const C2 = 1.4387769e-2; // hc/k, м·К

// Спектральная яркость Планка (без постоянного множителя 2hc², он уходит в нормировку).
function planck(lambdaNm, T) {
  const l = lambdaNm * 1e-9;
  const x = C2 / (l * T);
  if (x > 700) return 0;
  return 1 / (Math.pow(l, 5) * Math.expm1(x));
}

// XYZ (без нормировки) для чёрного тела температуры T.
export function blackbodyXYZ(T) {
  let X = 0, Y = 0, Z = 0;
  for (let l = 380; l <= 780; l += 2) {
    const b = planck(l, T);
    X += b * cieX(l); Y += b * cieY(l); Z += b * cieZ(l);
  }
  return [X, Y, Z];
}

export function xyzToLinearSRGB([X, Y, Z]) {
  return [
    3.2406 * X - 1.5372 * Y - 0.4986 * Z,
    -0.9689 * X + 1.8758 * Y + 0.0415 * Z,
    0.0557 * X - 0.2040 * Y + 1.0570 * Z,
  ];
}

export const LUT_TMIN = 500;
export const LUT_TMAX = 100000;
export const LUT_SIZE = 1024;

// Таблица: линейный sRGB чёрного тела, логарифмическая шкала T.
// Абсолютная яркость сохранена (нормировка: Y(6500 K) = 1), поэтому
// при смещении частоты T → g·T автоматически меняются и цвет, и яркость.
export function makeBlackbodyLUT() {
  const Y6500 = blackbodyXYZ(6500)[1];
  const data = new Float32Array(LUT_SIZE * 4);
  const a = Math.log(LUT_TMIN), b = Math.log(LUT_TMAX);
  for (let i = 0; i < LUT_SIZE; i++) {
    const T = Math.exp(a + (b - a) * i / (LUT_SIZE - 1));
    const xyz = blackbodyXYZ(T).map(v => v / Y6500);
    let rgb = xyzToLinearSRGB(xyz);
    // Вне гамута sRGB (глубокий красный) — мягкая десатурация к допустимому цвету.
    const m = Math.min(rgb[0], rgb[1], rgb[2]);
    if (m < 0) rgb = rgb.map(v => v - m);
    data[i * 4] = rgb[0]; data[i * 4 + 1] = rgb[1]; data[i * 4 + 2] = rgb[2]; data[i * 4 + 3] = 1;
  }
  return data;
}

// ---------- Аккреционный диск ----------

export const R_HORIZON = 2;
export const R_PHOTON = 3;
export const R_ISCO = 6;
export const B_CRIT = Math.sqrt(27);

// Профиль температуры тонкого диска с нулевым моментом сил на ISCO
// (Шакура–Сюняев / Пейдж–Торн в ньютоновском пределе): T ∝ r^-3/4 (1 - √(r_in/r))^1/4.
export function diskTempShape(r, rin = R_ISCO) {
  if (r <= rin) return 0;
  return Math.pow(r, -0.75) * Math.pow(1 - Math.sqrt(rin / r), 0.25);
}

// Максимум профиля (для нормировки T_max). Аналитически r = (49/36)·r_in.
export function diskTempPeak(rin = R_ISCO) {
  return { r: 49 / 36 * rin, f: diskTempShape(49 / 36 * rin, rin) };
}

// Полный фактор смещения частоты g = ν_набл/ν_изл для вещества на круговой
// кеплеровской орбите радиуса r, фотона с удельным моментом bY = L_z/E
// и статического наблюдателя на радиусе rObs:
//   g = √(1 - 3/r) / (1 - Ω·bY) / √(1 - 2/rObs),  Ω = r^-3/2.
export function redshiftFactor(r, bY, rObs = Infinity) {
  const om = Math.pow(r, -1.5);
  const gObs = isFinite(rObs) ? 1 / Math.sqrt(1 - 2 / rObs) : 1;
  return Math.sqrt(1 - 3 / r) / (1 - om * bY) * gObs;
}

// ---------- Эталонная трассировка лучей ----------
// Траектория фотона в плоскости орбиты эквивалентна движению в декартовых
// координатах под действием a = -3 h² x / r⁵ (h = |x × v|): это даёт ровно
// уравнение Бине u'' + u = 3u² (геодезические Шварцшильда). Интегрируем RK4
// с шагом, пропорциональным r. Тот же алгоритм реализован в шейдере.

function accel(x, A) {
  const r2 = x[0] * x[0] + x[1] * x[1] + x[2] * x[2];
  const k = A / (r2 * r2 * Math.sqrt(r2));
  return [x[0] * k, x[1] * k, x[2] * k];
}
const add = (a, b, s) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = a => Math.sqrt(dot(a, a));
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];

// Перевод направления, измеренного статическим наблюдателем в точке x0,
// в «координатное» направление для интегратора. Возвращает {v, b, bY}.
export function initialRay(x0, dirLocal) {
  const r0 = len(x0), u0 = 1 / r0;
  const rh = scale(x0, u0);
  const dr = dot(dirLocal, rh);
  const t = add(dirLocal, rh, -dr);
  const st = len(t);
  const sc = st / Math.sqrt((1 - 2 * u0) + 2 * u0 * st * st);
  const cc = (dr >= 0 ? 1 : -1) * Math.sqrt(Math.max(1 - sc * sc, 0));
  const v = st > 1e-12 ? add(scale(rh, cc), t, sc / st) : scale(rh, dr >= 0 ? 1 : -1);
  const b = r0 * st / Math.sqrt(1 - 2 * u0);
  const h = cross(x0, v), hl = len(h);
  // Луч трассируется назад во времени, поэтому момент реального фотона — с минусом.
  const bY = hl > 1e-12 ? -b * h[1] / hl : 0;
  return { v, b, bY };
}

// Трассирует луч. opts: {stepK, maxSteps, rEsc, rin, rout}.
// Возвращает {fate: 'escaped'|'captured'|'steps', dir, hits:[{p, r}], steps}.
export function traceRay(x0, v0, opts = {}) {
  const stepK = opts.stepK ?? 0.05;
  const maxSteps = opts.maxSteps ?? 5000;
  const rEsc = opts.rEsc ?? Math.max(len(x0) * 1.05, 60);
  const rin = opts.rin ?? R_ISCO, rout = opts.rout ?? 20;
  let x = x0.slice(), v = v0.slice();
  const h = cross(x, v);
  const A = -3 * dot(h, h);
  const hits = [];
  for (let i = 0; i < maxSteps; i++) {
    const r = len(x);
    if (r < 2.0005) return { fate: 'captured', hits, steps: i };
    if (r > rEsc && dot(x, v) > 0) return { fate: 'escaped', dir: scale(v, 1 / len(v)), hits, steps: i };
    const dt = stepK * r;
    const k1x = v, k1v = accel(x, A);
    const k2x = add(v, k1v, dt / 2), k2v = accel(add(x, k1x, dt / 2), A);
    const k3x = add(v, k2v, dt / 2), k3v = accel(add(x, k2x, dt / 2), A);
    const k4x = add(v, k3v, dt), k4v = accel(add(x, k3x, dt), A);
    const xo = x;
    x = [0, 1, 2].map(j => x[j] + dt / 6 * (k1x[j] + 2 * k2x[j] + 2 * k3x[j] + k4x[j]));
    v = [0, 1, 2].map(j => v[j] + dt / 6 * (k1v[j] + 2 * k2v[j] + 2 * k3v[j] + k4v[j]));
    if (xo[1] * x[1] < 0) {
      const f = xo[1] / (xo[1] - x[1]);
      const p = add(xo, add(x, xo, -1), f);
      const rp = len(p);
      if (rp > rin && rp < rout) hits.push({ p, r: rp });
    }
  }
  return { fate: 'steps', hits, steps: maxSteps };
}
