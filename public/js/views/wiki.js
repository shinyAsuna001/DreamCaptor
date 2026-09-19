/**
 * views/wiki.js —— 百科（关卡 / 物品 / 职业与天赋 / 敌人 / 难度）
 *
 * 布局约定（按作者反馈重做）：
 *   关卡：先展示三大层卡片 → 点进某一层看该层的三张关卡条目 → 点条目弹窗看大图与详细描述
 *   职业：11 张职业卡 → 点击弹窗看该职业的 8 条天赋（描述里已含数值，不再重复罗列数字）
 *   物品：筛选 + 卡片网格 → 点击弹窗看完整信息（只显示中文等阶，不显示颜色码）
 */
import { el, append, clear, link, imageSlot, revealOnScroll, revealNow, toast } from '../dom.js';
import { t, getContent, getWikiDataset } from '../store.js';
import { sectionTitle, card, notice, emptyState, disclosure, tagList, copyButton, openModal } from '../components.js';

const isEn = () => document.documentElement.lang === 'en';
const L = (zh, en) => (isEn() ? en : zh);

export async function renderWiki(app, params = {}) {
  const pageId = params.page;
  const content = getContent();
  const wiki = content.wiki || {};
  const pages = wiki.pages || [];
  const root = el('div', { class: 'page view-enter' });

  if (!pageId) {
    append(root, el('header', { class: 'page-head shell' }, [
      el('span', { class: 'eyebrow', text: 'Codex' }),
      el('h1', { text: t(wiki.title) }),
      el('p', { text: t(wiki.lead) }),
    ]));
    append(root, el('section', { class: 'shell' }, [
      // 目录固定 5 个入口：写死列数，避免末行只落 1 张、右边空一排
      el('div', { class: 'grid grid-3 grid-cols-5 reveal-stagger' }, pages.map((p) => el('a', {
        class: 'card entry-card', href: p.path, 'data-link': true,
      }, [
        el('h3', { text: t(p.label) }),
        el('p', { text: p.empty ? t(p.emptyNote) : describeDataset(p.dataset) }),
      ]))),
    ]));
    clear(app); app.appendChild(root);
    return revealOnScroll(app);
  }

  const meta = pages.find((p) => p.id === pageId);
  if (!meta) {
    append(root, el('div', { class: 'shell' }, [emptyState('?', L('百科页面不存在', 'Page not found'))]));
    clear(app); app.appendChild(root);
    return () => {};
  }

  append(root, el('header', { class: 'page-head shell' }, [
    el('span', { class: 'eyebrow', text: 'Codex' }),
    el('h1', { text: t(meta.label) }),
    el('div', { class: 'chips', style: { marginTop: 'var(--sp-3)' } }, [
      el('a', { class: 'chip', href: '/wiki', text: L('← 百科目录', '← Codex'), 'data-link': true }),
      ...pages.filter((p) => p.id !== pageId).map((p) => el('a', { class: 'chip', href: p.path, text: t(p.label), 'data-link': true })),
    ]),
  ]));

  const body = el('section', { class: 'shell' });
  append(root, body);
  clear(app); app.appendChild(root);

  if (meta.empty) {
    body.appendChild(emptyState('☾', L('内容整理中', 'Coming soon'), t(meta.emptyNote)));
    return () => {};
  }

  body.appendChild(el('div', { class: 'skeleton', style: { minHeight: '12rem' } }));
  let cleanup = () => {};
  try {
    if (pageId === 'levels') cleanup = await renderLevels(body);
    else if (pageId === 'items') cleanup = await renderItems(body);
    else if (pageId === 'classes') cleanup = await renderClasses(body);
    else body.replaceChildren(emptyState('☾', L('内容整理中', 'Coming soon')));
  } catch (err) {
    body.replaceChildren(emptyState('!', L('数据加载失败', 'Failed to load'), err.message));
  }
  const stopReveal = revealOnScroll(app);
  return () => { cleanup(); stopReveal(); };
}

function describeDataset(name) {
  const map = {
    'wiki-levels': L('三大层、随机关卡池与每关背景故事', 'Chapters, random pools and per-level story'),
    'wiki-items': L('道具与武器全图鉴，按等阶与来源分类', 'Full item & weapon codex with tiers'),
    'wiki-classes': L('11 个职业与各自的 8 条天赋', '11 classes and their talents'),
    'wiki-enemies': L('怪物与 Boss 图鉴（整理中）', 'Bestiary (in progress)'),
    'wiki-difficulty': L('难度机制说明（整理中）', 'Difficulty details (in progress)'),
  };
  return map[name] || '';
}

function tierBadge(tier) {
  if (!tier) return el('span', { class: 'tag', text: L('等阶未定', 'untiered') });
  return el('span', { class: `tier tier-${tier}`, text: tier });
}

/* ------------------------------------------------------------------ 关卡 */
async function renderLevels(container) {
  const data = await getWikiDataset('wiki-levels');
  const levelsById = new Map((data.levels || []).map((l) => [l.id, l]));
  const host = el('div', {});
  let active = null;

  const imageFor = (src, altText, caption) => imageSlot(t(src) || src, {
    alt: altText, ratio: '16 / 9', caption,
  });

  function levelModal(lv, cardEl) {
    const chapter = (data.chapters || []).find((c) => c.id === lv.chapter);
    openModal({
      kicker: chapter ? t(chapter.name) : L('关卡', 'Level'),
      title: t(lv.name),
      wide: true,
      origin: cardEl,
      meta: [
        tierBadgeLess(),
        lv.boss && t(lv.boss) ? el('span', { class: 'tag tag-teal', text: `${L('守关', 'Boss')}: ${t(lv.boss)}` }) : null,
        ...(lv.keywords || []).map((k) => el('span', { class: 'tag', text: t(k) })),
      ].filter(Boolean),
      body: [
        imageFor(lv.image, t(lv.name), L('配图准备中', 'Art coming soon')),
        el('p', { class: 'modal-story', text: t(lv.story) || L('背景故事待补充', 'Story pending') }),
      ],
    });
  }

  function renderChapterView() {
    const chapter = (data.chapters || []).find((c) => c.id === active);
    if (!chapter) return renderChapterList();
    clear(host);
    append(host, el('div', { class: 'breadcrumb' }, [
      el('button', {
        type: 'button',
        text: L('← 返回三大层', '← Back to chapters'),
        on: { click: () => { active = null; renderChapterList(); } },
      }),
      el('span', { class: 'faint', text: '/' }),
      el('span', { text: t(chapter.name) }),
    ]));
    append(host, [
      el('p', { class: 'muted', text: t(chapter.summary) }),
      chapter.pool && t(chapter.pool.note) ? el('p', { class: 'small faint', text: t(chapter.pool.note) }) : null,
      el('h2', { class: 'section-title', style: { marginTop: 'var(--sp-5)' }, text: L('本层的关卡', 'Levels in this chapter') }),
    ]);

    const list = el('div', { class: 'level-list reveal-stagger' });
    for (const id of chapter.levels || []) {
      const lv = levelsById.get(id);
      if (!lv) continue;
      const row = el('article', { class: 'card level-row is-clickable', tabindex: '0', role: 'button' }, [
        imageFor(lv.image, t(lv.name), L('配图准备中', 'Art coming soon')),
        el('div', {}, [
          el('h4', { text: t(lv.name) }),
          el('div', { class: 'tags', style: { marginBottom: 'var(--sp-2)' } }, [
            lv.boss && t(lv.boss) ? el('span', { class: 'tag tag-teal', text: `${L('守关', 'Boss')}: ${t(lv.boss)}` }) : null,
            ...(lv.keywords || []).slice(0, 2).map((k) => el('span', { class: 'tag', text: t(k) })),
          ].filter(Boolean)),
          el('p', { class: 'level-story', text: t(lv.story) || L('背景故事待补充', 'Story pending') }),
        ]),
        el('span', { class: 'level-row-arrow', 'aria-hidden': 'true', text: '›' }),
      ]);
      const open = () => levelModal(lv, row);
      row.addEventListener('click', open);
      row.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
      list.appendChild(row);
    }
    append(host, list);
    revealNow(host);
  }

  function renderChapterList() {
    clear(host);
    append(host, el('div', { class: 'chapter-grid reveal-stagger' }, (data.chapters || []).map((chapter) => {
      const names = (chapter.levels || []).map((id) => (levelsById.get(id) ? t(levelsById.get(id).name) : id));
      const node = el('article', { class: 'card chapter-card is-clickable', tabindex: '0', role: 'button' }, [
        imageFor(chapter.image, t(chapter.name), L('配图准备中', 'Art coming soon')),
        el('div', { class: 'card-sub', text: t(chapter.shortName) }),
        el('h3', { text: t(chapter.name) }),
        el('p', { class: 'card-body', text: t(chapter.summary) }),
        el('div', { class: 'chapter-levels' }, names.map((n) => el('span', { class: 'tag tag-teal', text: n }))),
      ]);
      const open = () => { active = chapter.id; renderChapterView(); };
      node.addEventListener('click', open);
      node.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
      return node;
    })));
    append(host, el('p', { class: 'small faint', style: { marginTop: 'var(--sp-4)' }, text: L(
      '每一大关从本层关卡池中随机抽 1 关；点大关卡卡片可以查看该层的关卡池与背景故事。',
      'One level is drawn at random from each chapter pool; click a chapter card for its level pool and lore.',
    ) }));
    // 页面内二次渲染：必须立刻标为可见，否则 .reveal-stagger 的初始 opacity:0 会让整块看不见
    revealNow(host);
  }

  container.replaceChildren(host);
  renderChapterList();
  return () => {};
}

function tierBadgeLess() {
  return el('span', { class: 'tag', text: L('关卡', 'Level') });
}

/* ------------------------------------------------------------------ 物品 */
const ITEM_PAGE = 48;

async function renderItems(container) {
  const data = await getWikiDataset('wiki-items');
  const items = data.items || [];
  const groups = data.groups || [];
  const tierOrder = data.tierOrder || [];
  const state = { group: 'all', tier: 'all', q: '', shown: ITEM_PAGE };

  const toolbar = el('div', { class: 'item-toolbar' });
  const grid = el('div', { class: 'item-grid' });
  const moreRow = el('div', { class: 'load-more-row' });
  const countNode = el('div', { class: 'result-count' });

  const search = el('input', { type: 'search', placeholder: L('搜索道具名或效果关键词…', 'Search name or effect…'), 'aria-label': L('搜索道具', 'Search items') });
  search.addEventListener('input', () => { state.q = search.value.trim(); state.shown = ITEM_PAGE; draw(); });

  const groupChips = el('div', { class: 'chips' });
  for (const g of [{ id: 'all', name: { zh: L('全部', 'All') } }, ...groups]) {
    const chip = el('button', { class: `chip${state.group === g.id ? ' is-active' : ''}`, type: 'button', text: g.id === 'all' ? t(g.name) : t(g.name) });
    chip.dataset.group = g.id;
    chip.addEventListener('click', () => {
      state.group = g.id; state.shown = ITEM_PAGE;
      groupChips.querySelectorAll('.chip').forEach((c) => c.classList.toggle('is-active', c.dataset.group === g.id));
      draw();
    });
    groupChips.appendChild(chip);
  }

  const tierChips = el('div', { class: 'chips' });
  // 等阶筛选同时也是等阶说明：名字用该等阶的颜色，后面跟一个更淡的颜色名。
  // （以前上面还有一行独立的「等阶：平淡 白色 微涛 蓝色…」图例，和这一行重复了 6 个等阶名）
  const TIER_COLOR_WORD = { 平淡: L('白', 'white'), 微涛: L('蓝', 'blue'), 刻骨: L('紫', 'purple'), 铭心: L('金', 'gold'), 诅咒: L('红', 'red'), 泰酷辣: L('灰', 'grey') };
  for (const tr of [{ id: 'all', label: L('全部等阶', 'All tiers') }, ...tierOrder.map((x) => ({ id: x, label: x }))]) {
    const isAll = tr.id === 'all';
    const chip = el('button', {
      class: `chip${isAll ? '' : ` tier-chip tier-${tr.id}`}${state.tier === tr.id ? ' is-active' : ''}`,
      type: 'button',
      title: isAll ? '' : L(`等阶 ${tr.id} · 颜色 ${TIER_COLOR_WORD[tr.id] || ''}`, `${tr.id} tier`),
    }, isAll
      ? [el('span', { text: tr.label })]
      : [el('span', { text: tr.label }), el('span', { class: 'chip-note', text: TIER_COLOR_WORD[tr.id] || '' })]);
    chip.dataset.tier = tr.id;
    chip.addEventListener('click', () => {
      state.tier = tr.id; state.shown = ITEM_PAGE;
      tierChips.querySelectorAll('.chip').forEach((c) => c.classList.toggle('is-active', c.dataset.tier === tr.id));
      draw();
    });
    tierChips.appendChild(chip);
  }

  append(toolbar, [
    el('div', { class: 'search-bar' }, [search]),
    groupChips,
    tierChips,
    countNode,
  ]);

  function itemModal(it, cardEl) {
    const members = [
      it.tier ? tierBadge(it.tier) : tierBadge(''),
      it.type ? el('span', { class: 'tag tag-teal', text: it.type }) : null,
      ...(it.pools || []).map((p) => el('span', { class: 'tag tag-glow', text: p })),
    ].filter(Boolean);
    const body = [
      el('p', { class: 'modal-story', text: t(it.effect) || L('（暂无描述）', '(no description)') }),
    ];
    if (t(it.notes)) body.push(el('p', {}, [el('strong', { text: L('特殊说明：', 'Notes: ') }), t(it.notes)]));
    if (it.packageDesc && t(it.packageDesc) && t(it.packageDesc) !== t(it.effect)) {
      body.push(el('p', { class: 'small faint', text: `${L('游戏内原文', 'In-game text')}：${t(it.packageDesc)}` }));
    }
    if (it.contributor) body.push(el('p', { class: 'small faint', text: `${L('投稿人', 'Contributor')}：${it.contributor}` }));
    if (t(it.editorNote)) body.push(el('p', { class: 'small faint', text: `“${t(it.editorNote)}”` }));
    if (it.source === 'package') {
      body.push(notice(L('该条目暂未收录进官方图鉴，信息来自游戏内实测。', 'Not yet in the official gallery; described from in-game data.'), 'info'));
    }
    openModal({
      kicker: groupName(it.group, groups),
      title: t(it.name),
      meta: members,
      body,
      origin: cardEl,
    });
  }

  function itemCard(it) {
    const node = el('article', { class: 'card item-card is-clickable', tabindex: '0', role: 'button' }, [
      el('div', { class: 'item-head' }, [
        el('h4', { text: t(it.name) }),
        it.tier ? tierBadge(it.tier) : null,
      ]),
      el('p', { class: 'item-effect', text: truncate(t(it.effect), 120) }),
    ]);
    const open = () => itemModal(it, node);
    node.addEventListener('click', open);
    node.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
    return node;
  }

  function filtered() {
    const q = state.q.toLowerCase();
    return items.filter((it) => {
      if (state.group !== 'all' && it.group !== state.group) return false;
      if (state.tier !== 'all' && it.tier !== state.tier) return false;
      if (!q) return true;
      const hay = [t(it.name), t(it.effect), it.type, it.tier, it.contributor].join(' ').toLowerCase();
      return hay.includes(q);
    });
  }

  function draw() {
    const list = filtered();
    const shown = list.slice(0, state.shown);
    clear(grid);
    for (const it of shown) grid.appendChild(itemCard(it));
    countNode.textContent = L(
      `共 ${list.length} 条，已显示 ${shown.length} 条 · 点击卡片看完整说明`,
      `${shown.length} of ${list.length} shown · click a card for details`,
    );
    clear(moreRow);
    if (list.length > shown.length) {
      const btn = el('button', { class: 'btn btn-ghost', type: 'button', text: L(`显示更多（还有 ${list.length - shown.length} 条）`, `Show more (${list.length - shown.length})`) });
      btn.addEventListener('click', () => { state.shown += ITEM_PAGE; draw(); });
      moreRow.appendChild(btn);
    }
  }

  const frag = document.createDocumentFragment();
  append(frag, [toolbar, grid, moreRow]);

  if (data.appendix && data.appendix.image) {
    append(frag, el('section', { class: 'section' }, [
      sectionTitle(t(data.appendix.title)),
      el('div', { style: { maxWidth: '900px' } }, [imageSlot(data.appendix.image, { alt: t(data.appendix.title), caption: L('配图准备中', 'Art coming soon') })]),
      el('p', { class: 'small faint', style: { marginTop: 'var(--sp-2)' }, text: t(data.appendix.source) }),
    ]));
  }

  const meta = data.meta || {};
  void meta;
  append(frag, el('section', { class: 'section' }, [
    disclosure(L('图鉴说明', 'About this codex'), [
      ...(data.userNotes || []).map((n) => el('p', { class: 'small faint', text: t(n) })),
      el('p', { class: 'small faint', text: L(
        `当前收录 ${items.length} 条。`,
        `${items.length} entries listed.`,
      ) }),
    ]),
  ]));

  container.replaceChildren(frag);
  draw();
  return () => {};
}

function groupName(id, groups) {
  const g = (groups || []).find((x) => x.id === id);
  return g ? t(g.name) : L('物品', 'Item');
}

function truncate(text, n) {
  const s = String(text || '');
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/* ------------------------------------------------------------------ 职业与天赋 */
async function renderClasses(container) {
  const data = await getWikiDataset('wiki-classes');
  const frag = document.createDocumentFragment();
  const grid = el('div', { class: 'class-grid reveal-stagger' });

  for (const cls of (data.classes || [])) {
    const talents = cls.talents || [];
    const node = el('article', { class: 'card class-card is-clickable', tabindex: '0', role: 'button' }, [
      el('div', { class: 'class-head' }, [
        imageSlot(t(cls.image) || cls.image, { alt: t(cls.name), ratio: '1 / 1', compact: true, caption: L('配图准备中', 'Art coming soon') }),
        el('div', {}, [
          el('h3', { text: t(cls.name) }),
          el('div', { class: 'class-en', text: cls.nameEn || '' }),
        ]),
      ]),
      el('p', { class: 'card-body', text: L(`${talents.length} 条天赋：${talents.slice(0, 3).map((x) => t(x.name)).join('、')}…`, `${talents.length} talents`) }),
    ]);
    const open = () => openModal({
      kicker: L('职业', 'Class'),
      title: `${t(cls.name)}${cls.nameEn ? ` · ${cls.nameEn}` : ''}`,
      wide: true,
      origin: node,
      meta: cls.alias && t(cls.alias) && t(cls.alias) !== t(cls.name)
        ? [el('span', { class: 'tag', text: `${L('文档原名', 'Doc name')}: ${t(cls.alias)}` })]
        : [],
      body: [
        imageSlot(t(cls.image) || cls.image, { alt: t(cls.name), ratio: '16 / 9', caption: L('配图准备中', 'Art coming soon') }),
        el('h3', { class: 'modal-section-title', text: L('天赋', 'Talents') }),
        el('ul', { class: 'modal-list' }, talents.map((tal) => el('li', {}, [
          el('div', { class: 'talent-name', text: t(tal.name) }),
          el('div', { class: 'talent-desc', text: t(tal.desc) }),
          t(tal.note) ? el('div', { class: 'small faint', text: t(tal.note) }) : null,
        ]))),
      ],
    });
    node.addEventListener('click', open);
    node.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
    grid.appendChild(node);
  }

  append(frag, [
    el('p', { class: 'muted', text: L(
      '点职业卡片可以展开该职业的全部 8 条天赋。',
      'Tap a class card to see all eight talents.',
    ) }),
    el('div', { style: { height: 'var(--sp-4)' } }),
    grid,
  ]);
  container.replaceChildren(frag);
  return () => {};
}
