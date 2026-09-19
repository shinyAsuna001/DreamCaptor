#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""build_all.py —— 一键重跑全部数据构建脚本（幂等）

顺序：
  1. build_assets.py       素材：源图 → WebP 三档 + LQIP + 清单
  2. build_wiki_items.py   物品：官方图鉴文档 + 地图包
  3. build_wiki_classes.py 职业与天赋：全职业天赋描述.txt
  4. build_wiki_faq.py     常见问题：官方 FAQ 文档

用法：
  python tools/build_all.py            # 全部重跑
  python tools/build_all.py --skip-assets   # 跳过耗时的素材压缩
"""

from __future__ import annotations

import os
import subprocess
import sys

TOOLS = os.path.dirname(os.path.abspath(__file__))
STEPS = [
    ("build_assets.py", "素材（WebP 三档 + LQIP + 清单）", True),
    ("build_wiki_items.py", "物品（文档 + 地图包）", False),
    ("build_wiki_classes.py", "职业与天赋", False),
    ("build_wiki_faq.py", "常见问题", False),
]


def main() -> int:
    skip_assets = "--skip-assets" in sys.argv
    failed = []
    for script, label, is_assets in STEPS:
        if skip_assets and is_assets:
            print(f"--- 跳过 {label} ---")
            continue
        print(f"\n=== {label}：{script} ===")
        proc = subprocess.run([sys.executable, os.path.join(TOOLS, script)], cwd=os.path.dirname(TOOLS))
        if proc.returncode != 0:
            failed.append(script)
            print(f"!!! {script} 退出码 {proc.returncode}")
        else:
            print(f"--- {label} 完成 ---")
    print("\n=== 汇总 ===")
    if failed:
        print("失败：" + "、".join(failed))
        return 1
    print("全部构建成功")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
