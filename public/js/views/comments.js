/**
 * views/comments.js —— 留言板（登录后可发、可回复）
 */
import { el, append, clear, imageSlot, revealOnScroll, toast } from '../dom.js';
import { t, getContent, getUser } from '../store.js';
import { card, notice, emptyState, sectionTitle } from '../components.js';
import { api } from '../api.js';
import { navigate } from '../router.js';

const isEn = () => document.documentElement.lang === 'en';
const L = (zh, en) => (isEn() ? en : zh);

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export async function renderComments(app) {
  const content = getContent();
  const cfg = content.comments || {};
  const root = el('div', { class: 'page view-enter' });
  const shell = el('div', { class: 'shell shell-narrow' });
  append(root, [el('header', { class: 'page-head shell shell-narrow' }, [
    el('span', { class: 'eyebrow', text: 'Comments' }),
    el('h1', { text: t(cfg.title) }),
    el('p', { text: t(cfg.lead) }),
  ]), shell]);
  clear(app); app.appendChild(root);

  let page = 1;
  const listNode = el('ul', { class: 'comment-list' });
  const pager = el('div', { class: 'pager' });
  const formNode = el('div', { class: 'comment-form' });

  function renderForm() {
    clear(formNode);
    const user = getUser();
    if (!user) {
      append(formNode, card([
        el('p', { class: 'muted', text: L('登录后即可留言。', 'Sign in to leave a comment.') }),
        el('div', { class: 'card-actions' }, [
          el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: L('去登录', 'Sign in'), on: { click: () => navigate('/login?next=/comments') } }),
        ]),
      ]));
      return;
    }
    const input = el('textarea', { maxlength: String(cfg.maxLength || 1000), placeholder: L('说点什么…（请保持友善）', 'Say something nice…') });
    const counter = el('span', { class: 'field-hint', text: `0 / ${cfg.maxLength || 1000}` });
    input.addEventListener('input', () => { counter.textContent = `${input.value.length} / ${cfg.maxLength || 1000}`; });
    const submit = el('button', { class: 'btn btn-primary', type: 'submit', text: L('发表', 'Post') });
    const msg = el('p', { class: 'form-msg' });
    const form = el('form', {}, [
      el('div', { class: 'field' }, [input, counter]),
      el('div', { class: 'row' }, [submit, msg]),
    ]);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const body = input.value.trim();
      if (!body) return;
      submit.disabled = true;
      msg.className = 'form-msg';
      msg.textContent = L('发送中…', 'Sending…');
      try {
        await api.createComment(body, null);
        input.value = '';
        counter.textContent = `0 / ${cfg.maxLength || 1000}`;
        msg.className = 'form-msg is-ok';
        msg.textContent = L('已发表', 'Posted');
        await load(1);
      } catch (err) {
        msg.className = 'form-msg is-error';
        msg.textContent = err.message;
      } finally {
        submit.disabled = false;
      }
    });
    append(formNode, card([el('h3', { text: L('发表留言', 'Leave a comment') }), form]));
  }

  function commentNode(item) {
    const user = getUser();
    const actions = el('div', { class: 'comment-actions' });
    if (user) {
      const replyBtn = el('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: L('回复', 'Reply') });
      replyBtn.addEventListener('click', () => {
        if (replyBtn.dataset.open === '1') return;
        replyBtn.dataset.open = '1';
        const box = el('div', { class: 'stack', style: { marginTop: 'var(--sp-2)' } });
        const input = el('textarea', { maxlength: String(cfg.maxLength || 1000), placeholder: L('回复…', 'Reply…') });
        const send = el('button', { class: 'btn btn-sm btn-primary', type: 'button', text: L('发送回复', 'Send') });
        const msg = el('p', { class: 'form-msg' });
        send.addEventListener('click', async () => {
          if (!input.value.trim()) return;
          send.disabled = true;
          try {
            await api.createComment(input.value.trim(), item.id);
            toast(L('回复已发表', 'Reply posted'));
            await load(page);
          } catch (err) {
            msg.className = 'form-msg is-error';
            msg.textContent = err.message;
          } finally { send.disabled = false; }
        });
        append(box, [input, el('div', { class: 'row' }, [send, msg])]);
        replyBtn.after(box);
      });
      actions.appendChild(replyBtn);
    }
    if (user && user.id === item.userId) {
      const del = el('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: L('删除', 'Delete') });
      del.addEventListener('click', async () => {
        try {
          await api.deleteComment(item.id);
          toast(L('已删除', 'Deleted'));
          await load(page);
        } catch (err) { toast(err.message, { type: 'error' }); }
      });
      actions.appendChild(del);
    }
    return el('li', { class: 'comment' }, [
      el('div', { class: 'comment-head' }, [
        el('span', { class: 'comment-author', text: item.username }),
        el('span', { text: formatTime(item.createdAt) }),
      ]),
      el('div', { class: 'comment-body', text: item.content }),
      actions,
      (item.replies || []).length ? el('ul', { class: 'comment-replies' }, item.replies.map(commentNode)) : null,
    ]);
  }

  async function load(targetPage) {
    page = targetPage;
    clear(listNode);
    listNode.appendChild(el('li', {}, [el('div', { class: 'skeleton', style: { minHeight: '4rem' } })]));
    try {
      const data = await api.comments(page, cfg.pageSize || 20);
      clear(listNode);
      if (!data.items.length) {
        listNode.appendChild(el('li', {}, [emptyState('✎', L('还没有留言', 'No comments yet'), L('来做第一个留言的人吧。', 'Be the first to comment.'))]));
      } else {
        for (const item of data.items) listNode.appendChild(commentNode(item));
      }
      clear(pager);
      if (data.totalPages > 1) {
        const prev = el('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: L('上一页', 'Prev'), ...(page <= 1 ? { disabled: true } : {}) });
        const next = el('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: L('下一页', 'Next'), ...(page >= data.totalPages ? { disabled: true } : {}) });
        prev.addEventListener('click', () => load(Math.max(1, page - 1)));
        next.addEventListener('click', () => load(Math.min(data.totalPages, page + 1)));
        append(pager, [prev, el('span', { class: 'faint', text: `${page} / ${data.totalPages}（共 ${data.total} 条）` }), next]);
      }
    } catch (err) {
      clear(listNode);
      listNode.appendChild(el('li', {}, [emptyState('!', L('加载失败', 'Failed to load'), err.message)]));
    }
  }

  renderForm();
  append(shell, [formNode, notice(L('请友善发言；违规内容会被处理。', 'Be nice — inappropriate comments will be removed.'), 'info'), listNode, pager]);
  await load(1);
  return revealOnScroll(app);
}
