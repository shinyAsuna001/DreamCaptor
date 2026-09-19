/**
 * components.js —— 头部 / 页脚 / 首屏 / 通用零件
 */

import { el, append, clear, link, imageSlot, backgroundStage, motes, countUp, whenVisible, copyText, toast, textOrPending, prefersReducedMotion } from './dom.js';
import { t, getLang, getContent, getUser, toggleLang } from './store.js';

/* ------------------------------------------------------------------ 头部 */
export function renderHeader() {
  const content = getContent();
  const navList = document.getElementById('navList');
  const brandText = document.getElementById('brandText');
  const langNow = document.getElementById('langNow');
  const langAlt = document.getElementById('langAlt');

  if (brandText) brandText.textContent = t(content.meta && content.meta.siteNameShort) || t(content.meta && content.meta.siteName);
  if (langNow) langNow.textContent = getLang() === 'zh' ? '中' : 'EN';
  if (langAlt) langAlt.textContent = getLang() === 'zh' ? 'EN' : '中';

  if (navList) {
    clear(navList);
    const path = window.location.pathname.replace(/\/+$/, '') || '/';
    for (const item of content.nav || []) {
      const isActive = item.path === '/' ? path === '/' : path.startsWith(item.path);
      navList.appendChild(el('li', {}, [
        el('a', { class: `nav-link${isActive ? ' is-active' : ''}`, href: item.path, text: t(item.label), 'data-link': true }),
      ]));
    }
  }

  const userArea = document.getElementById('userArea');
  if (userArea) {
    clear(userArea);
    const user = getUser();
    if (user) {
      append(userArea, [
        el('span', { class: 'user-name', text: user.username, title: user.username }),
        el('button', { class: 'btn btn-sm btn-ghost', text: getLang() === 'zh' ? '退出' : 'Sign out', on: { click: async () => {
          const { api } = await import('./api.js');
          await api.logout();
          const { setUser } = await import('./store.js');
          setUser(null);
          toast(getLang() === 'zh' ? '已退出登录' : 'Signed out');
        } } }),
      ]);
    } else {
      append(userArea, [
        el('a', { class: 'btn btn-sm btn-ghost', href: '/login', text: getLang() === 'zh' ? '登录' : 'Sign in', 'data-link': true }),
      ]);
    }
  }
}

/* ------------------------------------------------------------------ 页脚 */
export function renderFooter() {
  const content = getContent();
  const footer = document.getElementById('siteFooter');
  if (!footer) return;
  const meta = content.meta || {};
  const f = content.footer || {};
  clear(footer);

  const groups = [];
  groups.push(el('div', {}, [
    el('h3', { text: t(meta.siteName) }),
    el('p', { class: 'small muted', text: t(meta.slogan) }),
    el('p', { class: 'small faint', text: `${meta.mcVersion || ''} · ${t(meta.versionLabel)}` }),
  ]));

  if (content.community && (content.community.qqGroups || []).length) {
    groups.push(el('div', {}, [
      el('h4', { text: getLang() === 'zh' ? '官方群' : 'QQ groups' }),
      el('ul', { class: 'footer-links' }, (content.community.qqGroups || []).map((g) => el('li', {},
        [
          el('span', { class: 'small', text: `${t(g.name)}：` }),
          // 没有可用的加群链接时就写纯文本群号（qm.qq.com 的猜链接会 404，已弃用）
          g.url && !String(g.url).includes('{{')
            ? link(g.url, g.number)
            : el('span', { class: 'small', text: g.number }),
        ]))),
    ]));
  }

  if ((f.links || []).length) {
    groups.push(el('div', {}, [
      el('h4', { text: getLang() === 'zh' ? '相关链接' : 'Links' }),
      el('ul', { class: 'footer-links' }, (f.links || []).map((l) => el('li', {}, [link(l.href, t(l.label))]))),
    ]));
  }

  // 「关于本站」：作者那一行如果配了 footer.authorUrl，就渲染成可点的链接（指回个人页之类）
  const authorText = t(f.author) || t(f.note) || (getLang() === 'zh' ? '网站作者：shiny_Asuna' : 'Site by shiny_Asuna');
  const authorUrl = t(f.authorUrl);
  const hasAuthorUrl = Boolean(authorUrl) && !authorUrl.includes('{{');
  const authorNode = el('p', { class: 'small' },
    hasAuthorUrl ? [link(authorUrl, authorText)] : [document.createTextNode(authorText)]);
  append(authorNode, t(f.authorNote) ? [el('span', { class: 'faint', text: ` ${t(f.authorNote)}` })] : []);

  groups.push(el('div', {}, [
    el('h4', { text: getLang() === 'zh' ? '关于本站' : 'About this site' }),
    authorNode,
    t(f.build) ? el('p', { class: 'small', text: t(f.build) }) : null,
  ]));

  append(footer, el('div', { class: 'shell' }, [
    el('div', { class: 'footer-grid' }, groups),
    el('div', { class: 'footer-bottom' }, [
      // 只留备案信息；原先右下角还印着 `dataVersion N`（内部版本号，不该给访客看）
      el('span', { class: 'footer-icp' }, [
        link(meta.icp ? meta.icp.url : 'https://beian.miit.gov.cn/', meta.icp ? meta.icp.text : ''),
        el('span', { text: '　|　' }),
        link(meta.police ? meta.police.url : 'http://www.beian.gov.cn/', meta.police ? meta.police.text : ''),
      ]),
    ]),
  ]));
}

/* ------------------------------------------------------------------ 通用零件 */
export function sectionTitle(text, id) {
  return el('h2', { class: 'section-title', text, ...(id ? { id } : {}) });
}

export function card(children, attrs = {}) {
  return el('div', { class: 'card', ...attrs }, children);
}

export function tagList(items, className = 'tag') {
  const list = (items || []).filter(Boolean);
  if (!list.length) return null;
  return el('div', { class: 'tags' }, list.map((item) => el('span', {
    class: className === 'tag' && typeof item === 'object' && item.class ? item.class : className,
    text: typeof item === 'object' ? t(item.text || item) : item,
  })));
}

export function notice(text, kind = 'warn') {
  return el('div', { class: `notice${kind === 'danger' ? ' is-danger' : kind === 'info' ? ' is-info' : ''}`, text });
}

export function emptyState(glyph, title, note) {
  return el('div', { class: 'empty-state' }, [
    el('span', { class: 'glyph', text: glyph, 'aria-hidden': 'true' }),
    el('h3', { text: title }),
    note ? el('p', { class: 'muted', text: note }) : null,
  ]);
}

export function disclosure(summaryText, bodyChildren, open = false) {
  return el('details', { class: 'disclosure', ...(open ? { open: true } : {}) }, [
    el('summary', {}, [el('span', { text: summaryText })]),
    el('div', { class: 'disclosure-body' }, bodyChildren),
  ]);
}

export function copyButton(text, label) {
  const btn = el('button', {
    class: 'btn btn-sm btn-ghost',
    type: 'button',
    text: label || (getLang() === 'zh' ? '复制' : 'Copy'),
  });
  btn.addEventListener('click', async () => {
    const ok = await copyText(text);
    toast(ok ? (getLang() === 'zh' ? '已复制' : 'Copied') : (getLang() === 'zh' ? '复制失败，请手动选择' : 'Copy failed'), { type: ok ? 'info' : 'error' });
  });
  return btn;
}

/** 占位符值 → 可点击按钮 或 "待补充" */
export function actionButton(label, url) {
  if (!url || String(url).includes('{{') || !String(url).trim()) {
    return el('span', { class: 'btn btn-sm is-disabled', 'aria-disabled': 'true' }, [
      el('span', { text: label }),
      el('span', { class: 'pending' }),
    ]);
  }
  return link(url, label, { class: 'btn btn-sm btn-primary' });
}

/* ------------------------------------------------------------------ 放大详情弹窗 */
let activeModal = null;

/**
 * 打开一个放大详情弹窗（卡片点击 → 看大图与完整描述）。
 * 传 origin（被点击的卡片元素）时会做 **FLIP 动画**：从卡片原位放大到屏幕中央；关闭时反向缩回原位。
 * @returns {Function} 关闭函数
 */
export function openModal({ kicker, title, meta = [], body, wide = false, origin = null, onClose }) {
  if (activeModal) activeModal();          // 同时只留一个
  const previousFocus = document.activeElement;
  const root = el('div', { class: 'modal-root', role: 'dialog', 'aria-modal': 'true', 'aria-label': title || '详情' });
  const backdrop = el('div', { class: 'modal-backdrop' });
  const closeBtn = el('button', { class: 'modal-close', type: 'button', 'aria-label': getLang() === 'zh' ? '关闭' : 'Close', text: '×' });
  const panel = el('div', { class: `modal-panel${wide ? ' is-wide' : ''}` }, [
    closeBtn,
    kicker ? el('div', { class: 'modal-kicker', text: kicker }) : null,
    el('h2', { class: 'modal-title', text: title || '' }),
    meta.length ? el('div', { class: 'modal-meta' }, meta) : null,
    el('div', { class: 'modal-body' }, body),
  ]);
  append(root, [backdrop, panel]);

  /** 取元素矩形（DOM 桩/无布局环境下安全返回 null） */
  const rectOf = (node) => {
    try {
      if (!node || typeof node.getBoundingClientRect !== 'function') return null;
      const r = node.getBoundingClientRect();
      return r && r.width > 1 && r.height > 1 ? r : null;
    } catch { return null; }
  };
  const canAnimate = () => origin && !prefersReducedMotion() && typeof panel.animate !== 'undefined';

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    window.removeEventListener('keydown', onKey);
    document.body.classList.remove('no-scroll');
    root.remove();
    if (activeModal === close) activeModal = null;
    if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
    if (typeof onClose === 'function') onClose();
  };

  const close = () => {
    if (finished) return;
    const from = rectOf(origin);
    const to = rectOf(panel);
    if (canAnimate() && from && to) {
      // 反向 FLIP：缩回卡片原位
      const scale = Math.max(0.08, Math.min(from.width / to.width, from.height / to.height));
      const dx = (from.left + from.width / 2) - (to.left + to.width / 2);
      const dy = (from.top + from.height / 2) - (to.top + to.height / 2);
      panel.style.transition = 'transform 240ms cubic-bezier(0.4, 0, 0.7, 1), opacity 220ms ease';
      panel.style.transformOrigin = 'center center';
      panel.style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`;
      panel.style.opacity = '0';
      backdrop.style.transition = 'opacity 220ms ease';
      backdrop.style.opacity = '0';
      setTimeout(finish, 250);
      return;
    }
    finish();
  };

  const onKey = (event) => { if (event.key === 'Escape') close(); };
  backdrop.addEventListener('click', close);
  closeBtn.addEventListener('click', close);
  window.addEventListener('keydown', onKey);

  document.body.appendChild(root);
  document.body.classList.add('no-scroll');
  activeModal = close;

  // 正向 FLIP：从卡片的位置与大小，放大过渡到屏幕中央
  const from = rectOf(origin);
  const to = rectOf(panel);
  if (canAnimate() && from && to) {
    const scale = Math.max(0.08, Math.min(from.width / to.width, from.height / to.height));
    const dx = (from.left + from.width / 2) - (to.left + to.width / 2);
    const dy = (from.top + from.height / 2) - (to.top + to.height / 2);
    panel.style.transition = 'none';
    panel.style.transformOrigin = 'center center';
    panel.style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`;
    panel.style.opacity = '0.4';
    panel.style.animation = 'none';                 // 关掉 CSS 的入场动画，交给 FLIP
    // 强制回流后再开过渡
    void panel.offsetWidth;
    requestAnimationFrame(() => {
      panel.style.transition = 'transform 300ms cubic-bezier(0.16, 1, 0.3, 1), opacity 240ms ease';
      panel.style.transform = 'translate(0, 0) scale(1)';
      panel.style.opacity = '1';
    });
  }

  closeBtn.focus();
  return close;
}

/* ------------------------------------------------------------------ 首屏 */
export function heroSection() {
  const content = getContent();
  const hero = content.hero || {};
  const wrap = el('section', { class: 'hero' });
  const logo = el('img', {
    class: 'hero-logo',
    src: hero.titleArt || '/assets/img/logo-512.webp',
    ...(hero.titleArtSrcset ? { srcset: Object.entries(hero.titleArtSrcset).map(([w, u]) => `${u} ${w}w`).join(', '), sizes: '(max-width: 720px) 60vw, 380px' } : {}),
    alt: t(content.meta && content.meta.siteName),
    width: 512,
    height: 511,
    fetchpriority: 'high',
    decoding: 'async',
  });

  const slots = [];
  const stats = el('div', { class: 'stat-row reveal-stagger' }, (content.stats || []).map((stat) => {
    const valueNode = el('div', { class: 'stat-value' });
    const display = stat.display || (stat.value !== null && stat.value !== undefined ? stat.value : '');
    const node = el('div', { class: 'stat', dataset: { statId: stat.id || '' } }, [
      valueNode,
      el('div', { class: 'stat-label', text: t(stat.label) }),
      stat.note ? el('div', { class: 'stat-note', text: t(stat.note) }) : null,
    ]);
    if (typeof stat.value === 'number' && !stat.display) {
      valueNode.textContent = '0';
      whenVisible(node, () => countUp(valueNode, stat.value, { suffix: stat.suffix || '' }));
    } else {
      valueNode.textContent = String(display);
      if (stat.suffix) valueNode.appendChild(el('span', { class: 'suffix', text: stat.suffix }));
    }
    slots.push({ stat, node, valueNode });
    return node;
  }));

  // 带 derive 的数字：从百科数据集实时加算后再滚动到真实值
  if ((content.stats || []).some((s) => s && s.derive)) {
    import('./store.js').then(({ resolveStats }) => resolveStats(content.stats)).then((resolved) => {
      resolved.forEach((stat, i) => {
        if (!stat || !stat.derive) return;
        const slot = slots[i];
        if (!slot || typeof stat.value !== 'number') return;
        if (!document.body.contains(slot.node)) return;      // 已经切页了，别再动
        countUp(slot.valueNode, stat.value, { suffix: stat.suffix || '' });
      });
    }).catch(() => { /* 加算失败就保留 fallback 值 */ });
  }

  append(wrap, el('div', { class: 'shell hero-inner' }, [
    logo,
    el('div', { class: 'hero-kicker', text: t(hero.kicker) }),
    el('h1', { class: 'hero-tagline', text: t(hero.tagline) || t(content.meta && content.meta.slogan) }),
    el('div', { class: 'hero-cta' }, (hero.cta || []).map((c) => el('a', {
      class: `btn ${c.style === 'primary' ? 'btn-primary' : 'btn-ghost'}`,
      href: c.href,
      text: t(c.label),
      'data-link': true,
    }))),
    stats,
  ]));
  return wrap;
}

/** 背景层 + 浮尘（全站共用，由 main.js 调用一次） */
export function mountBackdrop() {
  const stage = document.getElementById('bgStage');
  if (!stage) return () => {};
  const content = getContent();
  const hero = content.hero || {};
  const backgrounds = (hero.backgrounds || []).map((bg) => (typeof bg === 'string' ? bg : bg));
  const stopBg = backgroundStage(stage, backgrounds, { intervalMs: 9000 });
  const moteLayer = el('div', { class: 'motes', 'aria-hidden': 'true' });
  stage.appendChild(moteLayer);
  motes(moteLayer, 12);
  return () => { stopBg(); clear(moteLayer); };
}

export { textOrPending, imageSlot, el, append, clear, link };
