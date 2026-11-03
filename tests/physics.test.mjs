// Проверка физики на CPU тем же алгоритмом, что и в шейдере.
// Запуск: node tests/physics.test.mjs
import {
  initialRay, traceRay, redshiftFactor, diskTempPeak, diskTempShape,
  makeBlackbodyLUT, blackbodyXYZ, xyzToLinearSRGB, B_CRIT, LUT_SIZE,
  kerrHorizon, kerrISCO, kerrPhotonOrbits, ntRoots, ntFlux, ntPeak, kerrOrbit,
  kerrInitialRay, traceKerr, kerrR, kerrTheta, kerrRedshift, kerrCriticalCurve,
} from '../js/physics.js';

let failed = 0;
function check(name, ok, info) {
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`);
  if (!ok) failed++;
}
const relErr = (a, b) => Math.abs(a - b) / Math.abs(b);

// Пресеты качества (должны совпадать с js/main.js).
const QUALITY = { low: 0.1, medium: 0.07, high: 0.05, ultra: 0.035 };

// 1. Критический прицельный параметр (край тени) b_c = √27 M.
//    Камера далеко, ищем бисекцией границу захвата.
function criticalB(stepK) {
  const D = 1000;
  let lo = 4, hi = 7;
  for (let i = 0; i < 40; i++) {
    const b = (lo + hi) / 2;
    const v = [-Math.sqrt(1 - (b / D) ** 2), b / D, 0]; // координатное направление, h = b
    const res = traceRay([D, 0, 0], v, { stepK, maxSteps: 20000, rout: 0 });
    if (res.fate === 'captured') lo = b; else hi = b;
  }
  return (lo + hi) / 2;
}
for (const [q, k] of Object.entries(QUALITY)) {
  const bc = criticalB(k);
  check(`Радиус тени (${q}, шаг ${k}r)`, relErr(bc, B_CRIT) < 0.005, `b_c = ${bc.toFixed(4)} M, теория √27 = ${B_CRIT.toFixed(4)} M, ошибка ${(relErr(bc, B_CRIT) * 100).toFixed(3)}%`);
}

// 2. Угол отклонения в слабом поле: α = 4M/b + 15π/4·M²/b² + 128/3·M³/b³ + …
for (const b of [30, 100]) {
  const D = 5000;
  const v0 = [-Math.sqrt(1 - (b / D) ** 2), b / D, 0];
  const res = traceRay([D, 0, 0], v0, { stepK: 0.05, maxSteps: 20000, rout: 0, rEsc: D });
  // угол между начальным направлением и конечным
  const c = v0[0] * res.dir[0] + v0[1] * res.dir[1] + v0[2] * res.dir[2];
  const alpha = Math.acos(Math.min(1, c));
  // поправка на конечное расстояние до источника/наблюдателя: недостающий изгиб ≈ 2·(2M/b)·(1 - cos θ_D) → мал
  const theory = 4 / b + 15 * Math.PI / 4 / (b * b) + 128 / 3 / b ** 3;
  check(`Отклонение света, b = ${b}M`, relErr(alpha, theory) < 0.003, `α = ${alpha.toExponential(4)}, теория ${theory.toExponential(4)}`);
}

// 3. Перевод локального направления статического наблюдателя: луч под углом,
//    соответствующим краю тени для наблюдателя на D, должен иметь b = √27.
{
  const D = 20;
  const sinA = B_CRIT * Math.sqrt(1 - 2 / D) / D; // угловой радиус тени для статического наблюдателя
  const dir = [-Math.sqrt(1 - sinA * sinA), sinA, 0];
  const { b } = initialRay([D, 0, 0], dir);
  check('Угловой размер тени для близкого наблюдателя', relErr(b, B_CRIT) < 1e-9, `b = ${b.toFixed(6)}`);
}

// 4. Доплер: камера в плоскости диска на +z, диск вращается так, что точка
//    x < 0 приближается к наблюдателю → g > 1, точка x > 0 удаляется → g < 1.
{
  const D = 1000, cam = [0, 0.3, D];
  for (const [xt, expectBlue] of [[-10, true], [10, false]]) {
    const d = [xt - cam[0], 0 - cam[1], 0 - cam[2]];
    const l = Math.hypot(...d);
    const ray = initialRay(cam, d.map(c => c / l));
    const res = traceRay(cam, ray.v, { stepK: 0.05, rout: 40 });
    const hit = res.hits[0];
    const g = redshiftFactor(hit.r, ray.bY, D);
    // Специальная релятивистская оценка: v = 1/√(r-2) (локальная скорость), γ, + грав. фактор
    const vloc = 1 / Math.sqrt(hit.r - 2), gam = 1 / Math.sqrt(1 - vloc * vloc);
    const gEst = Math.sqrt(1 - 2 / hit.r) / (gam * (1 + (expectBlue ? -1 : 1) * vloc));
    check(`Доплер, ${expectBlue ? 'приближающаяся' : 'удаляющаяся'} сторона`, (g > 1) === expectBlue && relErr(g, gEst) < 0.03,
      `r = ${hit.r.toFixed(2)}, g = ${g.toFixed(4)}, оценка СТО+ОТО ${gEst.toFixed(4)}`);
  }
}

// 5. Лицом к наблюдателю (bY = 0): g = √(1 - 3/r) — грав. смещение + поперечный Доплер.
check('g при виде сверху', Math.abs(redshiftFactor(6, 0) - Math.sqrt(0.5)) < 1e-12, `g(ISCO) = ${redshiftFactor(6, 0).toFixed(4)}`);

// 6. Максимум температуры диска на r = 49/36·r_in.
{
  const pk = diskTempPeak(6);
  let best = 0, rb = 0;
  for (let r = 6.001; r < 30; r += 0.001) { const f = diskTempShape(r); if (f > best) { best = f; rb = r; } }
  check('Пик температуры диска', Math.abs(rb - pk.r) < 0.01, `r_peak = ${rb.toFixed(3)} (теория ${pk.r.toFixed(3)})`);
}

// 7. Цвета чёрного тела: 6500 K ≈ белый, 3000 K красноватый, 20000 K голубой.
{
  const rgb = T => { const c = xyzToLinearSRGB(blackbodyXYZ(T)); const m = Math.max(...c); return c.map(v => v / m); };
  const w = rgb(6500);
  check('6500 K ≈ белый', Math.min(...w) > 0.85, w.map(v => v.toFixed(3)).join(', '));
  const r = rgb(3000); check('3000 K — красно-оранжевый', r[0] === 1 && r[2] < 0.4, r.map(v => v.toFixed(3)).join(', '));
  const b = rgb(20000); check('20000 K — голубой', b[2] === 1 && b[0] < 0.8, b.map(v => v.toFixed(3)).join(', '));
  const lut = makeBlackbodyLUT();
  check('LUT конечна и неотрицательна', lut.length === LUT_SIZE * 4 && lut.every(v => isFinite(v) && v >= 0));
}

// 8. Число шагов на типичный луч (для лимита в шейдере).
{
  let worst = 0;
  for (let i = 0; i < 400; i++) {
    const D = 100, ang = (i / 400) * 0.12;
    const d = [-Math.cos(ang), Math.sin(ang) * 0.7, Math.sin(ang) * 0.7];
    const l = Math.hypot(...d);
    const ray = initialRay([D, 0.5, 0], d.map(c => c / l));
    const res = traceRay([D, 0.5, 0], ray.v, { stepK: 0.1, maxSteps: 3000 });
    if (res.fate !== 'steps') worst = Math.max(worst, res.steps);
  }
  check('Шагов на луч (low, D=100) < 300', worst < 300, `максимум ${worst}`);
}


// ======================= Керр =======================
console.log('\n--- Метрика Керра ---');
const norm = v => { const l = Math.hypot(...v); return v.map(c => c / l); };
// Камера как в js/camera.js: incl от оси y, azim; right = fwd × y.
function kerrCam(D, inclDeg, azDeg = 0) {
  const th = inclDeg * Math.PI / 180, ph = azDeg * Math.PI / 180;
  const pos = [D * Math.sin(th) * Math.cos(ph), D * Math.cos(th), D * Math.sin(th) * Math.sin(ph)];
  const fwd = pos.map(c => -c / D);
  const right = norm([-fwd[2], 0, fwd[0]]);
  const up = [right[1] * fwd[2] - right[2] * fwd[1], right[2] * fwd[0] - right[0] * fwd[2], right[0] * fwd[1] - right[1] * fwd[0]];
  return { pos, dir: (x, y) => norm(fwd.map((f, i) => f + x * right[i] + y * up[i])) };
}

// 9. Характерные радиусы
check('ISCO: a=0 → 6M, a=1 → 1M, a=−1 → 9M',
  Math.abs(kerrISCO(0) - 6) < 1e-9 && Math.abs(kerrISCO(1) - 1) < 1e-6 && Math.abs(kerrISCO(-1) - 9) < 1e-9,
  `ISCO(0.998) = ${kerrISCO(0.998).toFixed(4)} (лит. 1.237)`);
check('Горизонт r+ = 1 + √(1−a²)', Math.abs(kerrHorizon(0) - 2) < 1e-12 && Math.abs(kerrHorizon(0.6) - 1.8) < 1e-12);
{
  const p = kerrPhotonOrbits(0), p1 = kerrPhotonOrbits(1);
  check('Фотонные орбиты: a=0 → 3M; a=1 → 1M и 4M', Math.abs(p.pro - 3) < 1e-9 && Math.abs(p1.pro - 1) < 1e-9 && Math.abs(p1.retro - 4) < 1e-9);
}

// 10. Поток Пейджа–Торна: корни, нуль на ISCO, совпадение с прямым интегралом
//     f ∝ −Ω'/(E−ΩL)² · ∫(E−ΩL)L' dr / r  (Page & Thorne 1974, независимая формула).
for (const a of [0, 0.5, 0.9, 0.998, -0.7]) {
  const roots = ntRoots(a);
  const rootOk = roots.every(x => Math.abs(x ** 3 - 3 * x + 2 * a) < 1e-9);
  const rin = kerrISCO(a);
  const dr = 1e-5;
  const d = (f, r) => (f(r + dr) - f(r - dr)) / (2 * dr);
  const Om = r => kerrOrbit(r, a).omega, Ef = r => kerrOrbit(r, a).E, Lf = r => kerrOrbit(r, a).L;
  let integ = 0, rr = rin, ratios = [];
  const hstep = 1e-3;
  for (const rt of [rin * 1.3, rin * 2, rin * 4, 40]) {
    while (rr < rt) {   // интеграл методом средней точки
      const rm = rr + hstep / 2;
      integ += (Ef(rm) - Om(rm) * Lf(rm)) * d(Lf, rm) * hstep;
      rr += hstep;
    }
    const fNum = -d(Om, rr) / (Ef(rr) - Om(rr) * Lf(rr)) ** 2 * integ / rr;
    ratios.push(ntFlux(rr, a) / fNum);
  }
  const spread = (Math.max(...ratios) - Math.min(...ratios)) / Math.max(...ratios);
  check(`Поток Новикова–Торна, a = ${a}`, rootOk && ntFlux(rin, a) === 0 && spread < 2e-3,
    `пик на r = ${ntPeak(a).r.toFixed(2)} M, расхождение с интегралом ${(spread * 100).toFixed(3)}%`);
}

// 11. Согласованность начальных условий: ṙ² = R(r), μ̇² = Θ(μ)
{
  const a = 0.9, cam = kerrCam(30, 75, 20);
  let worst = 0;
  for (const [x, y] of [[0.1, 0.05], [-0.2, 0.1], [0.05, -0.3], [0.3, 0.3]]) {
    const ini = kerrInitialRay(a, cam.pos, cam.dir(x, y));
    const [r, mu, , rd, mud] = ini.y;
    worst = Math.max(worst, Math.abs(rd * rd - kerrR(r, a, ini.l, ini.q)) / (r ** 4), Math.abs(mud * mud - kerrTheta(mu, a, ini.l, ini.q)) / (1 + ini.q));
  }
  check('Начальные условия: ṙ² = R, μ̇² = Θ', worst < 1e-6, `макс. отн. невязка ${worst.toExponential(2)}`);
}

// 12. Предел a → 0: трассировщик Керра совпадает с трассировщиком Шварцшильда
{
  const cam = kerrCam(30, 80, 30);
  let worstDir = 0, worstHit = 0;
  for (const [x, y] of [[0.3, 0.1], [-0.25, 0.2], [0.12, -0.1], [-0.4, -0.3], [0.2, 0.02]]) {
    const dir = cam.dir(x, y);
    const k = traceKerr(0, kerrInitialRay(0, cam.pos, dir), { stepK: 0.02, rEsc: 200 });
    const s0 = initialRay(cam.pos, dir);
    const s = traceRay(cam.pos, s0.v, { stepK: 0.02, rEsc: 200 });
    if (k.fate !== s.fate) { worstDir = 1; continue; }
    if (k.fate === 'escaped') worstDir = Math.max(worstDir, Math.acos(Math.min(1, dot3(k.dir, s.dir))));
    if (k.hits.length && s.hits.length) worstHit = Math.max(worstHit, Math.abs(k.hits[0].r - s.hits[0].r));
  }
  check('Керр при a = 0 ≡ Шварцшильд', worstDir < 5e-3 && worstHit < 0.02,
    `расхождение направлений ${worstDir.toExponential(2)} рад, точек на диске ${worstHit.toFixed(4)} M`);
}
function dot3(u, v) { return u[0] * v[0] + u[1] * v[1] + u[2] * v[2]; }

// 12b. Лучи, проходящие над полюсом (L ≈ 0): Керр(a=0) против декартова Шварцшильда,
//      где полюс не выделен. Проверяет аналитический учёт полярной шапки.
{
  const cam = kerrCam(25, 70, 0);
  let worst = 0, n = 0;
  for (const x of [0, 1e-6, -1e-4, 2e-3, -8e-3, 0.02]) for (const y of [0.18, 0.25, 0.3]) {
    const dir = cam.dir(x, y);
    const k = traceKerr(0, kerrInitialRay(0, cam.pos, dir), { stepK: 0.03, rEsc: 300, rout: 0 });
    const s0 = initialRay(cam.pos, dir);
    const s = traceRay(cam.pos, s0.v, { stepK: 0.03, rEsc: 300, rout: 0 });
    if (k.fate !== s.fate) { worst = 9; continue; }
    if (k.fate === 'escaped') { worst = Math.max(worst, Math.acos(Math.min(1, dot3(k.dir, s.dir)))); n++; }
  }
  check('Лучи над полюсом: Керр(a=0) ≡ Шварцшильд', worst < 5e-3 && n > 10, `макс. расхождение ${worst.toExponential(2)} рад на ${n} лучах`);
}

// 13. Края тени в экваторе для a = 0.9 против аналитики Бардина:
//     α = −λ_c, λ_c для прямой и обратной фотонных орбит. Проверяет и знак (сплюснутая сторона — слева).
{
  const a = 0.9, D = 2000, cam = kerrCam(D, 90, 0);
  const curve = kerrCriticalCurve(a, Math.PI / 2);
  const aMin = Math.min(...curve.map(p => p[0])), aMax = Math.max(...curve.map(p => p[0]));
  const edge = (sgn) => {
    let lo = 0.5, hi = 12;   // |α| в M; захват при |α| < края
    for (let i = 0; i < 40; i++) {
      const m = (lo + hi) / 2;
      const res = traceKerr(a, kerrInitialRay(a, cam.pos, cam.dir(sgn * m / D, 0)), { stepK: 0.03, rout: 0 });
      if (res.fate === 'captured') lo = m; else hi = m;
    }
    return sgn * (lo + hi) / 2;
  };
  const L = edge(-1), R = edge(1);
  check('Тень Керра (a=0.9, вид с ребра): левый край', Math.abs(L - aMin) < 0.01, `трассировка ${L.toFixed(4)} M, аналитика ${aMin.toFixed(4)} M`);
  check('Тень Керра (a=0.9, вид с ребра): правый край', Math.abs(R - aMax) < 0.01, `трассировка ${R.toFixed(4)} M, аналитика ${aMax.toFixed(4)} M`);
}

// 14. Доплер в Керре при a = 0 совпадает со Шварцшильдом; приближающаяся сторона — синяя
{
  const D = 1000, cam = [0, 0.3, D];
  const dir = norm([-10 - cam[0], -cam[1], -cam[2]]);
  const ini = kerrInitialRay(0, cam, dir);
  const hit = traceKerr(0, ini, { rout: 40 }).hits[0];
  const gK = kerrRedshift(hit.r, 0, ini.E, ini.l);
  const s0 = initialRay(cam, dir);
  const gS = redshiftFactor(hit.r, s0.bY, D);
  check('Смещение g: Керр(a=0) = Шварцшильд', Math.abs(gK - gS) < 1e-3 && gK > 1, `g = ${gK.toFixed(4)} vs ${gS.toFixed(4)}`);
}

console.log(failed ? `\n${failed} проверок не прошли` : '\nВсе проверки пройдены');
process.exit(failed ? 1 : 0);
