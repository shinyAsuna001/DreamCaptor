/**
 * views/admin.js —— 维护后台（仅 127.0.0.1 可访问；路径由服务端注入给本页）
 *
 * 六个面板：占位符集中填 / 外观（底图明暗）/ 站点内容（JSON）/ 百科数据集（JSON）/ 备份与回滚 / 评论管理
 */
import { el, append, clear, toast, copyText } from '../dom.js';
import { t, getContent, refreshContent } from '../store.js';
import { card, notice, emptyState, sectionTitle } from '../components.js';
import { api } from '../api.js';

const L = (zh, en) => (document.documentElement.lang === 'en' ? en : zh);

const DATASETS = [
  { name: 'wiki-levels', label: '关卡' },
  { name: 'wiki-items', label: '物品' },
  { name: 'wiki-classes', label: '职业与天赋' },
  { name: 'wiki-faq', label: '常见问题' },
  { name: 'wiki-enemies', label: '敌人（空）' },
  { name: 'wiki-difficulty', label: '难度（空）' },
];

export async function renderAdmin(app) {
  const root = el('div', { class: 'page view-enter' });
  const shell = el('div', { class: 'shell' });
  append(root, [el('header', { class: 'page-head shell' }, [
    el('span', { class: 'eyebrow', text: 'Admin · 127.0.0.1 only' }),
    el('h1', { text: L('维护后台', 'Admin panel') }),
    el('p', { class: 'muted', text: L('本页只在本机可访问。所有写入都会自动备份，并可在「备份与回滚」里一键恢复。', 'Localhost only. Every save is backed up and can be rolled back.') }),
  ]), shell]);
  clear(app); app.appendChild(root);

  const session = await api.adminSession().catch(() => null);
  if (!session || !session.loggedIn) {
    shell.appendChild(loginPanel());
    return () => {};
  }
  await renderPanels(shell);
  return () => {};
}

function loginPanel() {
  const input = el('input', { type: 'password', autocomplete: 'current-password', 'aria-label': L('后台口令', 'Admin password') });
  const msg = el('p', { class: 'form-msg' });
  const submit = el('button', { class: 'btn btn-primary btn-block', type: 'submit', text: L('登录', 'Sign in') });
  const form = el('form', {}, [
    el('div', { class: 'field' }, [el('label', { text: L('后台口令', 'Admin password') }), input]),
    submit, msg,
  ]);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.disabled = true;
    msg.className = 'form-msg';
    msg.textContent = L('校验中…', 'Checking…');
    try {
      await api.adminLogin(input.value);
      toast(L('已登录', 'Signed in'));
      window.location.reload();
    } catch (err) {
      msg.className = 'form-msg is-error';
      msg.textContent = err.message;
    } finally { submit.disabled = false; }
  });
  return el('div', { class: 'admin-login' }, [card([el('h3', { text: L('后台登录', 'Admin sign in') }), form])]);
}

async function renderPanels(shell) {
  const tabs = [
    { id: 'placeholders', label: L('占位符', 'Placeholders') },
    { id: 'theme', label: L('外观', 'Appearance') },
    { id: 'content', label: L('站点内容', 'Site content') },
    { id: 'datasets', label: L('百科数据', 'Datasets') },
    { id: 'backups', label: L('备份与回滚', 'Backups') },
    { id: 'comments', label: L('评论管理', 'Comments') },
  ];
  const tabBar = el('div', { class: 'admin-tabs' });
  const panelHost = el('div', {});
  let active = 'placeholders';

  async function open(id) {
    active = id;
    tabBar.querySelectorAll('.chip').forEach((c) => c.classList.toggle('is-active', c.dataset.tab === id));
    clear(panelHost);
    panelHost.appendChild(el('div', { class: 'skeleton', style: { minHeight: '8rem' } }));
    try {
      if (id === 'placeholders') await panelPlaceholders(panelHost);
      else if (id === 'theme') await panelTheme(panelHost);
      else if (id === 'content') await panelContent(panelHost);
      else if (id === 'datasets') await panelDatasets(panelHost);
      else if (id === 'backups') await panelBackups(panelHost);
      else if (id === 'comments') await panelComments(panelHost);
    } catch (err) {
      clear(panelHost);
      panelHost.appendChild(emptyState('!', L('加载失败', 'Failed'), err.message));
    }
  }

  for (const tab of tabs) {
    const chip = el('button', { class: 'chip', type: 'button', text: tab.label, dataset: { tab: tab.id } });
    chip.addEventListener('click', () => open(tab.id));
    tabBar.appendChild(chip);
  }

  const logout = el('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: L('退出后台', 'Sign out') });
  logout.addEventListener('click', async () => {
    await api.adminLogout();
    window.location.reload();
  });

  append(shell, [el('div', { class: 'row', style: { justifyContent: 'space-between' } }, [
    el('span', { class: 'small faint', text: L('提示：改动会立即对前台生效。', 'Changes go live immediately.') }),
    logout,
  ]), tabBar, panelHost]);
  await open(active);
}

/* ------------------------------------------------------------------ 占位符 */
async function panelPlaceholders(host) {
  const data = await api.adminContent();
  const list = data.placeholders || [];
  const inputs = new Map();
  const rows = list.map((p) => {
    const input = el('input', { type: 'text', value: p.value || '', placeholder: p.hint || '' });
    inputs.set(p.key, input);
    return el('div', { class: 'placeholder-row' }, [
      el('div', {}, [
        el('div', { class: 'placeholder-key', text: p.key }),
        el('div', { class: 'placeholder-hint', text: `${p.group} · ${p.hint || ''}` }),
      ]),
      input,
      el('span', { class: `placeholder-state ${p.filled ? 'is-filled' : 'is-empty'}`, text: p.filled ? L('已填', 'filled') : L('未填', 'empty') }),
    ]);
  });

  const save = el('button', { class: 'btn btn-primary', type: 'button', text: L('保存全部占位符', 'Save all') });
  save.addEventListener('click', async () => {
    save.disabled = true;
    const updates = {};
    for (const [key, input] of inputs) updates[key] = input.value;
    try {
      await api.adminSetPlaceholders(updates);
      await refreshContent();
      toast(L('已保存，前台立即生效', 'Saved'));
      await panelRefresh(host, panelPlaceholders);
    } catch (err) {
      toast(err.message, { type: 'error' });
    } finally { save.disabled = false; }
  });

  clear(host);
  append(host, el('section', { class: 'admin-panel' }, [
    sectionTitle(L('占位符集中管理', 'Placeholders')),
    el('p', { class: 'small muted', text: L('这里的值会替换全站的 {{占位符}}。留空则前台显示「待补充」。', 'These values replace {{placeholders}} site-wide.') }),
    ...rows,
    el('div', { class: 'row', style: { marginTop: 'var(--sp-4)' } }, [save]),
  ]));
}

/* ------------------------------------------------------------------ 外观（底图明暗） */
// css 变量名 / 默认值 与 public/css/tokens.css 的出厂默认保持一致（改一边要同步另一边）
function themeFields() {
  return [
    { key: 'bgOpacity', css: '--bg-opacity', min: 0, max: 1, step: 0.01, def: 0.78, label: L('底图不透明度', 'Image opacity'), hint: L('1 = 底图完全显示；调小则整张底图更淡', '1 = fully visible') },
    { key: 'bgBoost', css: '--bg-boost', min: 0.4, max: 2, step: 0.01, def: 1.08, label: L('底图亮度增益', 'Image brightness'), hint: L('给偏暗的截图整体提亮；1 = 原样', 'Brightness gain; 1 = as-is') },
    { key: 'bgVeilTop', css: '--bg-veil-top', min: 0, max: 1, step: 0.01, def: 0.46, label: L('顶部压暗', 'Top veil'), hint: L('越大越暗，用于保证首屏大字可读', 'Higher = darker') },
    { key: 'bgVeilMid', css: '--bg-veil-mid', min: 0, max: 1, step: 0.01, def: 0.72, label: L('中部压暗', 'Middle veil'), hint: L('正文区域的背景明暗', 'Behind body text') },
    { key: 'bgVeilBottom', css: '--bg-veil-bottom', min: 0, max: 1, step: 0.01, def: 0.95, label: L('底部压暗', 'Bottom veil'), hint: L('底部与页脚衔接处；接近 1 = 基本全黑', 'Near 1 = near black') },
  ];
}

async function panelTheme(host) {
  const THEME_FIELDS = themeFields();
  const data = await api.adminContent();
  const saved = (data.content && data.content.theme) || {};
  const cur = {};
  for (const f of THEME_FIELDS) {
    const v = Number(saved[f.key]);
    cur[f.key] = Number.isFinite(v) ? v : f.def;
  }

  const apply = (values) => {
    for (const f of THEME_FIELDS) {
      document.documentElement.style.setProperty(f.css, String(values[f.key]));
    }
  };
  const read = () => {
    const out = {};
    for (const f of THEME_FIELDS) out[f.key] = Number(inputs.get(f.key).value);
    return out;
  };

  const inputs = new Map();
  const readouts = new Map();
  const rows = THEME_FIELDS.map((f) => {
    const input = el('input', { type: 'range', min: String(f.min), max: String(f.max), step: String(f.step), value: String(cur[f.key]) });
    const out = el('span', { class: 'mono small', text: Number(cur[f.key]).toFixed(2) });
    inputs.set(f.key, input);
    readouts.set(f.key, out);
    input.addEventListener('input', () => {
      out.textContent = Number(input.value).toFixed(2);
      apply(read());            // 实时预览：只影响当前这个标签页
    });
    return el('div', { class: 'theme-row' }, [
      el('div', { class: 'theme-label' }, [
        el('div', { text: f.label }),
        el('div', { class: 'placeholder-hint', text: `var(${f.css}) · ${f.hint}` }),
      ]),
      input,
      out,
    ]);
  });
  apply(cur);

  const msg = el('p', { class: 'form-msg' });
  const save = el('button', { class: 'btn btn-primary', type: 'button', text: L('保存外观', 'Save') });
  const revert = el('button', { class: 'btn btn-ghost', type: 'button', text: L('撤销未保存的改动', 'Revert edits') });
  const toDefault = el('button', { class: 'btn btn-ghost', type: 'button', text: L('恢复出厂默认', 'Restore defaults') });

  const syncFrom = (values) => {
    for (const f of THEME_FIELDS) {
      inputs.get(f.key).value = String(values[f.key]);
      readouts.get(f.key).textContent = Number(values[f.key]).toFixed(2);
    }
    apply(values);
  };

  revert.addEventListener('click', () => { syncFrom(cur); msg.textContent = ''; });
  toDefault.addEventListener('click', () => {
    const d = {};
    for (const f of THEME_FIELDS) d[f.key] = f.def;
    syncFrom(d);
    msg.className = 'form-msg';
    msg.textContent = L('已填入默认值，点「保存外观」后生效。', 'Defaults filled in — press Save to apply.');
  });
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const values = read();
      await api.adminPatch('theme', values);
      for (const f of THEME_FIELDS) cur[f.key] = values[f.key];
      await refreshContent();
      msg.className = 'form-msg is-ok';
      msg.textContent = L('已保存（写进 content.json，前台刷新即生效）', 'Saved');
      toast(L('外观已保存', 'Appearance saved'));
    } catch (err) {
      msg.className = 'form-msg is-error';
      msg.textContent = err.message;
    } finally { save.disabled = false; }
  });

  clear(host);
  append(host, el('section', { class: 'admin-panel' }, [
    sectionTitle(L('外观：底图明暗', 'Appearance: background image')),
    el('p', { class: 'small muted', text: L('拖动即时预览（只影响当前这个标签页）。满意后点保存，值会写进 content.json 并注入前台页面，不需要改代码重新部署。觉得整体太黑就调小「压暗」、调大「亮度增益」；反过来调亮。', 'Drag to preview live (this tab only), then save.') }),
    ...rows,
    el('div', { class: 'row', style: { marginTop: 'var(--sp-4)' } }, [save, revert, toDefault, msg]),
  ]));
}

/* ------------------------------------------------------------------ 站点内容 JSON */
async function panelContent(host) {
  const data = await api.adminContent();
  const ta = el('textarea', { class: 'mono', spellcheck: 'false' });
  ta.value = JSON.stringify(data.content, null, 2);
  const msg = el('p', { class: 'form-msg' });
  const save = el('button', { class: 'btn btn-primary', type: 'button', text: L('保存内容', 'Save') });
  const reset = el('button', { class: 'btn btn-ghost', type: 'button', text: L('恢复为当前值', 'Revert edits') });
  reset.addEventListener('click', () => { ta.value = JSON.stringify(data.content, null, 2); msg.textContent = ''; });
  save.addEventListener('click', async () => {
    let parsed;
    try {
      parsed = JSON.parse(ta.value);
    } catch (err) {
      msg.className = 'form-msg is-error';
      msg.textContent = `${L('JSON 语法错误：', 'JSON error: ')}${err.message}`;
      return;
    }
    save.disabled = true;
    try {
      await api.adminSaveContent(parsed);
      await refreshContent();
      msg.className = 'form-msg is-ok';
      msg.textContent = L('已保存（dataVersion 已自增）', 'Saved');
      toast(L('已保存', 'Saved'));
    } catch (err) {
      msg.className = 'form-msg is-error';
      msg.textContent = err.message;
    } finally { save.disabled = false; }
  });

  clear(host);
  append(host, el('section', { class: 'admin-panel' }, [
    sectionTitle(L('站点内容（content.json）', 'Site content (content.json)')),
    el('p', { class: 'small muted', text: L('直接编辑 JSON。中文可写成 {"zh":"…","en":"…"}；英文留空时前台回退中文。', 'Edit JSON directly. Use {"zh":…,"en":…} for bilingual text.') }),
    ta,
    el('div', { class: 'row', style: { marginTop: 'var(--sp-3)' } }, [save, reset, msg]),
  ]));
}

/* ------------------------------------------------------------------ 数据集 JSON */
async function panelDatasets(host) {
  const bar = el('div', { class: 'dataset-tabs' });
  const editorHost = el('div', {});
  let current = DATASETS[0].name;

  const loadEditor = async (name) => {
    current = name;
    bar.querySelectorAll('.chip').forEach((c) => c.classList.toggle('is-active', c.dataset.name === name));
    clear(editorHost);
    editorHost.appendChild(el('div', { class: 'skeleton', style: { minHeight: '10rem' } }));
    try {
      const res = await api.adminDataset(name);
      const ta = el('textarea', { class: 'mono', spellcheck: 'false', style: { minHeight: '24rem' } });
      ta.value = JSON.stringify(res.data, null, 2);
      const msg = el('p', { class: 'form-msg' });
      const save = el('button', { class: 'btn btn-primary', type: 'button', text: L('保存数据集', 'Save dataset') });
      save.addEventListener('click', async () => {
        let parsed;
        try { parsed = JSON.parse(ta.value); } catch (err) {
          msg.className = 'form-msg is-error';
          msg.textContent = `${L('JSON 语法错误：', 'JSON error: ')}${err.message}`;
          return;
        }
        save.disabled = true;
        try {
          await api.adminSaveDataset(name, parsed);
          await refreshContent();
          msg.className = 'form-msg is-ok';
          msg.textContent = L('已保存', 'Saved');
          toast(L('已保存', 'Saved'));
        } catch (err) {
          msg.className = 'form-msg is-error';
          msg.textContent = err.message;
        } finally { save.disabled = false; }
      });
      clear(editorHost);
      append(editorHost, [
        el('p', { class: 'small muted', text: L('该文件保存后前台立即生效。建议大改前先备份（保存会自动进备份区）。', 'Saving backs up automatically.') }),
        ta,
        el('div', { class: 'row', style: { marginTop: 'var(--sp-3)' } }, [save, msg]),
      ]);
    } catch (err) {
      clear(editorHost);
      editorHost.appendChild(emptyState('!', L('加载失败', 'Failed'), err.message));
    }
  };

  for (const ds of DATASETS) {
    const chip = el('button', { class: 'chip', type: 'button', text: ds.label, dataset: { name: ds.name } });
    chip.addEventListener('click', () => loadEditor(ds.name));
    bar.appendChild(chip);
  }
  clear(host);
  append(host, el('section', { class: 'admin-panel' }, [
    sectionTitle(L('百科数据集', 'Wiki datasets')),
    bar, editorHost,
  ]));
  await loadEditor(current);
}

/* ------------------------------------------------------------------ 备份 */
async function panelBackups(host) {
  const data = await api.adminBackups();
  const list = el('div', {});
  for (const b of data.backups || []) {
    const row = el('div', { class: 'backup-row' }, [
      el('span', {}, [
        el('strong', { text: b.target }),
        el('span', { class: 'faint', text: `　${b.name}` }),
      ]),
      el('span', { class: 'row' }, [
        el('span', { class: 'faint', text: `${new Date(b.mtime).toLocaleString()}　${(b.bytes / 1024).toFixed(1)} KB` }),
        (() => {
          const btn = el('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: L('回滚到此版本', 'Rollback') });
          btn.addEventListener('click', async () => {
            if (!window.confirm(L(`确定回滚 content.json 到 ${b.name} 吗？当前内容会先被备份。`, `Rollback content.json to ${b.name}?`))) return;
            try {
              await api.adminRollback(b.name);
              await refreshContent();
              toast(L('已回滚', 'Rolled back'));
              await panelRefresh(host, panelBackups);
            } catch (err) { toast(err.message, { type: 'error' }); }
          });
          return btn;
        })(),
      ]),
    ]);
    list.appendChild(row);
  }
  if (!(data.backups || []).length) list.appendChild(el('p', { class: 'muted', text: L('暂无备份。', 'No backups yet.') }));

  const rollbackLast = el('button', { class: 'btn btn-primary', type: 'button', text: L('恢复上一版本', 'Restore previous version') });
  rollbackLast.addEventListener('click', async () => {
    try {
      await api.adminRollback();
      await refreshContent();
      toast(L('已恢复上一版本', 'Restored'));
      await panelRefresh(host, panelBackups);
    } catch (err) { toast(err.message, { type: 'error' }); }
  });

  clear(host);
  append(host, el('section', { class: 'admin-panel' }, [
    sectionTitle(L('备份与回滚', 'Backups & rollback')),
    notice(L('每次保存前系统会自动备份，每个数据文件保留最近 10 份。', 'Auto-backup keeps the latest 10 copies per file.'), 'info'),
    el('div', { style: { margin: 'var(--sp-4) 0' } }, [rollbackLast]),
    list,
  ]));
}

/* ------------------------------------------------------------------ 评论 */
async function panelComments(host) {
  const data = await api.adminComments();
  const rows = (data.items || []).map((c) => el('div', { class: 'backup-row' }, [
    el('div', {}, [
      el('div', {}, [
        el('strong', { text: c.username }),
        el('span', { class: 'faint', text: `　${new Date(c.createdAt).toLocaleString()}${c.parentId ? L('（回复）', ' (reply)') : ''}` }),
        c.hidden ? el('span', { class: 'tag tag-glow', text: L('已隐藏', 'hidden') }) : null,
        c.deletedAt ? el('span', { class: 'tag', text: L('已删除', 'deleted') }) : null,
      ]),
      el('div', { class: 'small', text: c.content }),
    ]),
    el('div', { class: 'row' }, [
      (() => {
        const btn = el('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: c.hidden ? L('取消隐藏', 'Unhide') : L('隐藏', 'Hide') });
        btn.addEventListener('click', async () => {
          try {
            await api.adminHideComment(c.id, !c.hidden);
            await panelRefresh(host, panelComments);
            toast(L('已更新', 'Updated'));
          } catch (err) { toast(err.message, { type: 'error' }); }
        });
        return btn;
      })(),
      c.deletedAt ? null : (() => {
        const btn = el('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: L('删除', 'Delete') });
        btn.addEventListener('click', async () => {
          try {
            await api.adminDeleteComment(c.id);
            await panelRefresh(host, panelComments);
            toast(L('已删除', 'Deleted'));
          } catch (err) { toast(err.message, { type: 'error' }); }
        });
        return btn;
      })(),
    ]),
  ]));

  clear(host);
  append(host, el('section', { class: 'admin-panel' }, [
    sectionTitle(L('评论管理', 'Comments')),
    el('p', { class: 'small muted', text: `${L('总计', 'Total')} ${data.stats.total} · ${L('可见', 'visible')} ${data.stats.visible} · ${L('隐藏', 'hidden')} ${data.stats.hidden} · ${L('删除', 'deleted')} ${data.stats.deleted}` }),
    ...(rows.length ? rows : [el('p', { class: 'muted', text: L('暂无评论。', 'No comments.') })]),
  ]));
  void getContent; void t; void copyText;
}

async function panelRefresh(host, fn) {
  clear(host);
  host.appendChild(el('div', { class: 'skeleton', style: { minHeight: '6rem' } }));
  await fn(host);
}
