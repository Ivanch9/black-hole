// Проверка физики на CPU тем же алгоритмом, что и в шейдере.
// Запуск: node tests/physics.test.mjs
import {
  initialRay, traceRay, redshiftFactor, diskTempPeak, diskTempShape,
  makeBlackbodyLUT, blackbodyXYZ, xyzToLinearSRGB, B_CRIT, LUT_SIZE,
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

console.log(failed ? `\n${failed} проверок не прошли` : '\nВсе проверки пройдены');
process.exit(failed ? 1 : 0);
