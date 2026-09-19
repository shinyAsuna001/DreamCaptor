/**
 * views/intro.js —— 地图介绍
 */
import { el, append, clear, revealOnScroll } from '../dom.js';
import { t, getContent } from '../store.js';
import { sectionTitle, card, notice, tagList, disclosure } from '../components.js';

export function renderIntro(app) {
  const content = getContent();
  const intro = content.intro || {};
  const req = content.requirements || {};
  const page = el('div', { class: 'page view-enter' });

  append(page, el('header', { class: 'page-head shell' }, [
    el('span', { class: 'eyebrow', text: 'About' }),
    el('h1', { text: t(intro.title) }),
    el('p', { text: t(intro.lead) }),
  ]));

  /* 三块介绍（现在是玩法卖点，不再叙述地图怎么搭出来的） */
  append(page, el('section', { class: 'shell' }, [
    // 5 张卡排 3 列：最后一张自动跨 2 列补满末行（见 base.css 的 .grid-cols-3 规则）
    el('div', { class: 'grid grid-cols-3 reveal-stagger' }, (intro.blocks || []).map((block) => card([
      el('h3', { text: t(block.title) }),
      el('p', { class: 'card-body', text: t(block.body) }),
      tagList((block.bullets || []).map((b) => ({ text: t(b) }))),
    ], { id: block.id }))),
  ]));

  /* 事实表 */
  append(page, el('section', { class: 'section shell' }, [
    sectionTitle(document.documentElement.lang === 'en' ? 'At a glance' : '基础信息'),
    el('dl', { class: 'fact-list' }, (intro.facts || []).flatMap((f) => [
      el('div', { class: 'fact' }, [
        el('dt', { text: t(f.label) }),
        el('dd', { text: t(f.value) }),
      ]),
    ])),
  ]));

  /* 配置要求 */
  if ((req.rows || []).length) {
    const table = el('div', { class: 'table-wrap' }, [
      el('table', { class: 'data' }, [
        el('thead', {}, [el('tr', {}, [
          el('th', { text: document.documentElement.lang === 'en' ? 'Item' : '项目' }),
          el('th', { text: document.documentElement.lang === 'en' ? 'Minimum' : '最低配置' }),
          el('th', { text: document.documentElement.lang === 'en' ? 'Recommended' : '推荐配置' }),
        ])]),
        el('tbody', {}, (req.rows || []).map((row) => el('tr', {}, [
          el('td', { text: t(row.label) }),
          el('td', { text: row.min }),
          el('td', { text: row.recommended }),
        ]))),
      ]),
    ]);
    append(page, el('section', { class: 'section shell' }, [
      sectionTitle(t(req.title)),
      el('p', { class: 'muted', text: t(req.lead) }),
      el('div', { style: { margin: 'var(--sp-4) 0' } }, [table]),
      el('div', { class: 'grid grid-2 grid-cols-2' }, [
        card([el('h4', { text: document.documentElement.lang === 'en' ? 'Minimum' : '最低配置表现' }), el('p', { class: 'card-body', text: t((req.effects || {}).min) })]),
        card([el('h4', { text: document.documentElement.lang === 'en' ? 'Recommended' : '推荐配置表现' }), el('p', { class: 'card-body', text: t((req.effects || {}).recommended) })]),
      ]),
      el('div', { style: { marginTop: 'var(--sp-4)' } }, [notice(t(req.note), 'info')]),
    ]));
  }

  /* 技术向数据：收进折叠区，避免"人机感"抢戏 */
  if ((intro.techFacts || []).length) {
    append(page, el('section', { class: 'section shell' }, [
      disclosure(
        `▸ ${t(intro.techTitle) || (document.documentElement.lang === 'en' ? 'Under the hood' : '想了解制作细节')}`,
        [
          notice(t(intro.techNote), 'info'),
          el('div', { class: 'grid grid-cols-3', style: { marginTop: 'var(--sp-4)' } }, (intro.techFacts || []).map((f) => card([
            el('div', { class: 'stat-value', style: { fontSize: 'var(--fs-xl)' }, text: f.value }),
            el('div', { class: 'stat-label', text: t(f.label) }),
          ]))),
        ],
      ),
    ]));
  }

  clear(app);
  app.appendChild(page);
  return revealOnScroll(app);
}
