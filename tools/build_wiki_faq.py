#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""build_wiki_faq.py —— 把官方《常见问题解答》md 变成结构化 Q&A 数据

飞书导出的 md 有个特点：**标题文字被拆到了下一段正文里**（`### ` 空标题 + 紧跟一段文字），
所以解析时要"空标题 → 取后面的第一段非空文本当标题"。

数据源：官方《常见问题解答》md，默认读 `assets-source/faq/常见问题解答.md`；
可用 `--src <文件>`、环境变量 `DREAM_FAQ_SRC`，
或在 `tools/build.local.py` 里设置 `FAQ_SRC` 指定。

输出：data/wiki-faq.json
  { meta, sections: [ { id, index, title:{zh,en}, items: [ {id, no, q:{zh,en}, a:{zh,en}, commands:[], links:[] } ] } ] }
"""

from __future__ import annotations

import argparse
import json
import os
import re
from datetime import datetime, timedelta, timezone

import build_paths

SITE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_SRC = os.path.join(SITE_ROOT, "assets-source", "faq", "常见问题解答.md")
OUT = os.path.join(SITE_ROOT, "data", "wiki-faq.json")
CST = timezone(timedelta(hours=8))

# 章节中文 → 英文（界面英文用；内容正文暂留中文）
SECTION_EN = {
    "地图下载": "Download & Install",
    "地图机制": "Gameplay & Mechanics",
    "联机相关": "Multiplayer",
    "更新与安装": "Updates",
    "其他": "Misc",
}


def unescape_md(s: str) -> str:
    s = s.replace("<br>", "\n")
    s = re.sub(r"\\([\\`*_{}\[\]()#+\-.!~|])", r"\1", s)
    s = re.sub(r"\*\*(.+?)\*\*", r"\1", s)
    s = re.sub(r"~~(.+?)~~", r"\1", s)
    return s.strip()


def md_links(text: str) -> tuple[str, list[dict]]:
    """抽出 markdown 链接，返回 (去链接后的文本, 链接数组)。"""
    links: list[dict] = []

    def repl(m: re.Match) -> str:
        label, url = m.group(1).strip(), m.group(2).strip()
        if url:
            links.append({"label": label or url, "url": url})
        return label

    text = re.sub(r"\[([^\]]*)\]\(([^)]+)\)", repl, text)
    text = re.sub(r"\[([^\]]*)\]\(\)", r"\1", text)       # 飞书导出常见：空链接
    return text, links


def split_no(title: str) -> tuple[str, str]:
    """把「1.1 地图怎么下载」拆成 ("1.1", "地图怎么下载")；没有题号则题号为空。"""
    m = re.match(r"^(\d+\.\d+)\s*(.*)$", title)
    if m:
        return m.group(1), m.group(2).strip()
    return "", title.strip()


def parse(src: str) -> dict:
    raw = open(src, "rb").read()
    for enc in ("utf-8", "gbk"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    else:
        text = raw.decode("utf-8", "replace")

    lines = text.splitlines()
    sections: list[dict] = []
    current_section = None
    current_item = None
    pending_heading_level = None
    order_section = 0
    order_item = 0

    def flush_item():
        nonlocal current_item
        if current_item is not None and current_section is not None:
            current_section["items"].append(current_item)
        current_item = None

    for raw_line in lines:
        line = raw_line.rstrip()
        stripped = line.strip()

        m = re.match(r"^(#{2,4})\s*(.*)$", stripped)
        if m:
            level = len(m.group(1))
            title = m.group(2).strip()
            if level == 2:
                continue                                   # 文档大标题，跳过
            if not title:
                pending_heading_level = level              # 标题文字在下一段
                continue
            title = unescape_md(title)
            if level == 3:
                flush_item()
                order_section += 1
                current_section = {
                    "id": f"s{order_section}",
                    "index": order_section,
                    "title": {"zh": title, "en": SECTION_EN.get(title, "")},
                    "items": [],
                }
                sections.append(current_section)
            else:
                flush_item()
                if current_section is None:
                    order_section += 1
                    current_section = {"id": f"s{order_section}", "index": order_section,
                                       "title": {"zh": "其他", "en": SECTION_EN["其他"]}, "items": []}
                    sections.append(current_section)
                order_item += 1
                no, question = split_no(title)
                current_item = {"id": f"q{order_item:03d}", "no": no, "q": {"zh": question, "en": ""},
                                "a": {"zh": "", "en": ""}, "commands": [], "links": []}
            continue

        if not stripped:
            continue

        # 空标题后紧跟的正文 = 标题本身
        if pending_heading_level is not None:
            level, pending_heading_level = pending_heading_level, None
            title = unescape_md(stripped)
            if level == 3:
                flush_item()
                order_section += 1
                current_section = {"id": f"s{order_section}", "index": order_section,
                                   "title": {"zh": title, "en": SECTION_EN.get(title, "")}, "items": []}
                sections.append(current_section)
            else:
                flush_item()
                if current_section is None:
                    order_section += 1
                    current_section = {"id": f"s{order_section}", "index": order_section,
                                       "title": {"zh": "其他", "en": SECTION_EN["其他"]}, "items": []}
                    sections.append(current_section)
                order_item += 1
                # 题号形如 "1.1 地图怎么下载" / "4.6 为什么不更新到高版本"
                no, question = split_no(title)
                current_item = {"id": f"q{order_item:03d}", "no": no, "q": {"zh": question, "en": ""},
                                "a": {"zh": "", "en": ""}, "commands": [], "links": []}
            continue

        if current_item is None:
            continue

        # 正文：命令单独收集，便于前端渲染成代码块
        body, links = md_links(unescape_md(stripped))
        current_item["links"].extend(links)
        cmd = extract_command(body)
        if cmd:
            if cmd["label"]:
                current_item["a"]["zh"] = (current_item["a"]["zh"] + "\n" + cmd["label"]).strip()
            current_item["commands"].append(cmd["command"])
            continue
        if body:
            current_item["a"]["zh"] = (current_item["a"]["zh"] + "\n" + body).strip()

    flush_item()

    # 去掉没有任何问答的空章节
    sections = [s for s in sections if s["items"]]

    # 把「详见 2.6」这类互相引用**内联展开**：读者不该为了看一条指令再跳一次文档
    inline_cross_refs(sections)

    total = sum(len(s["items"]) for s in sections)
    return {
        "meta": {
            "generatedAt": datetime.now(CST).isoformat(timespec="seconds"),
            "generator": "site/tools/build_wiki_faq.py",
            "source": os.path.basename(src),
            "docUpdatedAt": "2026-07-21",
            "counts": {"sections": len(sections), "items": total},
            "bilingual": True,
            "enCoverage": 0,
            "note": "官方 FAQ 原文（按章节结构化）；正文中的「详见 X.Y」已自动内联展开，答案正文为中文，英文留空回退中文",
        },
        "sections": sections,
    }


CROSS_REF_RE = re.compile(r"^详见\s*(\d+(?:\.\d+)?)\s*$")
DOC_URL_RE = re.compile(r"https?://[^\s)\"']+")

# 一行里可能写成「重开指令：/function example_pack:restart_all」——标签与命令拆开，命令单独成块并给复制按钮
CMD_ROOTS = (
    "function|kill|scoreboard|give|tp|teleport|effect|gamemode|setblock|execute|summon|fill|data|"
    "say|tellraw|time|weather|difficulty|advancement|playsound|particle|title|bossbar|forceload|"
    "stop|reload|op|deop|me|trigger|tag|team|clone|setworldspawn|gamerule|spawnpoint|clear|xp|enchant"
)
CMD_IN_LINE_RE = re.compile(rf"(?P<cmd>/(?:{CMD_ROOTS})\b[^\s，。；]*.*)$")


def extract_command(text: str) -> dict | None:
    """把一行拆成 {label, command}；不是命令则返回 None。"""
    s = text.strip()
    if not s:
        return None
    m = CMD_IN_LINE_RE.search(s)
    if not m:
        return None
    cmd = m.group("cmd").strip()
    label = s[: m.start()].strip().rstrip("：: ").strip()
    # 命令后面如果粘了中文说明，只保留命令本体
    cmd = re.split(r"\s{2,}", cmd)[0].strip()
    return {"label": label, "command": cmd}


def inline_cross_refs(sections: list[dict]) -> None:
    """答案若只是「详见 2.6」这种交叉引用，就把被引用条目的正文与命令抄过来。"""
    flat = [(s, it) for s in sections for it in s["items"]]
    by_no = {}
    for _s, it in flat:
        if it["no"]:
            by_no[it["no"]] = it

    for _s, item in flat:
        answer = item["a"]["zh"].strip()
        if not answer or len(answer) > 60:
            continue
        m = CROSS_REF_RE.match(answer)
        target_no = None
        if m:
            target_no = m.group(1)
        else:
            # 「详见2.6」可能带 markdown 链接被剥掉后剩下别的内容，做一次宽松匹配
            loose = re.search(r"详见\s*(\d+(?:\.\d+)?)", answer)
            if loose and len(answer) <= 40:
                target_no = loose.group(1)
        if not target_no:
            continue
        # 链接指向同一篇文档时才算交叉引用
        same_doc = any("feishu.cn" in (l.get("url") or "") for l in item["links"]) or m is not None
        if not same_doc:
            continue
        target = by_no.get(target_no)
        if not target:
            continue
        item["a"]["zh"] = f"同 {target_no}：{target['a']['zh'].strip()}" if target["a"]["zh"].strip() else f"同 {target_no}。"
        merged = []
        for cmd in [*target["commands"], *item["commands"]]:
            if cmd not in merged:
                merged.append(cmd)
        item["commands"] = merged
        item["inlinedFrom"] = target_no
        item["links"] = [l for l in item["links"] if "feishu.cn" not in (l.get("url") or "")]


def main() -> int:
    ap = argparse.ArgumentParser(description="生成《常见问题解答》百科数据")
    ap.add_argument("--src", metavar="FILE", help="常见问题解答 md；默认 assets-source/faq/常见问题解答.md")
    args = ap.parse_args()

    src = build_paths.resolve(args.src, "DREAM_FAQ_SRC", "FAQ_SRC", DEFAULT_SRC)
    if not os.path.exists(src):
        raise SystemExit(
            f"找不到《常见问题解答.md》：{src}\n"
            "可用 --src 指定，或设置环境变量 DREAM_FAQ_SRC；"
            "也可把文件放到仓库内 assets-source/faq/ 下。"
        )

    payload = parse(src)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)

    print(f"[输出] {OUT}  {os.path.getsize(OUT) / 1024:.1f} KB")
    print(f"[统计] 章节 {payload['meta']['counts']['sections']} 个 / 问答 {payload['meta']['counts']['items']} 条")
    for s in payload["sections"]:
        print(f"   {s['title']['zh']:<8} ({s['title']['en'] or '—'})  {len(s['items'])} 条")
        for it in s["items"]:
            cmd = f" [命令 {len(it['commands'])}]" if it["commands"] else ""
            link = f" [链接 {len(it['links'])}]" if it["links"] else ""
            print(f"      {it['no'] or '  ':<6} {it['q']['zh'][:44]:<46}{cmd}{link}  答:{len(it['a']['zh'])}字")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
