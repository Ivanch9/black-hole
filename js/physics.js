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

// =====================================================================
// Метрика Керра (вращающаяся чёрная дыра), спин a = J/M ∈ (−1, 1), M = 1.
// Координаты Бойера–Линдквиста (r, θ, φ); ось вращения — мировая ось y,
// мировые координаты: x = ρ cos φ, y = r cos θ, z = −ρ sin φ (φ растёт по вращению).
// =====================================================================

export const KERR_SPIN_MAX = 0.998; // предел Торна для аккрецирующих дыр

export function kerrHorizon(a) { return 1 + Math.sqrt(1 - a * a); }

// ISCO (Bardeen, Press, Teukolsky 1972); a > 0 — диск вращается вместе с дырой.
export function kerrISCO(a) {
  const z1 = 1 + Math.cbrt(1 - a * a) * (Math.cbrt(1 + a) + Math.cbrt(1 - a));
  const z2 = Math.sqrt(3 * a * a + z1 * z1);
  return 3 + z2 - Math.sign(a) * Math.sqrt((3 - z1) * (3 + z1 + 2 * z2));
}

// Радиусы экваториальных круговых фотонных орбит.
export function kerrPhotonOrbits(a) {
  return { pro: 2 * (1 + Math.cos(2 / 3 * Math.acos(-a))), retro: 2 * (1 + Math.cos(2 / 3 * Math.acos(a))) };
}

// Корни x³ − 3x + 2a = 0 (x = √r), нужные для потока Пейджа–Торна.
export function ntRoots(a) {
  const t = Math.acos(a);
  return [2 * Math.cos((t - Math.PI) / 3), 2 * Math.cos((t + Math.PI) / 3), -2 * Math.cos(t / 3)];
}

// Поток излучения диска Новикова–Торна (Page & Thorne 1974), без постоянного множителя 3Ṁ/8π.
export function ntFlux(r, a, rin = kerrISCO(a)) {
  if (r <= rin) return 0;
  const x = Math.sqrt(r), x0 = Math.sqrt(rin);
  const [x1, x2, x3] = ntRoots(a);
  const term = (xi, xj, xk) => Math.abs(xi) < 1e-9 ? 0
    : 3 * (xi - a) ** 2 / (xi * (xi - xj) * (xi - xk)) * Math.log(Math.abs((x - xi) / (x0 - xi)));
  const s = x - x0 - 1.5 * a * Math.log(x / x0) - term(x1, x2, x3) - term(x2, x1, x3) - term(x3, x1, x2);
  return Math.max(s, 0) / (x ** 4 * (x ** 3 - 3 * x + 2 * a));
}

export function ntPeak(a, rin = kerrISCO(a)) {
  let best = 0, rb = rin;
  for (let r = rin * 1.0005; r < rin * 30 + 40; r *= 1.0005) {
    const f = ntFlux(r, a, rin);
    if (f > best) { best = f; rb = r; }
  }
  return { r: rb, F: best };
}

// Кеплеровская орбита в экваторе Керра.
export function kerrOrbit(r, a) {
  const sr = Math.sqrt(r), r32 = r * sr;
  const den = Math.pow(r, 0.75) * Math.sqrt(r32 - 3 * sr + 2 * a);
  return {
    omega: 1 / (r32 + a),
    ut: (r32 + a) / den,
    E: (r32 - 2 * sr + a) / den,
    L: (r * r - 2 * a * sr + a * a) / den,
  };
}

// Сферические орты в мировых координатах для (θ, φ).
function sphBasis(th, ph) {
  const s = Math.sin(th), c = Math.cos(th), sp = Math.sin(ph), cp = Math.cos(ph);
  return {
    er: [s * cp, c, -s * sp],
    eth: [c * cp, -s, -c * sp],
    eph: [-sp, 0, -cp],
  };
}

// Начальные условия луча для камеры — локального невращающегося наблюдателя (ZAMO)
// в точке camPos (r = |camPos|, θ, φ из направления), dir — направление взгляда.
// Фотон реально приходит из направления dir, мы трассируем его назад во времени.
export function kerrInitialRay(a, camPos, dir) {
  const r0 = len(camPos);
  const th0 = Math.acos(camPos[1] / r0), ph0 = Math.atan2(-camPos[2], camPos[0]);
  const { er, eth, eph } = sphBasis(th0, ph0);
  const nr = dot(dir, er), nth = dot(dir, eth), nph = dot(dir, eph);
  const s = Math.sin(th0), c = Math.cos(th0), a2 = a * a;
  const S = r0 * r0 + a2 * c * c, D = r0 * r0 - 2 * r0 + a2, A = (r0 * r0 + a2) ** 2 - a2 * D * s * s;
  const om = 2 * a * r0 / A, alpha = Math.sqrt(S * D / A);
  const L = Math.sqrt(A / S) * s * (-nph);           // p_φ реального фотона (локальная энергия = 1)
  const E = alpha + om * L;                          // −p_t
  const pr = Math.sqrt(S / D) * (-nr), pth = Math.sqrt(S) * (-nth);
  const Q = pth * pth + c * c * (L * L / (s * s) - a2 * E * E);
  return {
    E, l: L / E, q: Q / (E * E), alphaCam: alpha,
    // состояние для обратного хода во времени Мино на единицу E: [r, μ, φ, ṙ, μ̇]
    y: [r0, c, ph0, -D * pr / E, s * pth / E],
  };
}

export function kerrR(r, a, l, q) {
  const P = r * r + a * a - a * l;
  return P * P - (r * r - 2 * r + a * a) * ((l - a) ** 2 + q);
}
export function kerrTheta(mu, a, l, q) {
  return q - (q + l * l - a * a) * mu * mu - a * a * mu ** 4;
}

// pole = 0 отключает полюсный член l/sin²θ (внутри полярной шапки он учитывается аналитически).
function kerrDeriv(y, a, l, q, pole = 1) {
  const [r, mu, , rd, mud] = y;
  const a2 = a * a, P = r * r + a2 - a * l, K = (l - a) ** 2 + q;
  const D = Math.max(r * r - 2 * r + a2, 1e-9), s2 = Math.max(1 - mu * mu, 1e-9);
  return [rd, mud, -(a * P / D - a + pole * l / s2), 2 * r * P - (r - 1) * K, -(q + l * l - a2) * mu - 2 * a2 * mu ** 3];
}

// Полярная шапка sin θ < √POLE_CAP. Внутри неё луч проходит мимо оси почти прямолинейно,
// (при обратном ходе знак поворота как у −Φ, т.е. −sign(l))
// и φ поворачивается на acos(d/ρ_вход) + acos(d/ρ_выход), где d = sin θ_min — минимальное
// удаление от оси (корень Θ(μ) = 0). Это убирает сингулярность φ̇ = l/sin²θ координат БЛ.
export const POLE_CAP = 0.001;
export function kerrPoleDistance(a, l, q) {
  const B = q + l * l + a * a;   // Θ как функция X = sin²θ: −l² + B·X − a²X²
  return Math.sqrt(2 * l * l / (B + Math.sqrt(Math.max(B * B - 4 * a * a * l * l, 0))));
}

// Проекция на точные интегралы движения ṙ² = R(r), μ̇² = Θ(μ) вдали от точек поворота:
// иначе абсолютная ошибка, набранная на больших r (где R ~ r⁴), портит траекторию у дыры.
export function kerrProject(y, a, l, q) {
  const r = y[0], sc = (r * r + a * a) ** 2;
  if (y[3] * y[3] > 0.01 * sc) {
    const R = kerrR(r, a, l, q);
    if (R > 0) y[3] = Math.sign(y[3]) * Math.sqrt(R);
  }
  const tsc = q + l * l + a * a;
  if (y[4] * y[4] > 0.01 * tsc) {
    const T = kerrTheta(y[1], a, l, q);
    if (T > 0) y[4] = Math.sign(y[4]) * Math.sqrt(T);
  }
}

// Эталонная трассировка в Керре (тот же алгоритм, что в шейдере с #define KERR).
export function traceKerr(a, init, opts = {}) {
  const stepK = opts.stepK ?? 0.05, maxSteps = opts.maxSteps ?? 20000;
  const rEsc = opts.rEsc ?? Math.max(init.y[0] * 1.05, 60);
  const rin = opts.rin ?? kerrISCO(a), rout = opts.rout ?? 20;
  const rH = kerrHorizon(a);
  const { l, q } = init;
  let y = init.y.slice();
  const hits = [];
  const dPole = kerrPoleDistance(a, l, q), sgnL = l < 0 ? -1 : 1;
  let rhoIn = -1;   // sin θ при входе в полярную шапку (−1 — вне шапки)
  for (let i = 0; i < maxSteps; i++) {
    const [r, mu] = y;
    if (r < rH * 1.01) return { fate: 'captured', hits, steps: i };
    if (r > rEsc && y[3] > 0) {
      const d = kerrDeriv(y, a, l, q);
      const th = Math.acos(Math.max(-1, Math.min(1, mu))), st = Math.sin(th);
      const { er, eth, eph } = sphBasis(th, y[2]);
      const v = add(add(scale(er, y[3]), eth, -r * y[4] / Math.max(st, 1e-6)), eph, r * st * d[2]);
      return { fate: 'escaped', dir: scale(v, 1 / len(v)), hits, steps: i, y };
    }
    const s2 = 1 - mu * mu, inCap = s2 < POLE_CAP;
    // шаг: аффинный ≈ stepK·r, но у полюса поворот по φ за шаг не больше 0.03 рад
    let h = stepK * r / (r * r + a * a * mu * mu);
    // и sin²θ за шаг меняется не более чем на 25% (иначе шаг «перепрыгнет» в шапку)
    if (!inCap) h = Math.min(h, 0.03 * s2 / Math.max(Math.abs(l), 1e-9), 0.12 * s2 / Math.max(Math.abs(y[4] * mu), 1e-9));
    if (inCap && rhoIn < 0) rhoIn = Math.sqrt(s2);
    const pole = inCap ? 0 : 1;
    const k1 = kerrDeriv(y, a, l, q, pole);
    const k2 = kerrDeriv(y.map((v, j) => v + h / 2 * k1[j]), a, l, q, pole);
    const k3 = kerrDeriv(y.map((v, j) => v + h / 2 * k2[j]), a, l, q, pole);
    const k4 = kerrDeriv(y.map((v, j) => v + h * k3[j]), a, l, q, pole);
    const yo = y;
    y = y.map((v, j) => v + h / 6 * (k1[j] + 2 * k2[j] + 2 * k3[j] + k4[j]));
    y[1] = Math.max(-1, Math.min(1, y[1]));
    kerrProject(y, a, l, q);
    if (inCap && 1 - y[1] * y[1] >= POLE_CAP) {   // вышли из шапки — добавляем поворот вокруг оси
      const rhoOut = Math.sqrt(1 - y[1] * y[1]);
      y[2] -= sgnL * (Math.acos(Math.min(1, dPole / rhoIn)) + Math.acos(Math.min(1, dPole / rhoOut)));
      rhoIn = -1;
    }
    if (yo[1] * y[1] < 0) {
      const f = yo[1] / (yo[1] - y[1]);
      const rp = yo[0] + (y[0] - yo[0]) * f;
      if (rp > rin && rp < rout) hits.push({ r: rp, phi: yo[2] + (y[2] - yo[2]) * f });
    }
  }
  return { fate: 'steps', hits, steps: maxSteps, y };
}

// Смещение частоты для газа на кеплеровской орбите радиуса r и фотона (E, l = L/E);
// E нормирована на энергию, измеренную камерой-ZAMO.
export function kerrRedshift(r, a, E, l) {
  const o = kerrOrbit(r, a);
  return 1 / (o.ut * E * (1 - o.omega * l));
}

// Критическая кривая (край тени) для далёкого наблюдателя с наклоном incl (рад):
// Bardeen 1973. Возвращает массив точек [α, β] в единицах M (α — вправо, β — вверх).
export function kerrCriticalCurve(a, incl, n = 400) {
  const si = Math.sin(incl), ci = Math.cos(incl);
  if (Math.abs(a) < 1e-4) {
    return Array.from({ length: n + 1 }, (_, i) => { const t = 2 * Math.PI * i / n; return [B_CRIT * Math.cos(t), B_CRIT * Math.sin(t)]; });
  }
  const { pro, retro } = kerrPhotonOrbits(a);
  const r1 = Math.min(pro, retro), r2 = Math.max(pro, retro);
  const lam = r => -(r ** 3 - 3 * r * r + a * a * r + a * a) / (a * (r - 1));
  const eta = r => -(r ** 3) * (r ** 3 - 6 * r * r + 9 * r - 4 * a * a) / (a * a * (r - 1) ** 2);
  const upper = [];
  for (let i = 0; i <= n; i++) {
    // плотнее у концов, где кривая круто поворачивает
    const t = 0.5 - 0.5 * Math.cos(Math.PI * i / n);
    const r = r1 + (r2 - r1) * t;
    const L = lam(r), b2 = eta(r) + a * a * ci * ci - L * L * (ci * ci) / (si * si);
    if (b2 >= 0) upper.push([-L / si, Math.sqrt(b2)]);
  }
  const lower = upper.slice().reverse().map(([x, y]) => [x, -y]);
  return upper.concat(lower, upper.length ? [upper[0]] : []);
}
