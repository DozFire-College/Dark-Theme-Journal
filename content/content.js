/*
 * Тёмный журнал — content script.
 * 1) Мгновенно (до отрисовки) применяет сохранённые настройки, чтобы не было белой вспышки.
 * 2) «Умная подстройка»: находит светлые блоки и тёмный текст, которых нет в theme.css
 *    (например, на страницах оплаты, тестов, магазина), и перекрашивает их под палитру,
 *    а яркие цветные заливки делает темнее (красные — бордовыми).
 */
(() => {
  'use strict';
  if (window.__tjLoaded) return;
  window.__tjLoaded = true;

  const DEFAULTS = { enabled: true, palette: 'graphite', smart: true };
  const CACHE_KEY = '__tj_state';
  const root = document.documentElement;
  let state = { ...DEFAULTS };

  function init() {
    // --- 1. Синхронный старт из кеша страницы (без вспышки) ---
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      if (cached) state = { ...state, ...cached };
    } catch (_) { /* localStorage может быть недоступен */ }
    applyState();

    // --- 2. Актуальные настройки из хранилища расширения ---
    try {
      chrome.storage.sync.get(DEFAULTS, (stored) => {
        state = { ...DEFAULTS, ...stored };
        cacheState();
        applyState();
      });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync') return;
        for (const key of Object.keys(changes)) state[key] = changes[key].newValue;
        cacheState();
        applyState();
      });
    } catch (_) { /* контекст расширения перезагружен */ }
  }

  function cacheState() {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(state)); } catch (_) {}
  }

  function applyState() {
    root.classList.toggle('tj-off', !state.enabled);
    root.classList.toggle('tj-smart', !!(state.enabled && state.smart));
    root.setAttribute('data-tj-palette', state.palette || 'graphite');
    if (state.enabled && state.smart) Smart.start();
    else Smart.stop();
  }

  // =====================================================================
  //  Умная подстройка
  // =====================================================================
  const Smart = (() => {
    const SKIP = new Set([
      'SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'BR', 'WBR',
      'IMG', 'PICTURE', 'VIDEO', 'AUDIO', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED', 'SOURCE', 'HEAD', 'TITLE',
    ]);
    const SVG_SHAPES = new Set(['path', 'circle', 'rect', 'polygon', 'ellipse', 'use', 'g']);
    const BUDGET_MS = 10;

    let observer = null;
    let running = false;
    const pending = [];          // корни поддеревьев, ожидающие обработки
    let walker = null;           // текущий обход
    let scheduled = false;
    const bgState = new WeakMap(); // элемент -> 'dark' | 'light' (фон, на котором лежит его текст)
    const bgLevel = new WeakMap(); // элемент -> уровень «поверхности» 0..3
    let dynSheet = null;
    const tokenByColor = new Map();
    let tokenSeq = 0;

    function start() {
      if (running) return;
      running = true;
      const begin = () => {
        if (!running) return;
        enqueue(document.body, true);
        observer = new MutationObserver(onMutations);
        observer.observe(document.body, {
          childList: true, subtree: true,
          attributes: true, attributeFilter: ['class', 'style'],
        });
      };
      if (document.body) begin();
      else document.addEventListener('DOMContentLoaded', begin, { once: true });
    }

    function stop() {
      running = false;
      if (observer) observer.disconnect();
      observer = null;
      pending.length = 0;
      walker = null;
    }

    function onMutations(records) {
      for (const r of records) {
        if (r.type === 'childList') {
          for (const n of r.addedNodes) if (n.nodeType === 1) enqueue(n, false);
        } else if (r.target.nodeType === 1) {
          enqueue(r.target, true);
        }
      }
      // Обрабатываем сразу (до отрисовки), чтобы новые блоки не мигали белым
      work();
    }

    function enqueue(el, force) {
      if (!el || SKIP.has(el.tagName)) return;
      if (force) el.__tjForce = true;
      pending.push(el);
      schedule();
    }

    function schedule() {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => { scheduled = false; work(); });
    }

    function work() {
      if (!running) return;
      const deadline = performance.now() + BUDGET_MS;
      while (performance.now() < deadline) {
        if (!walker) {
          const next = pending.shift();
          if (!next) return;
          if (!next.isConnected) continue;
          walker = document.createTreeWalker(next, NodeFilter.SHOW_ELEMENT, {
            acceptNode: (n) => (SKIP.has(n.tagName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
          });
          const force = next.__tjForce; next.__tjForce = false;
          processEl(next, force);
        }
        let n;
        let count = 0;
        while ((n = walker.nextNode())) {
          processEl(n, false);
          if (++count % 40 === 0 && performance.now() >= deadline) break;
        }
        if (!n) walker = null;
      }
      if (walker || pending.length) schedule();
    }

    // ------------------------------------------------------------------
    function processEl(el, force) {
      if (!force && bgState.has(el)) return;
      if (force) {
        el.removeAttribute('data-tj-bg');
        el.removeAttribute('data-tj-fg');
        el.removeAttribute('data-tj-bd');
        el.removeAttribute('data-tj-fill');
      }

      const isSvg = el instanceof SVGElement;
      const cs = getComputedStyle(el);
      const parent = el.parentElement;
      const parentState = parent ? (bgState.get(parent) || 'dark') : 'dark';
      const parentLevel = parent ? (bgLevel.has(parent) ? bgLevel.get(parent) : 0) : 0;
      let myState = parentState;
      let myLevel = parentLevel;

      if (isSvg) {
        bgState.set(el, myState);
        bgLevel.set(el, myLevel);
        if (myState === 'dark' && SVG_SHAPES.has(el.tagName)) tagSvgFill(el, cs);
        return;
      }

      // --- Фон ---
      const bg = parseColor(cs.backgroundColor);
      if (bg && bg.a >= 0.5) {
        const hsl = rgbToHsl(bg);
        const lum = relLum(bg);
        if (hsl.l >= 0.72 || lum >= 0.6) {
          // светлый фон
          const rect = el.getBoundingClientRect();
          const tiny = rect.width > 0 && rect.width < 44 && rect.height < 44;
          const hasPicture = cs.backgroundImage !== 'none' || el.querySelector(':scope > img, :scope > svg');
          if (tiny && hasPicture) {
            myState = 'light'; // маленькая иконка на белой подложке — не трогаем
          } else {
            myLevel = Math.min(parentLevel + 1, 3);
            if (hsl.c < 0.1 || hsl.l > 0.94) {
              el.setAttribute('data-tj-bg', String(isPageRoot(el) ? 0 : myLevel));
            } else {
              // цветная пастельная подложка: сохраняем оттенок, делаем тёмной
              el.setAttribute('data-tj-bg', token('bg', `hsl(${hsl.h} ${Math.round(Math.min(hsl.s, 0.45) * 100)}% ${14 + myLevel * 3}%)`));
            }
            myState = 'dark';
          }
        } else if (!isThemeColor(bg) && ((hsl.c >= 0.15 && lum > 0.07) || lum > 0.38)) {
          // яркая цветная заливка (кнопки, плашки, значки): тот же оттенок, но темнее;
          // красный уходит в бордовый
          el.setAttribute('data-tj-bg', token('bg', dimFill(hsl, bg.a)));
          // рамка того же цвета, что и заливка (кнопки Bootstrap), темнеет вместе с ней
          if (cs.borderTopWidth !== '0px') {
            const bc = parseColor(cs.borderTopColor);
            if (bc && bc.a >= 0.5 && bc.r === bg.r && bc.g === bg.g && bc.b === bg.b) {
              el.setAttribute('data-tj-bd', token('bd', dimFill(hsl, bc.a)));
            }
          }
          myState = 'dark';
        } else {
          myState = lum > 0.38 ? 'light' : 'dark';
          if (myState === 'dark') myLevel = nearestLevel(lum, parentLevel);
        }
      }
      bgState.set(el, myState);
      bgLevel.set(el, myLevel);

      if (myState !== 'dark') return;

      // --- Светлые рамки ---
      if (cs.borderTopWidth !== '0px' || cs.borderBottomWidth !== '0px' || cs.borderLeftWidth !== '0px') {
        const bc = parseColor(cs.borderTopColor) || parseColor(cs.borderBottomColor);
        if (bc && bc.a > 0.3 && relLum(bc) > 0.55 && rgbToHsl(bc).c < 0.12) el.setAttribute('data-tj-bd', '');
      }

      // --- Тёмный текст ---
      if (!hasOwnText(el) && !isFormField(el)) return;
      const fg = parseColor(cs.color);
      if (!fg || fg.a < 0.3) return;
      const lum = relLum(fg);
      if (lum >= 0.28) return; // текст и так светлый
      const hsl = rgbToHsl(fg);
      if (hsl.c < 0.12) {
        el.setAttribute('data-tj-fg', lum < 0.06 ? 't' : 's');
      } else {
        // цветной тёмный текст (ссылки, статусы) — тот же оттенок, но светлее
        el.setAttribute('data-tj-fg', token('fg', `hsl(${hsl.h} ${Math.round(Math.max(hsl.s, 0.55) * 100)}% ${isRed(hsl.h) ? 60 : 64}%)`));
      }
    }

    function tagSvgFill(el, cs) {
      const fill = parseColor(cs.fill);
      if (!fill || fill.a < 0.3) return;
      if (relLum(fill) > 0.12 || rgbToHsl(fill).c > 0.12) return;
      const svg = el.ownerSVGElement;
      if (!svg) return;
      const r = svg.getBoundingClientRect();
      if (r.width > 64 || r.height > 64) return; // только мелкие иконки, не графики и логотипы
      el.setAttribute('data-tj-fill', '');
    }

    // Уровень уже тёмного блока: ближайший по яркости цвет палитры (фон / поверхность / приподнятый)
    let lumCache = { key: null, lums: null };
    function paletteLums() {
      const key = root.getAttribute('data-tj-palette');
      if (lumCache.key !== key) {
        const cs = getComputedStyle(root);
        lumCache = {
          key,
          lums: ['--tj-bg', '--tj-surface', '--tj-raised', '--tj-raised-2'].map((v) => hexLum(cs.getPropertyValue(v))),
        };
      }
      return lumCache.lums;
    }

    function nearestLevel(lum, fallback) {
      const lums = paletteLums();
      if (lums.some((l) => l == null)) return fallback;
      if (lum > lums[3] + 0.03) return 3;
      let best = 0;
      for (let i = 1; i < lums.length; i++) if (Math.abs(lums[i] - lum) < Math.abs(lums[best] - lum)) best = i;
      return best;
    }

    function hexLum(v) {
      const n = hexInt(v);
      return n == null ? null : relLum({ r: n >> 16, g: (n >> 8) & 255, b: n & 255 });
    }

    function hexInt(v) {
      const m = (v || '').trim().match(/^#([0-9a-f]{6})$/i);
      return m ? parseInt(m[1], 16) : null;
    }

    // Цвета, которые уже задала сама тема (theme.css), повторно не затемняем
    const THEME_VARS = [
      '--tj-bg', '--tj-surface', '--tj-raised', '--tj-raised-2', '--tj-border',
      '--tj-accent', '--tj-accent-strong', '--tj-danger', '--tj-danger-line', '--tj-danger-soft',
      '--tj-danger-fill', '--tj-danger-fill-2', '--tj-today', '--tj-today-border',
      '--tj-success', '--tj-warning', '--tj-violet', '--tj-link',
      '--tj-fill-cyan', '--tj-fill-teal', '--tj-fill-mint', '--tj-fill-amber', '--tj-fill-slate', '--tj-fill-gray',
      '--tj-mark-hw', '--tj-mark-lab', '--tj-mark-class', '--tj-mark-control', '--tj-mark-practice', '--tj-mark-final',
    ];
    let themeCache = { key: null, set: null };
    function isThemeColor({ r, g, b }) {
      const key = root.getAttribute('data-tj-palette');
      if (themeCache.key !== key) {
        const cs = getComputedStyle(root);
        const set = new Set();
        for (const v of THEME_VARS) {
          const n = hexInt(cs.getPropertyValue(v));
          if (n != null) set.add(n);
        }
        themeCache = { key, set };
      }
      return themeCache.set.has((r << 16) | (g << 8) | b);
    }

    function isRed(h) {
      return h >= 335 || h <= 12;
    }

    // Яркая заливка -> приглушённая: красные оттенки становятся бордовыми, остальные просто темнее
    function dimFill({ h, s, l }, alpha) {
      const red = isRed(h);
      const sat = Math.min(s, red ? 0.66 : 0.8);
      const light = red ? Math.min(l * 0.66, 0.32) : Math.min(l * 0.78, 0.44);
      const a = alpha < 1 ? ` / ${alpha}` : ''; // полупрозрачные накладки остаются полупрозрачными
      return `hsl(${h} ${Math.round(sat * 100)}% ${Math.round(light * 100)}%${a})`;
    }

    function isPageRoot(el) {
      return el === document.body || el.parentElement === document.body;
    }

    function hasOwnText(el) {
      for (let n = el.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 3 && n.nodeValue.trim()) return true;
      }
      return false;
    }

    function isFormField(el) {
      return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
    }

    // Для цветных оттенков создаём CSS-правило один раз на цвет
    function token(kind, color) {
      const key = kind + '|' + color;
      let t = tokenByColor.get(key);
      if (t) return t;
      t = 'h' + (++tokenSeq);
      tokenByColor.set(key, t);
      if (!dynSheet) {
        const style = document.createElement('style');
        style.id = 'tj-dynamic';
        (document.head || root).appendChild(style);
        dynSheet = style.sheet;
      }
      const prop = kind === 'bg' ? 'background-color' : kind === 'bd' ? 'border-color' : 'color';
      const attr = kind === 'bg' ? 'data-tj-bg' : kind === 'bd' ? 'data-tj-bd' : 'data-tj-fg';
      // у рамок селектор удвоен, чтобы перебить общее правило [data-tj-bd] из theme.css
      const sel = kind === 'bd' ? `[${attr}="${t}"][${attr}]` : `[${attr}="${t}"]`;
      try {
        dynSheet.insertRule(`html.tj-smart:not(.tj-off) ${sel}{${prop}:${color} !important}`, dynSheet.cssRules.length);
      } catch (_) {}
      return t;
    }

    // --- цветовые утилиты ---
    function parseColor(str) {
      if (!str) return null;
      const m = str.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    }

    function relLum({ r, g, b }) {
      const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    }

    function rgbToHsl({ r, g, b }) {
      r /= 255; g /= 255; b /= 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const l = (max + min) / 2;
      let h = 0, s = 0;
      if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h *= 60;
      }
      return { h: Math.round(h), s, l, c: max - min };
    }

    return { start, stop };
  })();

  init();
})();
