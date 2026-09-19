#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""build_paths.py —— 内容构建脚本的本机路径解析

这些生成脚本要读"素材源文件"（原始截图、官方文档、地图包等），它们不属于仓库内容，
每个人的存放位置也不同。解析优先级：

  1. 命令行参数（各脚本自己的 `--src` / `--pkg` 之类）
  2. 环境变量（由调用方传入的 `env_var` 名）
  3. `tools/build.local.py`（**本机文件，不进版本库**；见 build.local.example.py）
  4. 仓库内的默认位置（`assets-source/...`）

这样仓库里不出现任何个人路径，同时本机可以照旧直接从原目录构建。
"""
from __future__ import annotations

import importlib.util
import os

TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
SITE_ROOT = os.path.dirname(TOOLS_DIR)
LOCAL_CONFIG = os.path.join(TOOLS_DIR, "build.local.py")

_cache: dict | None = None


def local_config() -> dict:
    """读取 tools/build.local.py（存在才读），返回其中的大写变量。"""
    global _cache
    if _cache is not None:
        return _cache
    _cache = {}
    if os.path.exists(LOCAL_CONFIG):
        spec = importlib.util.spec_from_file_location("build_local", LOCAL_CONFIG)
        if spec and spec.loader:
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            _cache = {k: v for k, v in vars(mod).items() if k.isupper() and isinstance(v, str)}
    return _cache


def resolve(cli_value: str | None, env_var: str, config_key: str, default: str) -> str:
    """按优先级解析一个路径；返回绝对路径。"""
    for candidate in (cli_value, os.environ.get(env_var), local_config().get(config_key)):
        if candidate:
            return os.path.abspath(candidate)
    return os.path.abspath(default)
