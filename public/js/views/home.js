/**
 * views/home.js —— 首页
 */
import { el, append, clear, link, imageSlot, revealOnScroll, whenVisible } from '../dom.js';
import { t, getContent } from '../store.js';
import { heroSection, sectionTitle, card, notice, actionButton, tagList } from '../components.js';

const ENTRIES = [
  { path: '/intro', key: 'intro', glyph: '✦' },
  { path: '/wiki/levels', key: 'levels', glyph: '❖' },
  { path: '/wiki/items', key: 'items', glyph: '▣' },
  { path: '/wiki/classes', key: 'classes', glyph: '✧' },
  { path: '/faq', key: 'faq', glyph: '?' },
  { path: '/download', key: 'download', glyph: '↓' },
];

export function renderHome(app) {
  const content = getContent();
  const intro = content.intro || {};
  const downloads = content.downloads || {};
  const community = content.community || {};
  const page = el('div', { class: 'page view-enter' });

  append(page, heroSection());

  /* 速览 */
  const facts = el('section', { class: 'section shell' }, [
    sectionTitle(t(intro.title)),
    el('p', { class: 'muted', text: t(intro.lead) }),
    el('div', { class: 'grid grid-3 grid-cols-3 reveal-stagger', style: { marginTop: 'var(--sp-5)' } },
      (intro.facts || []).slice(0, 9).map((f) => card([
        el('div', { class: 'card-sub', text: t(f.label) }),
        el('div', { style: { fontSize: 'var(--fs-l)', fontFamily: 'var(--font-title)' }, text: t(f.value) }),
      ]))),
    el('div', { class: 'row', style: { marginTop: 'var(--sp-4)' } }, [
      el('a', { class: 'btn btn-ghost', href: '/intro', text: getLangLabel('了解更多', 'Read more'), 'data-link': true }),
    ]),
  ]);

  /* 大关概览（卡片直接放进这一个网格：之前套了两层，外层网格只装一个内层网格） */
  const chaptersGrid = el('div', {
    class: 'grid grid-3 grid-cols-3 reveal-stagger',
    id: 'homeChapters',
    style: { marginTop: 'var(--sp-5)' },
  }, [el('div', { class: 'skeleton', style: { minHeight: '8rem' } })]);
  const levelsPreview = el('section', { class: 'section shell' }, [
    sectionTitle(getLangLabel('三大关 · 九张关卡', 'Three chapters, nine levels')),
    el('p', { class: 'muted', text: t(content.wiki && content.wiki.lead) }),
    chaptersGrid,
  ]);

  /* 板块入口 */
  const entries = el('section', { class: 'section shell' }, [
    sectionTitle(getLangLabel('快速进入', 'Jump in')),
    el('div', { class: 'entry-grid grid-cols-3 reveal-stagger', style: { marginTop: 'var(--sp-5)' } }, ENTRIES.map((entry, i) => {
      const label = labelOf(entry);
      return el('a', { class: 'card entry-card', href: entry.path, 'data-link': true }, [
        el('span', { class: 'entry-index', text: String(i + 1).padStart(2, '0') }),
        el('h3', { text: label.title }),
        el('p', { text: label.desc }),
      ]);
    })),
  ]);

  /* 下载 CTA */
  const primary = (downloads.items || []).find((d) => d.recommended) || (downloads.items || [])[0] || {};
  const dlCta = el('section', { class: 'section shell' }, [
    sectionTitle(t(downloads.title)),
    el('div', { class: 'grid grid-2' }, [
      card([
        el('div', { class: 'card-title' }, [
          el('h3', { text: t(primary.name) }),
          el('span', { class: 'tag tag-teal', text: t(primary.version) }),
        ]),
        el('p', { class: 'card-body', text: t(primary.requires) }),
        el('div', { class: 'card-actions' }, [
          actionButton(getLangLabel('前往下载', 'Download'), primary.url),
          el('a', { class: 'btn btn-sm btn-ghost', href: '/download', text: getLangLabel('安装步骤', 'Install steps'), 'data-link': true }),
        ]),
      ]),
      card([
        el('div', { class: 'card-title' }, [el('h3', { text: getLangLabel('配置要求', 'Requirements') })]),
        el('p', { class: 'card-body', text: t((content.requirements || {}).lead) }),
        el('div', { class: 'card-actions' }, [
          // 配置要求在「地图介绍」页里（FAQ 里没有这条），按钮就指过去
          el('a', { class: 'btn btn-sm btn-ghost', href: '/intro', text: getLangLabel('查看配置要求', 'See requirements'), 'data-link': true }),
          el('a', { class: 'btn btn-sm btn-ghost', href: '/faq', text: getLangLabel('安装与报错', 'Install & troubleshooting'), 'data-link': true }),
        ]),
      ]),
    ]),
  ]);

  /* 社区 CTA */
  const qq = (community.qqGroups || [])[0];
  const comCta = el('section', { class: 'section shell' }, [
    sectionTitle(t(community.title)),
    el('div', { class: 'row' }, [
      el('p', { class: 'muted', text: t(community.lead), style: { flex: '1 1 20rem' } }),
      el('div', { class: 'row' }, [
        // 这里只显示群号文本，不做成按钮：想进群点右边「更多」到社区页（那里有复制群号）
        qq ? el('span', { class: 'tag tag-teal', text: `${t(qq.name)} ${qq.number}` }) : null,
        el('a', { class: 'btn btn-sm btn-ghost', href: '/community', text: getLangLabel('更多', 'More'), 'data-link': true }),
      ]),
    ]),
  ]);

  append(page, [facts, levelsPreview, entries, dlCta, comCta]);
  fillChapterCards(chaptersGrid);
  clear(app);
  app.appendChild(page);
  return revealOnScroll(app);
}

function getLangLabel(zh, en) {
  return document.documentElement.lang === 'en' ? en : zh;
}

function labelOf(entry) {
  const content = getContent();
  const wikiPages = (content.wiki && content.wiki.pages) || [];
  const map = {
    intro: { title: t((content.intro || {}).title), desc: t((content.intro || {}).lead) },
    levels: { title: t((wikiPages.find((p) => p.id === 'levels') || {}).label), desc: '' },
    items: { title: t((wikiPages.find((p) => p.id === 'items') || {}).label), desc: '' },
    classes: { title: t((wikiPages.find((p) => p.id === 'classes') || {}).label), desc: '' },
    faq: { title: t((content.faq || {}).title), desc: t((content.faq || {}).lead) },
    download: { title: t((content.downloads || {}).title), desc: t((content.downloads || {}).lead) },
  };
  const item = map[entry.key] || { title: entry.key, desc: '' };
  const descs = {
    levels: getLangLabel('三大关与随机关卡池', 'Chapters and random level pools'),
    items: getLangLabel('470+ 道具武器的图鉴', 'Codex of 470+ items and weapons'),
    classes: getLangLabel('11 个职业 × 8 条天赋', '11 classes × 8 talents'),
  };
  return { title: item.title, desc: descs[entry.key] || truncate(item.desc, 68) };
}

function truncate(text, n) {
  const s = String(text || '');
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** 把三大关卡片填进首页那个网格（数据是异步来的，先放骨架） */
function fillChapterCards(node) {
  // 章节数据在 wiki-levels 数据集里，按需拉取
  import('../store.js').then(({ getWikiDataset }) => getWikiDataset('wiki-levels')).then((data) => {
    clear(node);
    for (const chapter of (data.chapters || [])) {
      append(node, el('a', { class: 'card entry-card', href: '/wiki/levels', 'data-link': true }, [
        el('span', { class: 'entry-index', text: t(chapter.shortName) }),
        el('h3', { text: t(chapter.name) }),
        el('p', { text: t(chapter.summary) }),
        el('div', { class: 'tags', style: { marginTop: 'var(--sp-2)' } }, (chapter.levels || []).map((id) => {
          const lv = (data.levels || []).find((l) => l.id === id);
          return el('span', { class: 'tag', text: lv ? t(lv.name) : id });
        })),
      ]));
    }
  }).catch(() => {
    clear(node);
    node.appendChild(el('div', { class: 'muted', text: getLangLabel('关卡数据加载失败', 'Failed to load level data') }));
  });
}
