/**
 * dom.js —— DOM 原语（安全渲染：只用 textContent / setAttribute，绝不 innerHTML 塞用户内容）
 */

/** 建元素：el('div', {class:'x', dataset:{a:1}}, [child, 'text']) */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;              // 仅用于内部可信模板
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key === 'on' && typeof value === 'object') {
      for (const [evt, fn] of Object.entries(value)) node.addEventListener(evt, fn);
    } else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  append(node, children);
  return node;
}

export function append(parent, children) {
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(parent, child);
    else if (child instanceof Node) parent.appendChild(child);
    else parent.appendChild(document.createTextNode(String(child)));
  }
  return parent;
}

export function clear(node) {
  if (node) node.replaceChildren();
  return node;
}

export function frag(children) {
  const f = document.createDocumentFragment();
  append(f, children);
  return f;
}

/** 外链：统一 rel/target */
export function link(href, text, attrs = {}) {
  const external = /^https?:/i.test(href || '');
  return el('a', {
    href,
    text,
    ...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {}),
    ...attrs,
  });
}

/**
 * 图片位：有图就显示，缺图渲染"虚线占位框 + 目标路径"，方便按路径补图。
 * @param {string} src        目标路径（可为空 → 直接占位）
 * @param {object} opts       { alt, srcset, width, height, ratio, eager, caption, compact }
 *                            caption：缺图时的文案（调用方传入，可翻译）；compact：小方块只放一个符号，避免文字被挤成竖排
 */
export function imageSlot(src, opts = {}) {
  const { alt = '', srcset, width, height, eager = false, caption = '', compact = false } = opts;
  const box = el('span', { class: `slot${compact ? ' slot-compact' : ''}` });
  if (opts.ratio) box.style.aspectRatio = opts.ratio;
  if (width) box.style.width = typeof width === 'number' ? `${width}px` : width;

  const placeholder = () => {
    clear(box);
    // 面向用户只说一句"配图准备中"；具体路径放到 title 里（作者悬停可见），不往公开页面写内部信息。
    // 只渲染一份文案（之前硬写一份 + caption 又传一份，页面上会重复出现两次）。
    const label = compact ? '＋' : (caption || '配图准备中');
    append(box, el('span', {
      class: 'slot-missing',
      title: src ? `待放图：${src}` : '',
      'aria-label': caption || '配图准备中',
      text: label,
    }));
  };

  if (!src || src.includes('{{')) {
    placeholder();
    return box;
  }

  const img = el('img', {
    src,
    alt,
    loading: eager ? 'eager' : 'lazy',
    decoding: 'async',
    ...(srcset ? { srcset: Object.entries(srcset).map(([w, u]) => `${u} ${w}w`).join(', '), sizes: '(max-width: 720px) 100vw, 50vw' } : {}),
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
  });
  img.addEventListener('error', placeholder, { once: true });
  append(box, img);
  return box;
}

/** 后台背景轮播（hero 用）：交叉淡入 + LQIP 打底，可见性变化时暂停 */
export function backgroundStage(container, backgrounds = [], { intervalMs = 9000, lqip = true } = {}) {
  clear(container);
  if (!backgrounds.length) return () => {};

  const layers = [];
  for (const bg of backgrounds) {
    if (typeof bg === 'string') {
      const layer = el('div', { class: 'bg-layer', style: { backgroundImage: `url("${bg}")` } });
      container.appendChild(layer);
      layers.push(layer);
      continue;
    }
    // ⚠️ 多层 background-image 的**第一个在最上面**：必须是清晰图在前、模糊占位(LQIP)在后，
    // 否则整块背景永远是那张 32px 的糊图（这就是"看不出有底图"的元凶之一）。
    const image = bg.lqip ? `url("${bg.src}"), url("${bg.lqip}")` : `url("${bg.src}")`;
    const layer = el('div', {
      class: 'bg-layer',
      style: { backgroundImage: image },
      dataset: { id: bg.id || '', role: bg.role || '' },
    });
    container.appendChild(layer);
    layers.push(layer);
  }
  container.appendChild(el('div', { class: 'bg-veil' }));

  let index = 0;
  let timer = null;
  const show = (i) => {
    layers.forEach((layer, k) => layer.classList.toggle('is-active', k === i));
  };
  const next = () => { index = (index + 1) % layers.length; show(index); };

  show(0);
  if (layers.length > 1 && !prefersReducedMotion()) {
    timer = setInterval(() => { if (!document.hidden) next(); }, intervalMs);
  }
  return () => { if (timer) clearInterval(timer); };
}

/** 装饰用浮尘（纯 CSS 动画，≤14 个，避免耗电） */
export function motes(container, count = 12) {
  for (let i = 0; i < count; i += 1) {
    const mote = el('span', { class: 'mote', 'aria-hidden': 'true' });
    mote.style.left = `${Math.round(Math.random() * 100)}%`;
    mote.style.bottom = `-${Math.round(Math.random() * 20)}px`;
    mote.style.animationDuration = `${14 + Math.round(Math.random() * 16)}s`;
    mote.style.animationDelay = `${Math.round(Math.random() * 12)}s`;
    mote.style.opacity = String(0.25 + Math.random() * 0.4);
    if (i % 3 === 0) mote.style.background = 'var(--c-teal-light)';
    container.appendChild(mote);
  }
}

export function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** 滚动显现（IntersectionObserver，元素进入视口后不再观察） */
export function revealOnScroll(root, selector = '.reveal, .reveal-stagger') {
  const nodes = root.querySelectorAll(selector);
  if (!nodes.length) return () => {};
  if (prefersReducedMotion() || !('IntersectionObserver' in window)) {
    nodes.forEach((n) => n.classList.add('is-visible'));
    return () => {};
  }
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        io.unobserve(entry.target);
      }
    }
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
  nodes.forEach((n) => io.observe(n));
  return () => io.disconnect();
}

/**
 * 立刻把动态重渲染出来的元素标为可见。
 * 用于"页面内二次渲染"（例如从关卡详情点回三大层）：这些元素带着 .reveal-stagger
 * 的初始 opacity:0，如果没人为它们挂观察器就会**整块看不见**（曾经因此出现过"点返回变空"）。
 */
export function revealNow(root, selector = '.reveal, .reveal-stagger') {
  try {
    root.querySelectorAll(selector).forEach((n) => n.classList.add('is-visible'));
    if (root.classList && (root.classList.contains('reveal') || root.classList.contains('reveal-stagger'))) {
      root.classList.add('is-visible');
    }
  } catch { /* 忽略 */ }
}

/** 数字滚动（0 → target），只在需要时跑一次 */
export function countUp(node, target, { durationMs = 1100, suffix = '', format = (n) => n.toLocaleString('en-US') } = {}) {
  if (prefersReducedMotion() || !Number.isFinite(target)) {
    node.textContent = `${format(target)}${suffix}`;
    return () => {};
  }
  const start = performance.now();
  let raf = null;
  const step = (now) => {
    const p = Math.min(1, (now - start) / durationMs);
    const eased = 1 - (1 - p) ** 3;
    node.textContent = `${format(Math.round(target * eased))}${suffix}`;
    if (p < 1) raf = requestAnimationFrame(step);
    else { node.classList.remove('is-counting'); }
  };
  node.classList.add('is-counting');
  raf = requestAnimationFrame(step);
  return () => { if (raf) cancelAnimationFrame(raf); };
}

export function whenVisible(node, cb, { threshold = 0.3 } = {}) {
  if (!('IntersectionObserver' in window)) { cb(); return () => {}; }
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) { cb(); io.disconnect(); }
    }
  }, { threshold });
  io.observe(node);
  return () => io.disconnect();
}

/* ------------------------------------------------------------------ Toast */
export function toast(message, { type = 'info', timeoutMs = 2600 } = {}) {
  const stack = document.getElementById('toastStack');
  if (!stack) return;
  const node = el('div', { class: `toast${type === 'error' ? ' is-error' : ''}`, text: message, role: 'status' });
  stack.appendChild(node);
  setTimeout(() => {
    node.style.transition = 'opacity 220ms ease, transform 220ms ease';
    node.style.opacity = '0';
    node.style.transform = 'translateY(6px)';
    setTimeout(() => node.remove(), 240);
  }, timeoutMs);
}

/** 复制到剪贴板（失败回退 execCommand） */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** 占位符渲染：{{KEY}} 已经由服务端替换成空串 → 这里按"待补充"呈现 */
export function textOrPending(value, fallbackLabel = '') {
  const text = typeof value === 'string' ? value.trim() : value;
  if (!text) return el('span', { class: 'pending', title: fallbackLabel || '内容待补充' });
  return document.createTextNode(text);
}
