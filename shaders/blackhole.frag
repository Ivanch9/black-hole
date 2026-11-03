#version 300 es
// Трассировка лучей в метрике Шварцшильда (G = c = M = 1).
// Каждый пиксель — фотон, прослеженный назад во времени от камеры.
// Алгоритм идентичен эталону js/physics.js (traceRay), проверенному тестами.
precision highp float;
precision highp int;

in vec2 vUv;
out vec4 fragColor;

uniform vec2 uRes;
uniform vec3 uCamPos, uCamRight, uCamUp, uCamFwd;
uniform float uTanHalf;
uniform float uTime;          // время в единицах M (GM/c³)
uniform float uRin, uRout;    // границы диска
uniform float uTscale;        // T(r) = uTscale · r^-3/4 (1-√(rin/r))^1/4
uniform float uObsG;          // 1/√(1-2/r_cam): синее смещение для статического наблюдателя
uniform int uMaxSteps;
uniform float uStepK;
uniform float uREsc;
uniform int uDoppler, uGrav, uBeaming, uDisk, uStars, uMilky, uTurb;
uniform int uMode;            // 0 — реалистичный, 1 — карта g, 2 — порядок изображений
uniform sampler2D uBB;        // LUT чёрного тела (линейный sRGB, абсолютная яркость)
uniform float uLogTmin, uLogTmax;
uniform float uStarBright, uMilkyBright, uDiskBright;
uniform mat3 uGal;            // ориентация галактической плоскости
#ifdef KERR
uniform float uA;             // спин a = J/M
uniform float uRH;            // радиус горизонта r+
uniform vec4 uNT;             // √r_isco и корни x³ − 3x + 2a = 0
#endif

const float PI = 3.14159265359;

vec3 bb(float T) {
  float x = clamp((log(max(T, 1.0)) - uLogTmin) / (uLogTmax - uLogTmin), 0.0, 1.0);
  return texture(uBB, vec2(x * (1023.0 / 1024.0) + 0.5 / 1024.0, 0.5)).rgb;
}
float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

// ---------- шум ----------
float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 hash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}
float vnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), f.x),
                 mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), f.x),
                 mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float fbm(vec3 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + vec3(1.7, 9.2, 3.1); a *= 0.5; }
  return s / 0.97;
}

// ---------- аккреционный диск ----------
// Неоднородности вмороженные в газ, вращающийся с локальной кеплеровской
// скоростью Ω(r) = r^-3/2. Дифференциальное вращение растягивает их в спирали;
// чтобы сдвиг не рос бесконечно, два слоя с разной «фазой жизни» плавно сменяют друг друга.
float diskNoise(float r, float phi, float om) {
  const float P = 60.0;
  float tt = uTime / P;
  float s = 0.0;
  for (int k = 0; k < 2; k++) {
    float ph = tt + 0.5 * float(k);
    float f = fract(ph), cyc = floor(ph);
    float w = 1.0 - abs(2.0 * f - 1.0);
    float a = phi - om * f * P;
    vec3 q = vec3(cos(a) * 2.2, sin(a) * 2.2, log(r) * 9.0) + vec3(cyc * 13.7 + float(k) * 41.3, cyc * 7.31, 0.0);
    s += w * fbm(q);
  }
  return s;
}

vec3 gColor(float g) {
  // Расходящаяся шкала: красный (g<1, красное смещение) — белый (g=1) — синий (g>1).
  float x = clamp(log2(g) / log2(1.8), -1.0, 1.0);
  vec3 c = x < 0.0 ? mix(vec3(1.0), vec3(0.85, 0.12, 0.08), -x) : mix(vec3(1.0), vec3(0.1, 0.35, 1.0), x);
  // Изолинии g с шагом 0.1
  float iso = abs(fract(g * 10.0 + 0.5) - 0.5);
  return c * (0.6 + 0.4 * smoothstep(0.0, 0.06, iso));
}

// Общий шейдинг диска: r, φ — точка на диске, om — угловая скорость газа,
// g — фактор смещения частоты, T — температура газа в его системе отсчёта.
vec4 shadeDisk(float r, float phi, float om, float g, float T, int order) {
  float n = 0.5;
  if (uTurb == 1) { n = diskNoise(r, phi, om); T *= 0.78 + 0.44 * n; }

  float edge = smoothstep(uRin, uRin * 1.06, r) * (1.0 - smoothstep(uRout * 0.65, uRout, r));
  float a = edge;
  if (uTurb == 1) a *= mix(0.45, 1.0, smoothstep(0.3, 0.62, n));

  if (uMode == 1) return vec4(gColor(g) * a, a);
  if (uMode == 2) {
    vec3 oc = order == 0 ? vec3(1.0, 0.55, 0.15) : order == 1 ? vec3(0.2, 0.7, 1.0) : order == 2 ? vec3(0.85, 0.3, 1.0) : vec3(0.3, 1.0, 0.4);
    return vec4(oc * a, a);
  }
  // I_ν/ν³ инвариантен ⇒ наблюдаемый спектр — снова планковский, с температурой g·T.
  // Это одновременно даёт сдвиг цвета и усиление яркости (болометрически ∝ g⁴).
  vec3 c = bb(g * T);
  if (uBeaming == 0) c *= lum(bb(T)) / max(lum(c), 1e-20);
  return vec4(c * uDiskBright * a, a);
}

#ifndef KERR
// Шварцшильд: точка p на диске (декартовы), bY = L_z/E фотона.
vec4 shadeDiskSchw(vec3 p, float bY, int order) {
  float r = length(p);
  float phi = atan(-p.z, p.x);             // растёт в направлении вращения газа
  float om = pow(r, -1.5);
  float sg = sqrt(max(1.0 - 2.0 / r, 1e-6));
  // Полный фактор смещения для кеплеровского газа: √(1-3/r)/(1-Ω·bY)
  float gfull = sqrt(max(1.0 - 3.0 / r, 1e-6)) / (1.0 - om * bY);
  float g = (uDoppler == 1) ? gfull : sg;   // без Доплера — газ как будто покоится
  if (uGrav == 1) g *= uObsG; else g /= sg; // без гравитации — только кинематика
  // Профиль Шакуры–Сюняева с нулевым моментом на ISCO
  float T = uTscale * pow(r, -0.75) * pow(max(1.0 - sqrt(uRin / r), 0.0), 0.25);
  return shadeDisk(r, phi, om, g, T, order);
}
#else
// Керр: поток Новикова–Торна (Page & Thorne 1974), x = √r, корни x³ − 3x + 2a = 0 в uNT.yzw.
float ntTerm(float x, float x0, float xi, float xj, float xk) {
  if (abs(xi) < 1e-5) return 0.0;
  return 3.0 * (xi - uA) * (xi - uA) / (xi * (xi - xj) * (xi - xk)) * log(abs((x - xi) / (x0 - xi)));
}
float ntFlux(float r) {
  float x = sqrt(r), x0 = uNT.x;
  if (x <= x0) return 0.0;
  float s = x - x0 - 1.5 * uA * log(x / x0)
          - ntTerm(x, x0, uNT.y, uNT.z, uNT.w) - ntTerm(x, x0, uNT.z, uNT.y, uNT.w) - ntTerm(x, x0, uNT.w, uNT.y, uNT.z);
  float x2 = x * x;
  return max(s, 0.0) / (x2 * x2 * (x2 * x - 3.0 * x + 2.0 * uA));
}
// E — энергия фотона в единицах, где камера-ZAMO измеряет 1; l = L/E; alCam — «лапс» камеры.
vec4 shadeDiskKerr(float r, float phi, float E, float l, float alCam, int order) {
  float a = uA, a2 = a * a;
  float sr = sqrt(r), r32 = r * sr;
  float om = 1.0 / (r32 + a);                                        // кеплеровская Ω
  float ut = (r32 + a) / (pow(r, 0.75) * sqrt(max(r32 - 3.0 * sr + 2.0 * a, 1e-6)));
  float gfull = 1.0 / (ut * E * (1.0 - om * l));
  float D = r * r - 2.0 * r + a2, A = (r * r + a2) * (r * r + a2) - a2 * D;
  float alEm = sqrt(max(r * r * D / A, 1e-8)), omZ = 2.0 * a * r / A;
  float g = (uDoppler == 1) ? gfull : alEm / (E * (1.0 - omZ * l));  // без Доплера — газ как ZAMO
  if (uGrav == 0) g *= alCam / alEm;                                  // убрать разницу «лапсов»
  float T = uTscale * pow(ntFlux(r), 0.25);
  return shadeDisk(r, phi, om, g, T, order);
}
#endif

// ---------- небо ----------
// Звёзды: точки, разбросанные по ячейкам 3D-сетки на сфере. Ширина профиля берётся из
// размера пикселя на небе (fp), поэтому линзовое увеличение автоматически увеличивает
// видимый поток звезды, а поверхностная яркость сохраняется (теорема Лиувилля).
// pixA — номинальный угловой размер пикселя, fp — размер пикселя, спроецированный на небо
// после линзирования. Пиковое значение ≈ 0.44·F·(pixA/fp)²: поток звезды умножается на
// коэффициент усиления линзы μ = (pixA/fp)², а при μ > 1 звезда растягивается в дугу.
vec3 starLayer(vec3 d, float scale, float dens, float fmin, float fp, float pixA, float seed) {
  vec3 p = d * scale;
  vec3 b = floor(p - 0.5);
  vec3 acc = vec3(0.0);
  float sigW = 0.6 * max(fp, pixA);           // желаемая ширина (в плоскости неба)
  float sig = min(sigW, 0.16 / scale);        // ограничение размером ячейки
  float s2 = sig * sig + 1e-12;
  float norm = pixA * pixA / (2.0 * PI * sigW * sigW);
  for (int i = 0; i < 8; i++) {
    vec3 cell = b + vec3(float(i & 1), float((i >> 1) & 1), float((i >> 2) & 1));
    vec3 hc = cell + seed;
    if (hash13(hc) > dens) continue;
    vec3 j = hash33(hc * 1.37 + 11.1);
    vec3 sn = normalize(cell + 0.1 + 0.8 * j);
    if (any(notEqual(floor(sn * scale), cell))) continue;   // звезда должна лежать в своей ячейке
    float th2 = dot(d - sn, d - sn);
    if (th2 > 9.0 * s2 + 1e-7) continue;
    float u = hash13(hc * 2.71 + 3.3);
    float F = fmin * min(pow(max(u, 1e-4), -0.6667), 60.0);  // N(>F) ∝ F^-3/2
    float Ts = 2800.0 + 13000.0 * pow(j.y, 2.2);
    vec3 col = bb(Ts); col /= max(lum(col), 1e-12);
    col = mix(vec3(1.0), col, 0.55);          // глаз/камера видят цвета звёзд бледнее
    acc += col * F * norm * exp(-0.5 * th2 / s2);
  }
  return acc;
}

vec3 sky(vec3 d, float fp, float pixA) {
  vec3 c = vec3(0.0);
  vec3 g = uGal * d;
  float lat = asin(clamp(g.y, -1.0, 1.0));
  float lane = 0.0;
  if (uMilky == 1) {
    float lon = atan(g.z, g.x);
    float band = exp(-lat * lat / (2.0 * 0.15 * 0.15));
    float bulge = exp(-lat * lat / (2.0 * 0.2 * 0.2) - lon * lon / (2.0 * 0.45 * 0.45));
    float det = fbm(g * 5.0);
    float dust = fbm(g * 10.0 + vec3(5.2, 1.3, 8.8));
    lane = exp(-lat * lat / (2.0 * 0.06 * 0.06)) * smoothstep(0.4, 0.65, dust);
    float I = (band * (0.25 + det * det) + 1.4 * bulge * det) * (1.0 - 0.85 * lane);
    vec3 warm = bb(4200.0) / lum(bb(4200.0)), cool = bb(9000.0) / lum(bb(9000.0));
    c += uMilkyBright * I * mix(cool, warm, clamp(bulge * 1.5 + 0.25, 0.0, 1.0));
  }
  if (uStars == 1) {
    vec3 s = starLayer(d, 22.0, 0.55, 0.30, fp, pixA, 0.0)
           + starLayer(d, 55.0, 0.50, 0.07, fp, pixA, 17.0)
           + starLayer(d, 130.0, 0.45, 0.022, fp, pixA, 43.0);
    c += uStarBright * s * (1.0 - 0.7 * lane);
  }
  return c;
}

// ---------- интеграторы ----------
#ifndef KERR
vec3 accel(vec3 x, float A) {
  float r2 = dot(x, x);
  return x * (A / (r2 * r2 * sqrt(r2)));
}
#else
// Обратный ход во времени Мино: r̈ = R'(r)/2, μ̈ = Θ'(μ)/2 (μ = cos θ), φ̇ = −Φ(r, μ).
// Возвращает производные состояния (r, μ, φ, ṙ, μ̇) — в двух vec3 для компактности.
// pole = 0 — внутри полярной шапки член l/sin²θ учитывается аналитически (см. physics.js).
const float POLE_CAP = 0.001;
void kerrDeriv(float r, float mu, float rd, float mud, float l, float q, float pole, out vec3 d1, out vec2 d2) {
  float a = uA, a2 = a * a;
  float P = r * r + a2 - a * l, K = (l - a) * (l - a) + q;
  float D = max(r * r - 2.0 * r + a2, 1e-6), s2 = max(1.0 - mu * mu, 1e-6);
  d1 = vec3(rd, mud, -(a * P / D - a + pole * l / s2));
  d2 = vec2(2.0 * r * P - (r - 1.0) * K, -(q + l * l - a2) * mu - 2.0 * a2 * mu * mu * mu);
}
float kerrR(float r, float l, float q) {
  float P = r * r + uA * uA - uA * l;
  return P * P - (r * r - 2.0 * r + uA * uA) * ((l - uA) * (l - uA) + q);
}
float kerrTh(float mu, float l, float q) {
  float m2 = mu * mu;
  return q - (q + l * l - uA * uA) * m2 - uA * uA * m2 * m2;
}
void sphBasis(float th, float ph, out vec3 er, out vec3 eth, out vec3 eph) {
  float s = sin(th), c = cos(th), sp = sin(ph), cp = cos(ph);
  er = vec3(s * cp, c, -s * sp);
  eth = vec3(c * cp, -s, -c * sp);
  eph = vec3(-sp, 0.0, -cp);
}
#endif

void main() {
  vec2 ndc = (gl_FragCoord.xy / uRes) * 2.0 - 1.0;
  float aspect = uRes.x / uRes.y;
  vec3 dl = normalize(uCamFwd + ndc.x * aspect * uTanHalf * uCamRight + ndc.y * uTanHalf * uCamUp);

  vec3 col = vec3(0.0);
  float trans = 1.0;
  int order = 0;
  bool escaped = false;
  vec3 dEsc;

#ifndef KERR
  // Направление, измеренное статическим наблюдателем → координатное направление (см. physics.js initialRay)
  vec3 x = uCamPos;
  float r0 = length(x);
  vec3 rh = x / r0;
  float u0 = 1.0 / r0;
  float dr = dot(dl, rh);
  vec3 t = dl - dr * rh;
  float st = length(t);
  float sc = st / sqrt((1.0 - 2.0 * u0) + 2.0 * u0 * st * st);
  float sgn = dr >= 0.0 ? 1.0 : -1.0;
  float cc = sgn * sqrt(max(1.0 - sc * sc, 0.0));
  vec3 v = st > 1e-7 ? cc * rh + sc * (t / st) : sgn * rh;
  vec3 hv = cross(x, v);
  float h2 = dot(hv, hv);
  float bimp = r0 * st / sqrt(1.0 - 2.0 * u0);
  float bY = h2 > 1e-12 ? -bimp * hv.y / sqrt(h2) : 0.0;   // L_z/E реального фотона
  float A = -3.0 * h2;

  for (int i = 0; i < 4000; i++) {
    if (i >= uMaxSteps) break;
    float r = length(x);
    if (r < 2.0005) break;                                   // под горизонтом
    if (r > uREsc && dot(x, v) > 0.0) { escaped = true; break; }
    float dt = uStepK * r;
    vec3 k1x = v,                   k1v = accel(x, A);
    vec3 k2x = v + 0.5 * dt * k1v,  k2v = accel(x + 0.5 * dt * k1x, A);
    vec3 k3x = v + 0.5 * dt * k2v,  k3v = accel(x + 0.5 * dt * k2x, A);
    vec3 k4x = v + dt * k3v,        k4v = accel(x + dt * k3x, A);
    vec3 xo = x;
    x += dt / 6.0 * (k1x + 2.0 * k2x + 2.0 * k3x + k4x);
    v += dt / 6.0 * (k1v + 2.0 * k2v + 2.0 * k3v + k4v);

    if (uDisk == 1 && xo.y * x.y < 0.0) {                    // пересечение плоскости диска
      vec3 p = mix(xo, x, xo.y / (xo.y - x.y));
      float rp = length(p);
      if (rp > uRin && rp < uRout) {
        vec4 dc = shadeDiskSchw(p, bY, order);
        col += trans * dc.rgb;
        trans *= 1.0 - dc.a;
        order++;
        if (trans < 0.004) break;
      }
    }
  }
  dEsc = normalize(v);
#else
  // Камера — локальный невращающийся наблюдатель (ZAMO) в точке (r0, θ0, φ0) Бойера–Линдквиста.
  float a = uA, a2 = a * a;
  float r0 = length(uCamPos);
  // atan(±0, x) на некоторых GPU даёт ±π — убираем «отрицательный ноль» явно
  float cz = -uCamPos.z, cx = uCamPos.x;
  if (abs(cz) < 1e-6 * r0) cz = 0.0;
  if (abs(cx) < 1e-6 * r0) cx = 0.0;
  float th0 = acos(clamp(uCamPos.y / r0, -1.0, 1.0)), ph0 = (cz == 0.0 && cx == 0.0) ? 0.0 : atan(cz, cx);
  vec3 er, eth, eph;
  sphBasis(th0, ph0, er, eth, eph);
  float nr = dot(dl, er), nth = dot(dl, eth), nph = dot(dl, eph);
  float s0 = max(sin(th0), 1e-4), c0 = cos(th0);
  float S0 = r0 * r0 + a2 * c0 * c0, D0 = r0 * r0 - 2.0 * r0 + a2;
  float A0 = (r0 * r0 + a2) * (r0 * r0 + a2) - a2 * D0 * s0 * s0;
  float alCam = sqrt(S0 * D0 / A0), omCam = 2.0 * a * r0 / A0;
  // Реальный фотон летит в направлении −dl; локальная энергия = 1.
  float Lz = sqrt(A0 / S0) * s0 * (-nph);
  float E = alCam + omCam * Lz;
  float pr = sqrt(S0 / D0) * (-nr), pth = sqrt(S0) * (-nth);
  float Qc = pth * pth + c0 * c0 * (Lz * Lz / (s0 * s0) - a2 * E * E);
  float l = Lz / E, q = Qc / (E * E);                        // λ = L/E, η = Q/E²
  float r = r0, mu = c0, phi = ph0, rd = -D0 * pr / E, mud = s0 * pth / E;
  // Минимальное удаление луча от оси: корень Θ(X = sin²θ) = −l² + B·X − a²X² = 0
  float Bq = q + l * l + a2;
  float dPole = sqrt(2.0 * l * l / (Bq + sqrt(max(Bq * Bq - 4.0 * a2 * l * l, 0.0))));
  float sgnL = l < 0.0 ? -1.0 : 1.0;
  float rhoIn = -1.0;

  for (int i = 0; i < 4000; i++) {
    if (i >= uMaxSteps) break;
    if (r < uRH * 1.01) break;                               // под горизонтом
    if (r > uREsc && rd > 0.0) { escaped = true; break; }
    float s2c = 1.0 - mu * mu;
    bool inCap = s2c < POLE_CAP;
    if (inCap && rhoIn < 0.0) rhoIn = sqrt(s2c);
    float pole = inCap ? 0.0 : 1.0;
    float h = uStepK * r / (r * r + a2 * mu * mu);           // аффинный шаг ≈ uStepK·r
    // у полюса: поворот по φ ≤ 0.03 рад и изменение sin²θ ≤ 25% за шаг
    if (!inCap) h = min(h, min(0.03 * s2c / max(abs(l), 1e-9), 0.12 * s2c / max(abs(mud * mu), 1e-9)));
    vec3 a1, a3, b1, b3; vec2 a2v, a4, b2, b4;
    kerrDeriv(r, mu, rd, mud, l, q, pole, a1, a2v);
    kerrDeriv(r + 0.5 * h * a1.x, mu + 0.5 * h * a1.y, rd + 0.5 * h * a2v.x, mud + 0.5 * h * a2v.y, l, q, pole, b1, b2);
    kerrDeriv(r + 0.5 * h * b1.x, mu + 0.5 * h * b1.y, rd + 0.5 * h * b2.x, mud + 0.5 * h * b2.y, l, q, pole, a3, a4);
    kerrDeriv(r + h * a3.x, mu + h * a3.y, rd + h * a4.x, mud + h * a4.y, l, q, pole, b3, b4);
    float ro = r, muo = mu, pho = phi;
    vec3 dy = h / 6.0 * (a1 + 2.0 * b1 + 2.0 * a3 + b3);
    vec2 dv = h / 6.0 * (a2v + 2.0 * b2 + 2.0 * a4 + b4);
    r += dy.x; mu = clamp(mu + dy.y, -1.0, 1.0); phi += dy.z;
    rd += dv.x; mud += dv.y;
    // Проекция на интегралы движения ṙ² = R, μ̇² = Θ вдали от точек поворота
    float sc = (r * r + a2) * (r * r + a2);
    if (rd * rd > 0.01 * sc) { float Rv = kerrR(r, l, q); if (Rv > 0.0) rd = sign(rd) * sqrt(Rv); }
    if (mud * mud > 0.01 * (q + l * l + a2)) { float Tv = kerrTh(mu, l, q); if (Tv > 0.0) mud = sign(mud) * sqrt(Tv); }
    // Вышли из полярной шапки: поворот по φ при почти прямолинейном пролёте мимо оси
    if (inCap && 1.0 - mu * mu >= POLE_CAP) {
      float rhoOut = sqrt(1.0 - mu * mu);
      phi -= sgnL * (acos(min(1.0, dPole / rhoIn)) + acos(min(1.0, dPole / rhoOut)));
      rhoIn = -1.0;
    }

    if (uDisk == 1 && muo * mu < 0.0) {                      // пересечение экватора
      float f = muo / (muo - mu);
      float rp = mix(ro, r, f);
      if (rp > uRin && rp < uRout) {
        vec4 dc = shadeDiskKerr(rp, mix(pho, phi, f), E, l, alCam, order);
        col += trans * dc.rgb;
        trans *= 1.0 - dc.a;
        order++;
        if (trans < 0.004) break;
      }
    }
  }
  {
    vec3 d1; vec2 d2;
    kerrDeriv(r, mu, rd, mud, l, q, 1.0, d1, d2);
    float th = acos(mu), st = max(sin(th), 1e-6);
    vec3 fr, fth, fph;
    sphBasis(th, phi, fr, fth, fph);
    dEsc = normalize(rd * fr - r * mud / st * fth + r * st * d1.z * fph);
  }
  if (!escaped) dEsc = dl;   // у горизонта φ̇ ~ 1/Δ → не даём NaN попасть в производные
#endif

  // Производные вычисляются вне ветвлений — размер пикселя на небе после линзирования.
  float pixA = 2.0 * uTanHalf / uRes.y;
  // √(|∂d/∂x|·|∂d/∂y|): пиксель на небе; (pixA/fp)² — коэффициент усиления линзы μ
  float fp = clamp(sqrt(length(dFdx(dEsc)) * length(dFdy(dEsc))), pixA * 0.05, pixA * 40.0);

  if (escaped && trans > 0.004) {
    vec3 s = sky(dEsc, fp, pixA);
    col += trans * (uMode == 0 ? s : s * 0.25);
  }
  if (any(isnan(col)) || any(isinf(col))) col = vec3(0.0);   // NaN не должен попасть в ореол
  fragColor = vec4(col, 1.0);
}
