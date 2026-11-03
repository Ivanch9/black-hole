// Панель управления без внешних библиотек.
import { PRESETS, LIMITS } from './camera.js';

export function buildUI(root, state, onChange) {
  const refreshers = [];
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

  const section = (title, open = true) => {
    const d = el('details', 'sec'); d.open = open;
    d.appendChild(el('summary', null, title));
    root.appendChild(d);
    return d;
  };

  const slider = (parent, label, key, min, max, step, fmt = v => v, hint) => {
    const row = el('label', 'row');
    const name = el('span', 'name', label);
    if (hint) name.title = hint;
    const val = el('span', 'val');
    const inp = el('input'); inp.type = 'range'; inp.min = min; inp.max = max; inp.step = step;
    inp.addEventListener('input', () => { state[key] = parseFloat(inp.value); val.textContent = fmt(state[key]); onChange(key); });
    row.append(name, val, inp);
    parent.appendChild(row);
    const refresh = () => { inp.value = state[key]; val.textContent = fmt(state[key]); };
    refreshers.push(refresh); refresh();
  };

  const check = (parent, label, key, hint) => {
    const row = el('label', 'chk');
    const inp = el('input'); inp.type = 'checkbox';
    inp.addEventListener('change', () => { state[key] = inp.checked; onChange(key); });
    const span = el('span', null, label);
    if (hint) row.title = hint;
    row.append(inp, span);
    parent.appendChild(row);
    const refresh = () => { inp.checked = !!state[key]; };
    refreshers.push(refresh); refresh();
  };

  const select = (parent, label, key, options) => {
    const row = el('label', 'row sel');
    const s = el('select');
    for (const [v, t] of options) { const o = el('option', null, t); o.value = v; s.appendChild(o); }
    s.addEventListener('change', () => { state[key] = isNaN(+s.value) ? s.value : +s.value; onChange(key); });
    row.append(el('span', 'name', label), s);
    parent.appendChild(row);
    const refresh = () => { s.value = state[key]; };
    refreshers.push(refresh); refresh();
  };

  // --- Ракурс ---
  const cam = section('Ракурс');
  const presets = el('div', 'presets');
  for (const [k, p] of Object.entries(PRESETS)) {
    const b = el('button', null, p.label);
    b.addEventListener('click', () => { state.incl = p.incl; onChange('incl'); refresh(); });
    presets.appendChild(b);
  }
  cam.appendChild(presets);
  slider(cam, 'Наклон', 'incl', LIMITS.inclMin, LIMITS.inclMax, 0.5, v => `${v.toFixed(1)}°`, 'Угол между осью диска и лучом зрения');
  slider(cam, 'Азимут', 'azim', 0, 360, 1, v => `${v.toFixed(0)}°`);
  slider(cam, 'Расстояние', 'dist', LIMITS.distMin, LIMITS.distMax, 0.5, v => `${v.toFixed(1)} M`);
  slider(cam, 'Поле зрения', 'fov', 15, 110, 1, v => `${v.toFixed(0)}°`);
  check(cam, 'Медленный облёт', 'autoRotate');

  // --- Физика ---
  const phys = section('Физика');
  slider(phys, 'T<sub>max</sub> диска', 'tmax', 3000, 30000, 100, v => `${v.toFixed(0)} K`, 'Максимальная температура диска в системе газа (на r = 8.17 M)');
  slider(phys, 'Внешний радиус', 'rout', 10, 40, 0.5, v => `${v.toFixed(1)} M`);
  check(phys, 'Доплеровское смещение', 'doppler', 'Движение газа: релятивистский Доплер + поперечный эффект');
  check(phys, 'Гравитационное смещение', 'grav', 'Гравитационное красное смещение √(1−2M/r)');
  check(phys, 'Релятивистское усиление яркости', 'beaming', 'I_ν/ν³ = const ⇒ яркость растёт ∝ g⁴ (beaming)');
  check(phys, 'Турбулентность диска', 'turb');
  check(phys, 'Аккреционный диск', 'disk');
  check(phys, 'Звёзды', 'stars');
  check(phys, 'Млечный Путь', 'milky');

  // --- Время ---
  const tm = section('Время');
  slider(tm, 'Скорость', 'timeSpeed', 0, 300, 1, v => `${v.toFixed(0)} M/с`, 'Сколько единиц GM/c³ проходит за секунду. Для Sgr A* 1 M ≈ 20 с, для M87* ≈ 9 ч');
  check(tm, 'Пауза', 'paused');

  // --- Изображение ---
  const img = section('Изображение');
  select(img, 'Режим', 'mode', [[0, 'Реалистичный'], [1, 'Карта смещения g'], [2, 'Порядок изображений']]);
  slider(img, 'Экспозиция', 'exposure', -5, 4, 0.1, v => `${v > 0 ? '+' : ''}${v.toFixed(1)} EV`);
  slider(img, 'Ореол', 'bloom', 0, 0.3, 0.01, v => v.toFixed(2), 'Рассеяние света в оптике наблюдателя');
  slider(img, 'Яркость звёзд', 'starBright', 0, 4, 0.05, v => v.toFixed(2));
  select(img, 'Качество', 'quality', [['low', 'Низкое'], ['medium', 'Среднее'], ['high', 'Высокое'], ['ultra', 'Ультра (Retina)']]);
  check(img, 'Адаптивное разрешение', 'adaptive', 'Автоматически снижает разрешение трассировки для плавности');
  check(img, 'Критическая кривая (подпись)', 'overlay', 'Граница тени b = √27 M');

  const refresh = () => refreshers.forEach(f => f());
  return { refresh };
}
