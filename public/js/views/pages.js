/**
 * views/pages.js —— FAQ / 下载 / 社区 / 赞助 / 制作组 / 登录 / 404
 */
import { el, append, clear, link, imageSlot, revealOnScroll, toast, copyText } from '../dom.js';
import { t, getContent, getWikiDataset, setUser, getUser, toggleLang } from '../store.js';
import { sectionTitle, card, notice, emptyState, disclosure, actionButton, copyButton } from '../components.js';
import { api } from '../api.js';
import { navigate } from '../router.js';

const isEn = () => document.documentElement.lang === 'en';
const L = (zh, en) => (isEn() ? en : zh);

function pageShell(eyebrow, title, lead) {
  return el('header', { class: 'page-head shell' }, [
    el('span', { class: 'eyebrow', text: eyebrow }),
    el('h1', { text: title }),
    lead ? el('p', { text: lead }) : null,
  ]);
}

/* ------------------------------------------------------------------ FAQ */
export async function renderFaq(app) {
  const content = getContent();
  const cfg = content.faq || {};
  const root = el('div', { class: 'page view-enter' }, [pageShell('Q&A', t(cfg.title), t(cfg.lead))]);
  const body = el('section', { class: 'shell' });
  root.appendChild(body);
  body.appendChild(el('div', { class: 'skeleton', style: { minHeight: '12rem' } }));
  clear(app); app.appendChild(root);

  try {
    const data = await getWikiDataset(cfg.dataset || 'wiki-faq');
    const frag = document.createDocumentFragment();
    for (const section of (data.sections || [])) {
      const sectionNode = el('div', { class: 'faq-section' }, [
        sectionTitle(`${section.index}. ${t(section.title)}`),
      ]);
      for (const item of (section.items || [])) {
        const bodyChildren = [
          el('p', { class: 'faq-a', text: t(item.a) || L('（答案待补充）', '(Answer pending)') }),
        ];
        for (const cmd of (item.commands || [])) {
          bodyChildren.push(el('div', { class: 'faq-cmd' }, [
            el('code', { text: cmd }),
            copyButton(cmd, L('复制', 'Copy')),
          ]));
        }
        if ((item.links || []).length) {
          bodyChildren.push(el('div', { class: 'row', style: { marginTop: 'var(--sp-2)' } },
            item.links.map((l) => link(l.url, l.label || l.url, { class: 'btn btn-sm btn-ghost' }))));
        }
        sectionNode.appendChild(el('div', { class: 'faq-item' }, [
          disclosure(`${item.no ? `${item.no} ` : ''}${t(item.q)}`, bodyChildren),
        ]));
      }
      append(frag, sectionNode);
    }
    frag.appendChild(el('p', { class: 'small faint', text: L(
      `整理自官方《常见问题解答》（文档更新于 ${(data.meta || {}).docUpdatedAt || '—'}）。`,
      `Based on the official FAQ (updated ${(data.meta || {}).docUpdatedAt || '—'}).`,
    ) }));
    body.replaceChildren(frag);
  } catch (err) {
    body.replaceChildren(emptyState('!', L('FAQ 加载失败', 'Failed to load FAQ'), err.message));
  }
  return revealOnScroll(app);
}

/* ------------------------------------------------------------------ 下载 */
export function renderDownload(app) {
  const content = getContent();
  const dl = content.downloads || {};
  const req = content.requirements || {};
  const root = el('div', { class: 'page view-enter' }, [pageShell('Download', t(dl.title), t(dl.lead))]);

  // 下载卡片
  const grid = el('div', { class: 'dl-grid reveal-stagger' });
  for (const item of (dl.items || [])) {
    const hasUrl = item.url && !String(item.url).includes('{{');
    let host = '';
    try { host = hasUrl ? new URL(item.url).host : ''; } catch { host = ''; }
    const head = el('div', { class: 'card-title' }, [
      el('h3', { text: t(item.name) }),
      el('span', { class: 'tag tag-teal', text: t(item.version) }),
      item.recommended ? el('span', { class: 'dl-badge', text: L('★ 必装', '★ Required') }) : null,
    ]);
    const actions = el('div', { class: 'card-actions' }, [
      hasUrl
        ? link(item.url, L('网盘下载', 'Download'), { class: 'btn btn-sm btn-primary' })
        : el('span', { class: 'btn btn-sm is-disabled', 'aria-disabled': 'true' }, [el('span', { text: L('网盘链接', 'Netdisk link') }), el('span', { class: 'pending' })]),
      hasUrl ? copyButton(item.url, L('复制链接', 'Copy link')) : null,
    ]);
    append(grid, el('div', { class: `card dl-card${item.recommended ? ' is-recommended' : ''}` }, [
      head,
      el('p', { class: 'card-body', text: t(item.requires) }),
      el('p', { class: 'dl-size', text: [item.size, t(item.note)].filter(Boolean).join(' · ') }),
      actions,
      host ? el('p', { class: 'dl-size', text: L(`链接来源：${host}`, `Source: ${host}`) }) : null,
    ]));
  }
  root.appendChild(el('section', { class: 'shell' }, [grid]));

  // 群文件提示
  root.appendChild(el('section', { class: 'section shell' }, [
    notice(t(dl.mirrorNote), 'info'),
    el('div', { class: 'row', style: { marginTop: 'var(--sp-4)' } }, ((content.community || {}).qqGroups || []).map((g) => [
      link(g.url, `${t(g.name)}　${g.number}`, { class: 'btn btn-sm btn-teal' }),
    ]).flat()),
  ]));

  // 安装步骤
  root.appendChild(el('section', { class: 'section shell' }, [
    sectionTitle(L('安装步骤', 'Install steps')),
    el('ol', { class: 'steps' }, (dl.steps || []).map((s) => el('li', { text: t(s) }))),
    notice(t(dl.warning), 'danger'),
  ]));

  // 配置要求（复用 intro 的数据）
  if ((req.rows || []).length) {
    const table = el('div', { class: 'table-wrap' }, [
      el('table', { class: 'data' }, [
        el('thead', {}, [el('tr', {}, [
          el('th', { text: L('项目', 'Item') }),
          el('th', { text: L('最低配置', 'Minimum') }),
          el('th', { text: L('推荐配置', 'Recommended') }),
        ])]),
        el('tbody', {}, (req.rows || []).map((row) => el('tr', {}, [
          el('td', { text: t(row.label) }),
          el('td', { text: row.min }),
          el('td', { text: row.recommended }),
        ]))),
      ]),
    ]);
    root.appendChild(el('section', { class: 'section shell' }, [
      sectionTitle(t(req.title)),
      table,
      el('p', { class: 'small faint', style: { marginTop: 'var(--sp-3)' }, text: t(req.note) }),
    ]));
  }

  clear(app); app.appendChild(root);
  return revealOnScroll(app);
}

/* ------------------------------------------------------------------ 社区 */
export function renderCommunity(app) {
  const content = getContent();
  const c = content.community || {};
  const root = el('div', { class: 'page view-enter' }, [pageShell('Community', t(c.title), t(c.lead))]);

  // 官方群：qm.qq.com 的"猜"链接会 404，所以改成就地复制群号 + 说明
  root.appendChild(el('section', { class: 'shell' }, [
    el('div', { class: 'grid grid-2 grid-cols-2 reveal-stagger' }, (c.qqGroups || []).map((g) => card([
      el('div', { class: 'qq-card' }, [
        el('div', {}, [
          el('div', { class: 'card-sub', text: t(g.name) }),
          el('div', { class: 'qq-number', text: g.number }),
        ]),
        el('div', { class: 'row' }, [
          copyButton(g.number, L('复制群号', 'Copy group number')),
          g.url && !String(g.url).includes('{{') ? link(g.url, L('加群', 'Join'), { class: 'btn btn-sm btn-primary' }) : null,
        ].filter(Boolean)),
      ]),
      t(g.joinHint) ? el('p', { class: 'card-sub', style: { marginTop: 'var(--sp-2)' }, text: t(g.joinHint) }) : null,
    ]))),
  ]));

  if ((c.videos || []).length) {
    root.appendChild(el('section', { class: 'section shell' }, [
      sectionTitle(L('宣传视频', 'Videos')),
      el('ul', { class: 'video-list' }, (c.videos || []).map((v) => el('li', {}, [
        link(v.url, `▶ ${t(v.title)}`, { class: 'btn btn-sm btn-ghost' }),
      ]))),
    ]));
  }

  root.appendChild(el('section', { class: 'section shell' }, [
    sectionTitle(L('服务器与拓展', 'Server & add-ons')),
    el('div', { class: 'grid grid-2 grid-cols-2' }, [
      c.server && c.server.enabled ? card([
        el('h3', { text: t(c.server.title) }),
        el('p', { class: 'card-body', text: t(c.server.note) }),
      ]) : null,
      c.docs ? card([
        el('h3', { text: t(c.docs.title) }),
        el('p', { class: 'card-body', text: t(c.docs.note) }),
        el('div', { class: 'card-actions' }, [link(c.docs.url, L('打开文档', 'Open docs'), { class: 'btn btn-sm btn-ghost' })]),
      ]) : null,
    ]),
  ]));

  if (c.modded) {
    root.appendChild(el('section', { class: 'section shell' }, [
      sectionTitle(t(c.modded.title)),
      card([
        el('p', { class: 'card-body', text: t(c.modded.note) }),
        el('div', { class: 'card-actions' }, [link(c.modded.url, L('阅读《魔改版游玩须知》', 'Read the modded-edition notice'), { class: 'btn btn-sm btn-teal' })]),
      ]),
    ]));
  }

  clear(app); app.appendChild(root);
  return revealOnScroll(app);
}

/* ------------------------------------------------------------------ 赞助 */
export function renderSponsor(app) {
  const content = getContent();
  const s = content.sponsor || {};
  const root = el('div', { class: 'page view-enter' }, [pageShell('Support', t(s.title), t(s.lead))]);
  const url = String(s.url || '');
  const hasHint = url && !url.includes('{{');
  root.appendChild(el('section', { class: 'shell' }, [
    el('div', { class: 'grid grid-2 grid-cols-2' }, [
      card([
        el('h3', { text: t(s.urlLabel) || 'Afdian' }),
        el('p', { class: 'card-body', text: L('支持制作组继续更新地图。', 'Support continued development.') }),
        el('div', { class: 'card-actions' }, [actionButton(L('前往爱发电', 'Open Afdian'), hasHint ? url : '')]),
      ]),
      card([
        el('h3', { text: L('赞助者武器库', 'Supporter arsenal') }),
        el('p', { class: 'card-body', text: L('地图内设有「赞助者武器库」DLC 内容，详见官方文档。', 'The map includes a supporter arsenal DLC.') }),
      ]),
    ]),
    t(s.note) ? el('div', { style: { marginTop: 'var(--sp-4)' } }, [notice(t(s.note), 'info')]) : null,
  ]));
  clear(app); app.appendChild(root);
  return () => {};
}

/* ------------------------------------------------------------------ 制作组 */
export function renderAbout(app) {
  const content = getContent();
  const c = content.credits || {};
  const root = el('div', { class: 'page view-enter' }, [pageShell('Credits', t(c.title), t(c.lead))]);
  root.appendChild(el('section', { class: 'shell' }, [
    el('div', { class: 'grid grid-3 grid-cols-2 reveal-stagger' }, (c.people || []).map((p) => {
      const rawQq = String(p.qq || '');
      const hasQq = rawQq && !rawQq.includes('{{');
      return card([
        el('h3', { text: p.name }),
        el('div', { class: 'card-sub', text: t(p.role) }),
        // 作者要求：名片不做外链，只给「复制 QQ 号」
        el('div', { class: 'card-actions' }, [
          hasQq
            ? el('span', { class: 'row' }, [
              el('span', { class: 'qq-number', text: rawQq }),
              copyButton(rawQq, L('复制 QQ 号', 'Copy QQ')),
            ])
            : el('span', { class: 'pending', title: L('QQ 号待补充', 'QQ number pending') }),
        ]),
      ]);
    })),
    el('div', { style: { marginTop: 'var(--sp-5)' } }, [notice(t(c.contributorsNote), 'info')]),
  ]));
  clear(app); app.appendChild(root);
  return revealOnScroll(app);
}

/* ------------------------------------------------------------------ 登录 / 注册 */
export function renderLogin(app) {
  const root = el('div', { class: 'page view-enter' });
  const msg = el('p', { class: 'form-msg' });
  let mode = 'login';

  const usernameInput = el('input', { type: 'text', autocomplete: 'username', required: true, 'aria-label': L('用户名', 'Username') });
  const passwordInput = el('input', { type: 'password', autocomplete: 'current-password', required: true, 'aria-label': L('密码', 'Password') });
  const title = el('h2', { text: L('登录', 'Sign in') });
  const submit = el('button', { class: 'btn btn-primary btn-block', type: 'submit', text: L('登录', 'Sign in') });
  const switchBtn = el('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: L('还没有账号？注册', "No account? Register") });

  switchBtn.addEventListener('click', () => {
    mode = mode === 'login' ? 'register' : 'login';
    title.textContent = mode === 'login' ? L('登录', 'Sign in') : L('注册', 'Register');
    submit.textContent = mode === 'login' ? L('登录', 'Sign in') : L('创建账号', 'Create account');
    switchBtn.textContent = mode === 'login' ? L('还没有账号？注册', "No account? Register") : L('已有账号？登录', 'Have an account? Sign in');
    msg.textContent = '';
  });

  const form = el('form', { class: 'stack' }, [
    el('div', { class: 'field' }, [el('label', { text: L('用户名', 'Username') }), usernameInput]),
    el('div', { class: 'field' }, [el('label', { text: L('密码', 'Password') }), passwordInput, el('span', { class: 'field-hint', text: L('至少 8 位；用户名 3–16 位，可用中文/字母/数字/下划线', '8+ chars; username 3–16 chars') })]),
    submit,
    msg,
    switchBtn,
  ]);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    msg.className = 'form-msg';
    msg.textContent = L('处理中…', 'Working…');
    submit.disabled = true;
    try {
      const user = mode === 'login'
        ? (await api.login(usernameInput.value, passwordInput.value)).user
        : (await api.register(usernameInput.value, passwordInput.value)).user;
      setUser(user);
      toast(L('登录成功', 'Signed in'));
      const next = new URLSearchParams(window.location.search).get('next') || '/comments';
      navigate(next, { replace: true });
    } catch (err) {
      msg.className = 'form-msg is-error';
      msg.textContent = err.message || L('操作失败', 'Failed');
    } finally {
      submit.disabled = false;
    }
  });

  root.appendChild(el('section', { class: 'shell admin-login' }, [card([title, form])]));
  clear(app); app.appendChild(root);
  return () => {};
}

/* ------------------------------------------------------------------ 404 */
export function renderNotFound(app) {
  const root = el('div', { class: 'page view-enter' }, [
    el('section', { class: 'shell' }, [
      emptyState('☾', L('这条梦境支路不存在', 'This dream path does not exist'), L('检查一下网址，或回首页重新出发。', 'Check the URL, or head back home.')),
      el('div', { class: 'row', style: { justifyContent: 'center', marginTop: 'var(--sp-4)' } }, [
        el('a', { class: 'btn btn-primary', href: '/', text: L('回到首页', 'Back home'), 'data-link': true }),
      ]),
    ]),
  ]);
  clear(app); app.appendChild(root);
  return () => {};
}
