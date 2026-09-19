#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""build_wiki_classes.py —— 生成「职业与天赋」百科数据

数据源：一份天赋描述文本（11 个职业 × 8 条天赋 = 88 条），
格式为 `#职业名` 段落 + 逐行 `天赋名：描述`。
默认读取 `assets-source/talents/全职业天赋描述.txt`；
可用 `--src <文件>`、环境变量 `DREAM_TALENTS_SRC`，
或在 `tools/build.local.py` 里设置 `TALENTS_SRC` 指定。

设计要点：
  - 描述整句存成**可编辑字符串**（维护后台可直接改）
  - 另外自动抽出描述里的**数字**放进 `values` 自由键值袋（如 4颗黄心 → {"黄心": 4}），
    平衡性改动时既可改整句、也可只改数值
  - 中英双语结构：所有文本字段为 {zh, en}，英文留空时前台回退显示中文
  - 职业英文 ID（Doctor / Soldier / …）作为副标题

用法：
  python build_wiki_classes.py                 # 读默认位置，写 data/wiki-classes.json
  python build_wiki_classes.py --src <文件>

输出：data/wiki-classes.json
"""

from __future__ import annotations

import argparse
import json
import os
import re
from datetime import datetime, timedelta, timezone

import build_paths

SITE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_SRC = os.path.join(SITE_ROOT, "assets-source", "talents", "全职业天赋描述.txt")
OUT = os.path.join(SITE_ROOT, "data", "wiki-classes.json")
CST = timezone(timedelta(hours=8))

# 数据源文件路径，运行时由 resolve_src() 确定
SRC = DEFAULT_SRC


def resolve_src(cli_value: str | None) -> str:
    """天赋描述文件：--src > DREAM_TALENTS_SRC > tools/build.local.py > 仓库内默认位置。"""
    return build_paths.resolve(cli_value, "DREAM_TALENTS_SRC", "TALENTS_SRC", DEFAULT_SRC)


# 官方职业名 ↔ 天赋文案里的简称
# 注意：以「自由职业者」（不是"无业游民"）、「警卫」（不是"重装"）为准
CLASS_DISPLAY = {
    "医生": ("医生", "Doctor"),
    "军人": ("退役军人", "Soldier"),
    "工匠": ("工匠", "Crafter"),
    "自由": ("自由职业者", "Jobless"),
    "极限": ("极限运动员", "Fighter"),
    "赌徒": ("赌徒", "Gambler"),
    "猎人": ("猎人", "Hunter"),
    "屠夫": ("屠夫", "Butcher"),
    "催眠": ("催眠师", "Hypnotist"),
    "警卫": ("警卫", "Guard"),
    "决斗家": ("决斗家", "Duelist"),
}

# 兼容各种写法的英文 ID（含官方文档里的旧名）
CLASS_EN = {k: v[1] for k, v in CLASS_DISPLAY.items()}
CLASS_EN.update({"退役军人": "Soldier", "无业游民": "Jobless", "自由工作者": "Jobless",
                 "极限运动员": "Fighter", "催眠师": "Hypnotist", "重装": "Guard"})

# 数值抽取用的单位/名词表（纯提示，不参与正确性判断）
VALUE_UNITS = ["点", "颗", "秒", "个", "箭", "箭矢", "能量", "灵感", "护甲", "护甲值", "生命",
               "上限", "黄心", "伤害", "概率", "倍", "层", "格", "次", "波", "%"]


def decode(path: str) -> str:
    raw = open(path, "rb").read()
    for enc in ("utf-8", "gbk"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", "replace")


def extract_values(desc: str) -> dict:
    """从描述里抽数字 → 键值袋。例如「1P 4 颗黄心」→ {"黄心": 4}。"""
    values: dict[str, float | int] = {}
    for num, unit in re.findall(r"(\d+(?:\.\d+)?)\s*([%]|点|颗|秒|个|层|倍|格|次|波|箭矢?|能量|灵感|护甲值?|生命|上限|黄心|伤害|概率)?", desc):
        key = unit or "数值"
        try:
            v = float(num)
        except ValueError:
            continue
        if v == int(v):
            v = int(v)
        # 同名键冲突时用后缀区分，保留全部数字
        if key in values and values[key] != v:
            i = 2
            while f"{key}{i}" in values:
                i += 1
            key = f"{key}{i}"
        if key not in values:
            values[key] = v
    return values


def main() -> int:
    global SRC
    ap = argparse.ArgumentParser(description="生成「职业与天赋」百科数据")
    ap.add_argument("--src", metavar="FILE", help="天赋描述文本；默认 assets-source/talents/全职业天赋描述.txt 或 $DREAM_TALENTS_SRC")
    args = ap.parse_args()
    SRC = resolve_src(args.src)

    if not os.path.exists(SRC):
        raise SystemExit(
            f"缺少天赋描述文件：{SRC}\n"
            "可用 --src 指定，或设置环境变量 DREAM_TALENTS_SRC；"
            "也可把文件放到仓库内 assets-source/talents/ 下。"
        )

    text = decode(SRC)
    classes: list[dict] = []
    current = None
    order = 0

    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        if line.startswith("#"):
            alias = line.lstrip("#").strip()
            display_zh, display_en = CLASS_DISPLAY.get(alias, (alias, CLASS_EN.get(alias, "")))
            order += 1
            slug = (display_en or f"class{order}").lower()
            current = {
                "id": f"c{order:02d}",
                "slug": slug,
                "name": {"zh": display_zh, "en": display_en},
                "nameEn": display_en,
                "alias": {"zh": alias, "en": ""},
                "order": order,
                "desc": {"zh": "", "en": ""},
                "image": f"/assets/img/wiki/classes/{slug}.webp",
                "talents": [],
                "source": "全职业天赋描述.txt",
            }
            classes.append(current)
            continue
        if current is None:
            continue
        m = re.match(r"^(.{1,24}?)[：:]\s*(.+)$", line)
        if not m:
            continue
        tname, tdesc = m.group(1).strip(), m.group(2).strip()
        current["talents"].append({
            "id": f"{current['id']}-t{len(current['talents']) + 1:02d}",
            "name": {"zh": tname, "en": ""},
            "desc": {"zh": tdesc, "en": ""},
            "values": extract_values(tdesc),
            "note": {"zh": "", "en": ""},
            "image": "",
        })

    total_talents = sum(len(c["talents"]) for c in classes)
    payload = {
        "meta": {
            "generatedAt": datetime.now(CST).isoformat(timespec="seconds"),
            "generator": "site/tools/build_wiki_classes.py",
            "source": os.path.basename(SRC),
            "counts": {"classes": len(classes), "talents": total_talents},
            "bilingual": True,
            "enCoverage": 0,
            "note": "天赋描述为可编辑字符串；描述中的数字已额外抽到 values 键值袋，便于平衡性调整",
        },
        "classes": classes,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)

    print(f"[输出] {OUT}  {os.path.getsize(OUT) / 1024:.1f} KB")
    print(f"[统计] 职业 {len(classes)} 个 / 天赋 {total_talents} 条")
    for c in classes:
        print(f"   {c['name']['zh']:<8} ({c['nameEn'] or '—':<10}) 原简称={c['alias']['zh']:<4} {len(c['talents'])} 条天赋"
              f"   例：{c['talents'][0]['name']['zh']} → values={c['talents'][0]['values']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
