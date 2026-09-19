#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""build.local.example.py —— 本机构建配置模板

把本文件复制成同目录下的 `build.local.py`（该文件名已在 .gitignore 中，不会被提交），
填上你自己机器上素材源文件的位置。构建脚本会优先读这里的路径，
因此仓库里不必出现任何个人路径。

全部变量都是可选的：没写的就用仓库内的默认位置（`assets-source/...`），
也可以在命令行上用 `--src` / `--pkg` 临时指定。

对应脚本：
  build_assets.py        读 ASSET_SRC          （背景图 PNG + logo 所在目录）
  build_wiki_items.py    读 ITEMS_DOC_SRC      （官方道具图鉴 md）/ MAP_ZIP（地图包 zip，用于交叉核对）
  build_wiki_classes.py  读 TALENTS_SRC        （全职业天赋描述 txt）
  build_wiki_faq.py      读 FAQ_SRC            （常见问题解答 md）
"""

ASSET_SRC = r"D:\我的素材\幻灯片背景"
ITEMS_DOC_SRC = r"D:\我的素材\items-doc\捕梦者道具全图鉴.md"
MAP_ZIP = r"D:\我的素材\【地图文件】捕梦者.zip"
TALENTS_SRC = r"D:\我的素材\talents\全职业天赋描述.txt"
FAQ_SRC = r"D:\我的素材\常见问题解答.md"
