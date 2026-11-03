import { cameraBasis, attachControls } from './camera.js';
import { makeBlackbodyLUT, diskTempPeak, LUT_TMIN, LUT_TMAX, LUT_SIZE, R_ISCO, B_CRIT } from './physics.js';
import { buildUI } from './ui.js';

// Пресеты качества: максимальный масштаб трассировки, лимит шагов, шаг интегратора (доля r).
// Шаги проверены в tests/physics.test.mjs (ошибка радиуса тени < 0.01%).
const QUALITY = {
  low: { maxScale: 0.5, steps: 300, stepK: 0.1, dpr: 1 },
  medium: { maxScale: 0.75, steps: 400, stepK: 0.07, dpr: 1 },
  high: { maxScale: 1.0, steps: 500, stepK: 0.05, dpr: 1 },
  ultra: { maxScale: 1.0, steps: 700, stepK: 0.035, dpr: 2 },
};
const BLOOM_LEVELS = 6;

const DEFAULTS = {
  incl: 85, azim: 0, dist: 30, fov: 50, autoRotate: false,
  tmax: 6000, rout: 20, doppler: true, grav: true, beaming: true, turb: true, disk: true, stars: true, milky: true,
  timeSpeed: 30, paused: false, mode: 0, exposure: -2, bloom: 0.08, starBright: 1, quality: 'high', adaptive: true, overlay: false,
};

const state = { ...DEFAULTS };
// Состояние в адресной строке: можно поделиться ракурсом.
try {
  const saved = JSON.parse(decodeURIComponent(location.hash.slice(1)) || '{}');
  for (const k of Object.keys(DEFAULTS)) if (k in saved && typeof saved[k] === typeof DEFAULTS[k]) state[k] = saved[k];
} catch { /* игнорируем испорченный hash */ }

const canvas = document.getElementById('c');
const overlay = document.getElementById('overlay');
const octx = overlay.getContext('2d');
const errBox = document.getElementById('err');
const info = document.getElementById('info');

function fail(msg) {
  errBox.textContent = msg;
  errBox.style.display = 'block';
  throw new Error(msg);
}

const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'high-performance' });
if (!gl) fail('WebGL2 не поддерживается этим браузером/видеокартой.');
if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float'))
  fail('Нет поддержки HDR-рендеринга (EXT_color_buffer_float).');

async function loadText(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) fail(`Не удалось загрузить ${url}: ${r.status}`);
  return r.text();
}

function compile(type, src, name) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) fail(`Ошибка компиляции ${name}:\n${gl.getShaderInfoLog(s)}`);
  return s;
}
function program(vsrc, fsrc, name) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vsrc, 'quad.vert'));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fsrc, name));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) fail(`Ошибка линковки ${name}:\n${gl.getProgramInfoLog(p)}`);
  const locs = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const u = gl.getActiveUniform(p, i);
    locs[u.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, u.name);
  }
  return { p, locs };
}

function makeTarget(w, h) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) fail('HDR-буфер не поддерживается.');
  return { tex, fb, w, h };
}
function freeTarget(t) { if (t) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); } }

function setUniforms(prog, values) {
  for (const [k, v] of Object.entries(values)) {
    const loc = prog.locs[k];
    if (loc == null) continue;
    if (typeof v === 'boolean') gl.uniform1i(loc, v ? 1 : 0);
    else if (typeof v === 'number') gl.uniform1f(loc, v);
    else if (v.int != null) gl.uniform1i(loc, v.int);
    else if (v.length === 2) gl.uniform2fv(loc, v);
    else if (v.length === 3) gl.uniform3fv(loc, v);
    else if (v.length === 9) gl.uniformMatrix3fv(loc, false, v);
  }
}

// Ориентация Млечного Пути на небе (произвольная, но фиксированная).
function galaxyMatrix() {
  const a = 1.1, b = 0.45;
  const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
  // R = Rx(b) · Ry(a), хранение по столбцам
  const Ry = [[ca, 0, -sa], [0, 1, 0], [sa, 0, ca]];
  const Rx = [[1, 0, 0], [0, cb, sb], [0, -sb, cb]];
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) M[i][j] += Rx[i][k] * Ry[k][j];
  return [M[0][0], M[1][0], M[2][0], M[0][1], M[1][1], M[2][1], M[0][2], M[1][2], M[2][2]];
}

async function main() {
  const [vs, fsBH, fsBloom, fsPost] = await Promise.all(
    ['shaders/quad.vert', 'shaders/blackhole.frag', 'shaders/bloom.frag', 'shaders/post.frag'].map(loadText));
  const progBH = program(vs, fsBH, 'blackhole.frag');
  const progBloom = program(vs, fsBloom, 'bloom.frag');
  const progPost = program(vs, fsPost, 'post.frag');
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);

  // LUT чёрного тела
  const lutTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, lutTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, LUT_SIZE, 1, 0, gl.RGBA, gl.FLOAT, makeBlackbodyLUT());
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const peak = diskTempPeak(R_ISCO);
  const gal = galaxyMatrix();

  let hdr = null, bloom = [], canvasW = 0, canvasH = 0, scale = QUALITY[state.quality].maxScale, rtW = 0, rtH = 0;

  function resize() {
    const q = QUALITY[state.quality];
    const dpr = Math.min(window.devicePixelRatio || 1, q.dpr);
    const cw = Math.max(1, Math.round(canvas.clientWidth * dpr)), ch = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (cw !== canvasW || ch !== canvasH) {
      canvasW = canvas.width = cw; canvasH = canvas.height = ch;
      overlay.width = Math.round(overlay.clientWidth * (window.devicePixelRatio || 1));
      overlay.height = Math.round(overlay.clientHeight * (window.devicePixelRatio || 1));
    }
    const w = Math.max(16, Math.round(cw * scale)), h = Math.max(16, Math.round(ch * scale));
    if (w === rtW && h === rtH && hdr) return;
    rtW = w; rtH = h;
    freeTarget(hdr); bloom.forEach(freeTarget);
    hdr = makeTarget(w, h);
    bloom = [];
    let bw = w, bh = h;
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      bw = Math.max(1, bw >> 1); bh = Math.max(1, bh >> 1);
      bloom.push(makeTarget(bw, bh));
    }
  }

  let dirtyHash = false;
  const ui = buildUI(document.getElementById('panel-body'), state, key => {
    if (key === 'quality') scale = QUALITY[state.quality].maxScale;
    dirtyHash = true;
  });
  attachControls(canvas, state, () => { ui.refresh(); dirtyHash = true; });

  // Клавиши: H — скрыть панель, Пробел — пауза, R — сброс
  const panel = document.getElementById('panel');
  document.getElementById('toggle').addEventListener('click', () => panel.classList.toggle('hidden'));
  window.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.key === 'h' || e.key === 'р') panel.classList.toggle('hidden');
    else if (e.key === ' ') { state.paused = !state.paused; ui.refresh(); e.preventDefault(); }
    else if (e.key === 'r' || e.key === 'к') { Object.assign(state, DEFAULTS); scale = QUALITY[state.quality].maxScale; ui.refresh(); dirtyHash = true; }
  });
  setInterval(() => {
    if (!dirtyHash) return;
    dirtyHash = false;
    history.replaceState(null, '', '#' + encodeURIComponent(JSON.stringify(state)));
  }, 1000);

  let simTime = 0, last = performance.now(), fpsEma = 60, lastAdapt = last, lastInfo = 0;

  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    fpsEma = fpsEma * 0.9 + (1 / Math.max(dt, 1e-3)) * 0.1;
    if (!state.paused) simTime += dt * state.timeSpeed;
    if (state.autoRotate) { state.azim = (state.azim + dt * 4) % 360; }

    // Адаптивное разрешение: держим ~45–60 кадров/с
    const q = QUALITY[state.quality];
    if (now - lastAdapt > 600) {
      lastAdapt = now;
      if (state.adaptive) {
        if (fpsEma < 40 && scale > 0.25) scale = Math.max(0.25, scale * 0.85);
        else if (fpsEma > 56 && scale < q.maxScale) scale = Math.min(q.maxScale, scale * 1.1);
      } else scale = q.maxScale;
      scale = Math.round(scale * 40) / 40;
    }
    resize();

    const cam = cameraBasis(state);
    const tanHalf = Math.tan(state.fov * Math.PI / 360);

    // 1. Трассировка лучей → HDR
    gl.bindFramebuffer(gl.FRAMEBUFFER, hdr.fb);
    gl.viewport(0, 0, rtW, rtH);
    gl.useProgram(progBH.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, lutTex);
    setUniforms(progBH, {
      uRes: [rtW, rtH], uCamPos: cam.pos, uCamRight: cam.right, uCamUp: cam.up, uCamFwd: cam.fwd,
      uTanHalf: tanHalf, uTime: simTime, uRin: R_ISCO, uRout: state.rout,
      uTscale: state.tmax / peak.f, uObsG: 1 / Math.sqrt(1 - 2 / state.dist),
      uMaxSteps: { int: q.steps }, uStepK: q.stepK, uREsc: Math.max(state.dist * 1.02, state.rout * 2.5, 50),
      uDoppler: state.doppler, uGrav: state.grav, uBeaming: state.beaming, uDisk: state.disk,
      uStars: state.stars, uMilky: state.milky, uTurb: state.turb, uMode: { int: state.mode },
      uBB: { int: 0 }, uLogTmin: Math.log(LUT_TMIN), uLogTmax: Math.log(LUT_TMAX),
      uStarBright: state.starBright, uMilkyBright: 0.06, uDiskBright: 1.0, uGal: gal,
    });
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // 2. Ореол: понижение
    const raw = state.mode !== 0;
    if (!raw && state.bloom > 0) {
      gl.useProgram(progBloom.p);
      let src = hdr;
      for (const t of bloom) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
        gl.viewport(0, 0, t.w, t.h);
        gl.bindTexture(gl.TEXTURE_2D, src.tex);
        setUniforms(progBloom, { uSrc: { int: 0 }, uTexel: [1 / src.w, 1 / src.h], uUp: { int: 0 } });
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        src = t;
      }
      // повышение с накоплением
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      for (let i = bloom.length - 2; i >= 0; i--) {
        const s = bloom[i + 1], d = bloom[i];
        gl.bindFramebuffer(gl.FRAMEBUFFER, d.fb);
        gl.viewport(0, 0, d.w, d.h);
        gl.bindTexture(gl.TEXTURE_2D, s.tex);
        setUniforms(progBloom, { uSrc: { int: 0 }, uTexel: [1 / s.w, 1 / s.h], uUp: { int: 1 } });
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      gl.disable(gl.BLEND);
    }

    // 3. Итог на экран
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvasW, canvasH);
    gl.useProgram(progPost.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, hdr.tex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, bloom[0].tex);
    setUniforms(progPost, {
      uHdr: { int: 0 }, uBloom: { int: 1 }, uExposure: Math.pow(2, state.exposure),
      uBloomStr: state.bloom, uBloomNorm: 1 / BLOOM_LEVELS, uRaw: { int: raw ? 1 : 0 },
    });
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);

    // Угловой радиус тени для статического наблюдателя: sin α = √27·√(1−2/D)/D
    const sinA = Math.min(1, B_CRIT * Math.sqrt(1 - 2 / state.dist) / state.dist);
    const alpha = Math.asin(sinA);
    drawOverlay(alpha, tanHalf);

    if (now - lastInfo > 250) {
      lastInfo = now;
      info.innerHTML =
        `${fpsEma.toFixed(0)} к/с · трассировка ${rtW}×${rtH} (${Math.round(scale * 100)}%)<br>` +
        `t = ${simTime.toFixed(0)} M · угловой радиус тени ${(alpha * 180 / Math.PI).toFixed(2)}°`;
    }
    requestAnimationFrame(frame);
  }

  function drawOverlay(alpha, tanHalf) {
    const W = overlay.width, H = overlay.height;
    octx.clearRect(0, 0, W, H);
    if (!state.overlay) return;
    const R = Math.tan(alpha) / tanHalf * H / 2;
    const k = (window.devicePixelRatio || 1);
    octx.save();
    octx.strokeStyle = 'rgba(120,220,255,0.8)';
    octx.lineWidth = 1.2 * k;
    octx.setLineDash([6 * k, 6 * k]);
    octx.beginPath(); octx.arc(W / 2, H / 2, R, 0, Math.PI * 2); octx.stroke();
    octx.setLineDash([]);
    octx.fillStyle = 'rgba(160,230,255,0.95)';
    octx.font = `${12 * k}px system-ui, sans-serif`;
    const label = 'критическая кривая  b = √27 M ≈ 5.196 M';
    const tw = octx.measureText(label).width;
    const lx = Math.min(W / 2 + R * 0.72 + 6 * k, W - tw - 8 * k);
    const ly = Math.max(H / 2 - R * 0.72 - 6 * k, 20 * k);
    octx.fillText(label, lx, ly);
    octx.restore();
  }

  requestAnimationFrame(frame);
}

main().catch(e => { if (errBox.style.display !== 'block') fail(String(e && e.stack || e)); });
