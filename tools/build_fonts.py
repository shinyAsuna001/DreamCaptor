#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""build_fonts.py —— 中文字体子集化（自托管，不依赖 CDN）

为什么要子集：本机 NotoSansSC-VF.ttf 17MB / NotoSerifSC-VF.ttf 24MB，直接上站不可接受。
做法：
  1. 从站点全部数据（data/*.json）与前端硬编码文案里收集实际用到的字符集
  2. 用 fontTools.varLib.instancer 把可变字体**定重**（400 / 700），避免携带全部字重
  3. 用 fontTools.subset 按字符集裁剪
  4. 输出 woff2（有 brotli 时）或 woff（无 brotli 时）到 public/assets/fonts/

字体授权：Noto Sans SC / Noto Serif SC 均为 SIL OFL 1.1，可自托管与再分发（随包附 LICENSE）。

用法：python tools/build_fonts.py [--check]
"""

from __future__ import annotations

import argparse
import io
import json
import os
import re
import sys

SITE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FONT_DIR = os.path.join(SITE_ROOT, "public", "assets", "fonts")
DATA_DIR = os.path.join(SITE_ROOT, "data")
PUBLIC_DIR = os.path.join(SITE_ROOT, "public")

SYSTEM_FONTS = r"C:\Windows\Fonts"
JOBS = [
    # (源文件, 输出名, 字重, 是否斜体)
    (os.path.join(SYSTEM_FONTS, "NotoSansSC-VF.ttf"), "noto-sans-sc-400", 400, False),
    (os.path.join(SYSTEM_FONTS, "NotoSansSC-VF.ttf"), "noto-sans-sc-700", 700, False),
    (os.path.join(SYSTEM_FONTS, "NotoSerifSC-VF.ttf"), "noto-serif-sc-700", 700, False),
]

EXTRA_CHARS = (
    "捕梦者崩坏的梦境官网首页地图介绍百科关卡物品职业与天赋敌人难度常见问题下载社区赞助制作组留言板"
    "切换语言跳到主要内容登录注册退出复制链接待补充图片位缺图加载中失败暂无数据搜索筛选显示更多上一页下一页"
    "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
    "，。、；：？！“”‘’（）《》【】—…·￥%+-×÷=~@#&*/\\|<>[]{}`^$_"
    "　 .,;:?!\"'()[]{}<>/\\|-_+=*&^%$#@~`"
)


def collect_chars() -> set[str]:
    chars: set[str] = set(EXTRA_CHARS)
    for root, _dirs, files in os.walk(DATA_DIR):
        for name in files:
            if not name.endswith(".json"):
                continue
            try:
                with open(os.path.join(root, name), encoding="utf-8") as f:
                    text = f.read()
            except Exception:
                continue
            chars.update(text)
    # 前端 JS/CSS 里的中文（标签、提示语）
    for sub in ("js", "css"):
        for root, _dirs, files in os.walk(os.path.join(PUBLIC_DIR, sub)):
            for name in files:
                try:
                    with open(os.path.join(root, name), encoding="utf-8") as f:
                        text = f.read()
                except Exception:
                    continue
                chars.update(re.findall(r"[\u3000-\u9fff\uff00-\uffef\u2000-\u206f]", text))
    # 只保留可打印字符
    return {c for c in chars if c.isprintable() or c == " "}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="只报告现状，不重新生成")
    args = ap.parse_args()

    try:
        from fontTools import subset
        from fontTools.ttLib import TTFont
        from fontTools.varLib import instancer
    except ImportError:
        print("缺少 fontTools：python -m pip install fonttools", file=sys.stderr)
        return 1

    has_brotli = True
    try:
        import brotli  # noqa: F401
    except ImportError:
        has_brotli = False
    flavor = "woff2" if has_brotli else "woff"
    print(f"fontTools 可用；brotli {'可用 → 输出 woff2' if has_brotli else '不可用 → 输出 woff'}")

    os.makedirs(FONT_DIR, exist_ok=True)
    chars = collect_chars()
    text = "".join(sorted(chars))
    print(f"字符集大小：{len(chars)} 个字符")

    if args.check:
        for _src, out_name, _w, _i in JOBS:
            for ext in ("woff2", "woff"):
                p = os.path.join(FONT_DIR, f"{out_name}.{ext}")
                if os.path.exists(p):
                    print(f"  {os.path.basename(p)}  {os.path.getsize(p) / 1024:.1f} KB")
        return 0

    text_file = os.path.join(FONT_DIR, ".subset-chars.txt")
    with open(text_file, "w", encoding="utf-8") as f:
        f.write(text)

    total = 0
    for src, out_name, weight, _italic in JOBS:
        if not os.path.exists(src):
            print(f"  跳过（字体不存在）：{src}")
            continue
        font = TTFont(src)
        # 定重：把可变字体压成单一字重
        if "fvar" in font:
            try:
                font = instancer.instantiateVariableFont(font, {"wght": weight}, inplace=False, updateFontNames=False)
            except Exception as err:  # noqa: BLE001
                print(f"  定重失败（继续用原 VF）：{err}")
        buf = io.BytesIO()
        font.save(buf)
        buf.seek(0)

        options = subset.Options()
        options.flavor = flavor
        options.desubroutinize = True
        options.layout_features = ["*"]
        options.name_IDs = ["*"]
        options.notdef_outline = True
        options.recalc_bounds = True
        options.drop_tables += ["DSIG"]

        subsetter = subset.Subsetter(options=options)
        subsetter.populate(text=text)
        font2 = TTFont(buf)
        subsetter.subset(font2)

        out_path = os.path.join(FONT_DIR, f"{out_name}.{flavor}")
        font2.flavor = flavor
        font2.save(out_path)
        size = os.path.getsize(out_path)
        total += size
        print(f"  {os.path.basename(out_path):28s} {size / 1024:8.1f} KB  (wght {weight})")

    try:
        os.remove(text_file)
    except OSError:
        pass

    # 授权说明（OFL 要求随字体分发许可）
    license_note = os.path.join(FONT_DIR, "LICENSE.txt")
    with open(license_note, "w", encoding="utf-8") as f:
        f.write(
            "本目录字体为 Noto Sans SC / Noto Serif SC 的子集（由 tools/build_fonts.py 生成）。\n"
            "二者均以 SIL Open Font License 1.1 授权，允许自由使用、修改与再分发。\n"
            "许可全文：https://scripts.sil.org/OFL\n"
            "版权：Copyright The Noto Project Authors (https://github.com/notofonts)\n"
        )
    print(f"  合计 {total / 1024:.1f} KB；授权说明已写入 LICENSE.txt")
    print("注意：CSS 里的 @font-face 需要与输出扩展名一致（woff2 / woff），见 public/css/base.css")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
