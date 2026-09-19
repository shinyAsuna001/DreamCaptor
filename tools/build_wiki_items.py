#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""build_wiki_items.py —— 生成「物品」百科数据（doc 优先 + 地图包补齐）

数据来源（两路合并，**文档为准**）：
  A. 官方文档《捕梦者道具全图鉴》（md 表格）→ 分类 / 名字 / 特性 / 等阶 / 投稿人 / 特殊说明
  B. 1.4.04 地图发行包（describe*.mcfunction 的 tellraw 文本）→ 名称 / 类型【】/ 颜色码 / 关卡专属池

合并规则：
  - 以文档行为主（文档是官方口径）
  - 按"名字"归一化匹配（去空格、全半角、去掉【】与标点）补上 B 的类型/颜色/池
  - B 里文档没收录的条目，另立一组「待整理（自动提取）」保留，不丢数据
  - 用 A 的「等阶」与 B 的「颜色码」做交叉统计，**推导出颜色↔等阶映射**（可人工覆盖）

输出：
  site/data/wiki-items.json
  site/public/assets/img/wiki/bow-damage-table.webp（官方附表图片）

只读地图 zip 与文档；sources 里记录来源，便于追溯。
"""

from __future__ import annotations

import argparse
import io
import json
import os
import re
import unicodedata
import zipfile
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

from PIL import Image

import build_paths

# 命令行传入的路径（main() 里赋值）
CLI_PKG: str | None = None

SITE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOC_MD = os.path.join(SITE_ROOT, "assets-source", "items-doc", "捕梦者道具全图鉴.md")
DOC_IMG = os.path.join(SITE_ROOT, "assets-source", "items-doc", "图片和附件", "image.png")
OUT_JSON = os.path.join(SITE_ROOT, "data", "wiki-items.json")
OUT_IMG_DIR = os.path.join(SITE_ROOT, "public", "assets", "img", "wiki")

MAP_ZIP_CANDIDATES = [
    os.path.join(SITE_ROOT, "assets-source", "map-package", "【地图文件】捕梦者.zip"),
]
CST = timezone(timedelta(hours=8))

# 等阶顺序与名称：**以作者口径为准**（2026-09 作者确认）
#   白=平淡 / 蓝=微涛 / 紫=刻骨 / 金=铭心 / 红=诅咒 / 灰=泰酷辣
#   注意：不叫「遗忘」，中文名就是「诅咒」；颜色与等阶一一对应
TIER_ORDER = ["平淡", "微涛", "刻骨", "铭心", "诅咒", "泰酷辣"]

# 颜色码 → 等阶（作者确认的一一对应关系）
COLOR_TIER_HINT = {
    "white": "平淡",
    "blue": "微涛",
    "light_purple": "刻骨",
    "gold": "铭心",
    "red": "诅咒",
    "dark_red": "诅咒",
    "gray": "泰酷辣",
}


# ------------------------------------------------------------------ 工具

# 手工修正表（作者确认；优先于文档与颜色映射）
MANUAL_TIER = {
    "最后的家当": "铭心",       # 官方图鉴那格误写成「自由工作者初始」，作者已确认是铭心
}

# 分组 id → 面向用户的显示名（不暴露"自动提取/待整理"这类内部说法）
GROUP_RENAME = {
    "pending": "其他道具",
}


def unescape_md(text: str) -> str:
    text = text.replace("<br>", "\n").replace("<br/>", "\n").replace("<br />", "\n")
    text = re.sub(r"\\([\\`*_{}\[\]()#+\-.!~|])", r"\1", text)
    text = re.sub(r"\*\*(.+?)\*\*", r"\1", text)          # 去粗体标记
    return text.strip()


def norm_key(name: str) -> str:
    """归一化名字，用于两路数据对齐。

    注意：**保留 ？/！ 等语义标点** —— 包里同时存在「猎人的储备」与「猎手的储备？」，
    若把标点抹掉就会把两个不同道具错配到一起（这是实测踩过的坑）。
    """
    s = unicodedata.normalize("NFKC", unescape_md(name))
    s = re.sub(r"[\s【】\[\]（）()、,，。.·:：;；'\"“”‘’\-—_/\\]", "", s)
    return s.lower()


def split_row(line: str) -> list[str]:
    raw = line.strip()
    if raw.startswith("|"):
        raw = raw[1:]
    if raw.endswith("|"):
        raw = raw[:-1]
    return [c.strip() for c in raw.split("|")]


# ------------------------------------------------------------------ A. 官方文档

GROUP_RE = re.compile(r"^(DLC\d+)\s*(.*)$")


def parse_doc(path: str) -> tuple[list[dict], list[dict]]:
    """解析图鉴 md 表格，返回 (items, groups)。"""
    with open(path, encoding="utf-8") as f:
        lines = f.read().splitlines()

    items: list[dict] = []
    groups: list[dict] = [{"id": "char", "name": "角色道具"}, {"id": "vanilla", "name": "捕梦者原版道具"}]
    current_group = "char"
    order = 0

    for line in lines:
        if not line.strip().startswith("|"):
            continue
        cells = split_row(line)
        if len(cells) < 4:
            continue
        # 表头 / 分隔行判定：**必须要求首列非空**，否则续行（首列为空）会被误判成分隔行
        first = cells[0]
        if first == "分类":
            continue
        if first and len(first) >= 3 and set(first) <= set("-: "):
            continue

        cat_raw = unescape_md(cells[0])
        name_raw = unescape_md(cells[1]) if len(cells) > 1 else ""
        effect = unescape_md(cells[2]) if len(cells) > 2 else ""
        tier = unescape_md(cells[3]) if len(cells) > 3 else ""
        contributor = unescape_md(cells[4]) if len(cells) > 4 else ""
        notes = unescape_md(cells[5]) if len(cells) > 5 else ""
        joke = unescape_md(cells[6]) if len(cells) > 6 else ""

        if cat_raw:
            if cat_raw.startswith("角色道具"):
                current_group = "char"
            elif cat_raw.startswith("捕梦者原版道具"):
                current_group = "vanilla"
            else:
                m = GROUP_RE.match(cat_raw)
                if m:
                    gid = m.group(1).lower()
                    gname = f"{m.group(1)} {m.group(2)}".strip()
                    if gid not in [g["id"] for g in groups]:
                        groups.append({"id": gid, "name": gname})
                    current_group = gid

        if not name_raw:
            continue                      # 占位空行
        # 名称必须是"真名字"：至少含一个中日韩字或字母数字（过滤掉 ✝ / 🥩 这类纯符号行）
        if not re.search(r"[\u4e00-\u9fffA-Za-z0-9]", name_raw):
            continue

        def clean(v: str) -> str:
            return "" if v.strip() in ("-", "—", "") else v.strip()

        # 等阶白名单校验：文档里有几行把「投稿人」写进了等阶列（列错位），不能当等阶用
        tier_clean = clean(tier)
        tier_valid = tier_clean in TIER_ORDER
        if not tier_valid and tier_clean:
            notes = (notes + "\n（原文等阶列写作：" + tier_clean + "）").strip() if notes else f"（原文等阶列写作：{tier_clean}）"
            tier_clean = ""

        order += 1
        items.append({
            "id": f"doc-{order:03d}",
            "name": {"zh": name_raw, "en": ""},
            "group": current_group,
            "tier": MANUAL_TIER.get(name_raw, tier_clean),
            "tierSource": "manual" if name_raw in MANUAL_TIER else ("doc" if tier_valid else ""),
            "effect": {"zh": clean(effect), "en": ""},
            "contributor": clean(contributor),
            "notes": {"zh": clean(notes), "en": ""},
            "editorNote": {"zh": clean(joke), "en": ""},
            "source": "doc",
        })
    return items, groups


# ------------------------------------------------------------------ B. 地图包

def find_map_zip() -> str | None:
    """地图包 zip：--pkg > DREAM_MAP_ZIP > tools/build.local.py 的 MAP_ZIP > 仓库内默认位置。"""
    candidate = build_paths.resolve(CLI_PKG, "DREAM_MAP_ZIP", "MAP_ZIP", MAP_ZIP_CANDIDATES[0])
    if os.path.exists(candidate):
        return candidate
    for p in MAP_ZIP_CANDIDATES:
        if os.path.exists(p):
            return p
    return None


def decode_text(b: bytes) -> str:
    for enc in ("utf-8", "gbk"):
        try:
            return b.decode(enc)
        except UnicodeDecodeError:
            continue
    return b.decode("utf-8", "replace")


def parse_package_items(zip_path: str) -> list[dict]:
    """从 describe*.mcfunction 里抽出道具条目（名称/类型/描述/颜色/池）。"""
    z = zipfile.ZipFile(zip_path)
    out: list[dict] = []
    for name in z.namelist():
        if "describe" not in name.lower() or not name.endswith(".mcfunction"):
            continue
        text = decode_text(z.read(name))
        for lineno, line in enumerate(text.splitlines(), start=1):
            line = line.strip()
            if "tellraw" not in line:
                continue
            m_text = re.search(r'"text"\s*:\s*"((?:[^"\\]|\\.)*)"', line)
            if not m_text:
                continue
            raw = m_text.group(1).encode().decode("unicode_escape", "ignore") if "\\u" in m_text.group(1) else m_text.group(1)
            raw = raw.replace('\\"', '"')
            m_color = re.search(r'"color"\s*:\s*"([^"]+)"', line)

            # 类型：【...】 或 （...）
            type_match = re.search(r"【([^】]{1,16})】", raw)
            item_type = type_match.group(1).strip() if type_match else ""
            body = raw.replace(type_match.group(0), "", 1) if type_match else raw

            # 名称与描述：优先以冒号切分
            split = re.split(r"[：:]", body, maxsplit=1)
            if len(split) == 2 and split[1].strip():
                nm, desc = split[0].strip(), split[1].strip()
            else:
                nm, desc = body.strip(), ""

            if not nm:
                continue
            out.append({
                "name": nm,
                "key": norm_key(nm),
                "type": item_type,
                "desc": desc,
                "color": (m_color.group(1) if m_color else ""),
                "file": name.split("/")[-1],
                "line": lineno,
            })
    z.close()
    return out


# ------------------------------------------------------------------ 主流程

def main() -> int:
    global CLI_PKG, DOC_MD
    ap = argparse.ArgumentParser(description="生成「道具与武器」百科数据")
    ap.add_argument("--doc", metavar="FILE", help="官方道具图鉴 md；默认 assets-source/items-doc/捕梦者道具全图鉴.md")
    ap.add_argument("--pkg", metavar="ZIP", help="地图包 zip（用于与图鉴交叉核对）；默认 assets-source/map-package/ 下的包")
    args = ap.parse_args()

    DOC_MD = build_paths.resolve(args.doc, "DREAM_ITEMS_DOC", "ITEMS_DOC_SRC", DOC_MD)
    CLI_PKG = args.pkg

    if not os.path.exists(DOC_MD):
        raise SystemExit(
            f"缺少官方道具图鉴：{DOC_MD}\n"
            "可用 --doc 指定，或设置环境变量 DREAM_ITEMS_DOC；"
            "也可把文件放到仓库内 assets-source/items-doc/ 下。"
        )

    doc_items, groups = parse_doc(DOC_MD)
    print(f"[A] 官方文档解析出 {len(doc_items)} 条道具，分组 {len(groups)} 个")

    pkg_items: list[dict] = []
    zip_path = find_map_zip()
    if zip_path:
        pkg_items = parse_package_items(zip_path)
        print(f"[B] 地图包 {os.path.basename(zip_path)} 解析出 {len(pkg_items)} 条（去重后 "
              f"{len({p['key'] for p in pkg_items})} 个名称）")
    else:
        print("[B] 未找到地图包，跳过补齐步骤")

    pkg_by_key: dict[str, dict] = {}
    for p in pkg_items:
        pkg_by_key.setdefault(p["key"], p)

    # ---- 合并：文档为主，补上包里的类型/颜色/池 ----
    matched = 0
    color_tier_votes: dict[str, Counter] = defaultdict(Counter)
    conflicts = []
    for it in doc_items:
        key = norm_key(it["name"]["zh"])
        p = pkg_by_key.get(key)
        it["matched"] = bool(p)
        if p:
            matched += 1
            it["type"] = p["type"]
            it["qualityColor"] = p["color"]
            it["pools"] = [p["type"]] if p["type"].endswith("道具池") else []
            it["packageDesc"] = {"zh": p["desc"], "en": ""}
            if it["tier"]:
                color_tier_votes[p["color"]][it["tier"]] += 1
                hinted = COLOR_TIER_HINT.get(p["color"], "")
                if hinted and hinted != it["tier"]:
                    it["tierConflict"] = {"docTier": it["tier"], "colorMapTier": hinted, "color": p["color"]}
                    conflicts.append({"name": it["name"]["zh"], **it["tierConflict"]})
        else:
            it.setdefault("type", "")
            it.setdefault("qualityColor", "")
            it.setdefault("pools", [])
            it.setdefault("packageDesc", {"zh": "", "en": ""})

    doc_keys = {norm_key(i["name"]["zh"]) for i in doc_items}
    extras = [p for k, p in pkg_by_key.items() if k not in doc_keys]
    print(f"[合并] 文档条目命中地图包 {matched}/{len(doc_items)}；包内未被文档收录 {len(extras)} 条")

    # ---- 用真实数据校正颜色→等阶映射 ----
    color_tier = dict(COLOR_TIER_HINT)
    evidence = {}
    for color, votes in color_tier_votes.items():
        top, count = votes.most_common(1)[0]
        evidence[color] = {"votes": dict(votes.most_common(5)), "winner": top, "samples": sum(votes.values())}
        if color and color not in color_tier:
            color_tier[color] = top
        elif color in color_tier and count >= 2 and color_tier[color] != top:
            color_tier[color] = top      # 实测覆盖默认推断
    print(f"[映射] 颜色→等阶 推导：{json.dumps(color_tier, ensure_ascii=False)}")

    extra_items = []
    for idx, p in enumerate(sorted(extras, key=lambda x: x["name"]), start=1):
        if not re.search(r"[\u4e00-\u9fffA-Za-z0-9]", p["name"]):
            continue                      # 过滤纯符号的伪条目
        mapped_tier = color_tier.get(p["color"], "")
        extra_items.append({
            "id": f"pkg-{idx:03d}",
            "name": {"zh": p["name"], "en": ""},
            "group": "pending",
            "tier": mapped_tier,
            "tierSource": "color-map" if mapped_tier else "",
            "effect": {"zh": p["desc"], "en": ""},
            "contributor": "",
            "notes": {"zh": "", "en": ""},
            "editorNote": {"zh": "", "en": ""},
            "type": p["type"],
            "qualityColor": p["color"],
            "pools": [p["type"]] if p["type"].endswith("道具池") else [],
            "packageDesc": {"zh": p["desc"], "en": ""},
            "matched": False,
            "source": "package",
        })
    groups.append({"id": "pending", "name": GROUP_RENAME["pending"]})

    # ---- 官方附表图片 ----
    appendix = None
    os.makedirs(OUT_IMG_DIR, exist_ok=True)
    if os.path.exists(DOC_IMG):
        im = Image.open(DOC_IMG).convert("RGBA")
        im.load()
        out_webp = os.path.join(OUT_IMG_DIR, "bow-damage-table.webp")
        im.save(out_webp, "WEBP", quality=88, method=6)
        appendix = {
            "id": "bow-damage",
            "title": {"zh": "弓与弩的弹射物伤害计算", "en": "Bow & crossbow projectile damage"},
            "image": "/assets/img/wiki/bow-damage-table.webp",
            "width": im.size[0], "height": im.size[1],
            "bytes": os.path.getsize(out_webp),
            "source": {"zh": "官方文档附表，来源 Minecraft Wiki", "en": "Official appendix, via Minecraft Wiki"},
        }
        print(f"[图片] 附表 → {out_webp}  {im.size[0]}x{im.size[1]}  {os.path.getsize(out_webp)/1024:.1f} KB")

    all_items = doc_items + extra_items
    tiers_present = Counter(i["tier"] for i in all_items if i["tier"])

    # 颜色 × 等阶 全量交叉表（含包内独有条目），用于向作者核对映射
    cross: dict[str, Counter] = defaultdict(Counter)
    for it in all_items:
        color = it.get("qualityColor") or ""
        if color:
            cross[color][it["tier"] or "(未定)"] += 1
    confirmed_colors = {
        c for c, e in evidence.items()
        if len(e["votes"]) == 1 and e["samples"] >= 3
    }
    tier_map_detail = {
        color: {
            "tier": tier,
            "confirmedByDoc": color in confirmed_colors,
            "evidence": evidence.get(color, {}).get("votes", {}),
        }
        for color, tier in color_tier.items()
    }

    payload = {
        "meta": {
            "generatedAt": datetime.now(CST).isoformat(timespec="seconds"),
            "generator": "site/tools/build_wiki_items.py",
            "sources": [
                {"kind": "official-doc", "file": "捕梦者道具全图鉴.md", "items": len(doc_items)},
                {"kind": "map-package", "file": os.path.basename(zip_path) if zip_path else None, "items": len(pkg_by_key)},
            ],
            "counts": {
                "total": len(all_items),
                "fromDoc": len(doc_items),
                "docMatchedInPackage": matched,
                "packageOnly": len(extra_items),
                "byTier": dict(tiers_present.most_common()),
            },
            "bilingual": True,
            "enCoverage": 0,
            "tierConflicts": conflicts,
            "tierNote": (
                "等阶以官方文档为准（tierSource=doc）；地图包自动提取的条目等阶由「物品颜色码」映射"
                "（tierSource=color-map）。颜色↔等阶由作者确认，一一对应："
                "白=平淡、蓝=微涛、紫=刻骨、金=铭心、红=诅咒、灰=泰酷辣。"
                "qualityColor 字段仅供后台核对，前台只展示中文等阶。"
            ),
            "colorTierCrossTable": {c: dict(v.most_common()) for c, v in sorted(cross.items())},
        },
        "tierOrder": TIER_ORDER,
        "colorTierMap": color_tier,
        "colorTierEvidence": evidence,
        "colorTierDetail": tier_map_detail,
        "groups": groups,
        "appendix": appendix,
        "items": all_items,
    }
    # 面向用户的说明（后台仍可从 meta 看到生成口径，这里只放用户该看的）
    payload["userNotes"] = [
        {"zh": "图鉴内容整理自官方文档与游戏内实测。", "en": "Compiled from official docs and in-game data."},
        {"zh": "等阶与颜色一一对应：白=平淡、蓝=微涛、紫=刻骨、金=铭心、红=诅咒、灰=泰酷辣。", "en": "Tier ↔ colour: white=平淡, blue=微涛, purple=刻骨, gold=铭心, red=诅咒, grey=泰酷辣."},
        {"zh": "「其他道具」分类下的条目暂未收录进官方图鉴。", "en": "Entries under “Other items” are not yet in the official gallery."},
    ]
    os.makedirs(os.path.dirname(OUT_JSON), exist_ok=True)
    with open(OUT_JSON, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
    print(f"[输出] {OUT_JSON}  {os.path.getsize(OUT_JSON)/1024:.1f} KB")
    print(f"[统计] 总 {len(all_items)} 条；等阶分布 {dict(tiers_present.most_common())}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
