#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""捕梦者官网 · 素材管线（可重复运行）

做什么：
  1) 把源素材（背景 PNG + logo）复制进 `assets-source/`（只复制，不改动原图）
  2) 生成 WebP 三档（1920/1280/640）+ LQIP（32px 模糊占位）到 `public/assets/img/`
  3) 生成 logo 的 WebP/PNG/favicon 变体（保留透明通道）
  4) 写出素材清单 `data/assets.json`（源文件 → 输出文件 → 尺寸 → 体积 → sha256）
  5) 强制校验总体积 ≤ BUDGET_BYTES，超标即非零退出

用法：
  python build_assets.py                # 全量重建（源目录默认 assets-source/）
  python build_assets.py --src <目录>    # 指定源素材目录（背景 PNG + logo 所在目录）
  python build_assets.py --check        # 只校验清单与体积，不重新编码
  python build_assets.py --sheet out.webp   # 额外输出一张背景编号联系表（供人工分配用途）

源素材目录的优先级：`--src` 参数 > 环境变量 `DREAM_ASSET_SRC` > 本机配置
`tools/build.local.py` 的 `ASSET_SRC` > 仓库内 `assets-source/`。

依赖：Pillow（需带 libwebp）。仓库其余部分零第三方依赖。
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import shutil
import sys
from datetime import datetime, timezone, timedelta

from PIL import Image, features

import build_paths

# ---------------------------------------------------------------- 配置

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # 仓库根
SRC_COPY_DIR = os.path.join(ROOT, "assets-source")
OUT_IMG_DIR = os.path.join(ROOT, "public", "assets", "img")
MANIFEST_PATH = os.path.join(ROOT, "data", "assets.json")

# 源素材目录，运行时由 resolve_src_dir() 确定（参数 / 环境变量 / 仓库内目录）
SRC_DIR = SRC_COPY_DIR
SRC_LOGO_NAME = "捕梦者图标.png"

BG_TIERS = [(1920, 78), (1280, 75), (640, 70)]     # (最长边, WebP 质量)
LQIP_LONGEST, LQIP_QUALITY = 32, 35

LOGO_WEBP = [(512, 90), (256, 88)]                 # (最长边, 质量)
LOGO_PNG = [("logo-256.png", 256), ("favicon-64.png", 64), ("apple-touch-180.png", 180)]

BUDGET_BYTES = 25 * 1024 * 1024                    # 全部输出图片的总体积预算：25MB
CST = timezone(timedelta(hours=8))


def resolve_src_dir(cli_value: str | None) -> str:
    """源素材目录：--src > DREAM_ASSET_SRC > tools/build.local.py > 仓库内 assets-source/。"""
    return build_paths.resolve(cli_value, "DREAM_ASSET_SRC", "ASSET_SRC", SRC_COPY_DIR)


# ---------------------------------------------------------------- 工具

def log(msg: str) -> None:
    print(msg, flush=True)


def sha256_of(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def ensure_dirs() -> None:
    for d in (SRC_COPY_DIR, OUT_IMG_DIR, os.path.dirname(MANIFEST_PATH)):
        os.makedirs(d, exist_ok=True)


def resize_longest(im: Image.Image, longest: int) -> Image.Image:
    w, h = im.size
    if max(w, h) <= longest:
        return im.copy()
    scale = longest / max(w, h)
    return im.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)


def write_webp(im: Image.Image, path: str, quality: int) -> int:
    im.save(path, "WEBP", quality=quality, method=6)
    return os.path.getsize(path)


def relative_to_root(path: str) -> str:
    return "/" + os.path.relpath(path, ROOT).replace(os.sep, "/")


# ---------------------------------------------------------------- 步骤

def copy_sources() -> list[str]:
    """把背景源图与 logo 复制进 assets-source，返回源文件名列表（按文件名排序）。"""
    if not os.path.isdir(SRC_DIR):
        raise SystemExit(f"源目录不存在：{SRC_DIR}\n可用 --src 指定，或设置环境变量 DREAM_ASSET_SRC；也可把素材放进仓库内 assets-source/。")

    names = sorted(n for n in os.listdir(SRC_DIR) if n.lower().endswith(".png"))
    bgs = [n for n in names if n != SRC_LOGO_NAME]
    log(f"[1/4] 复制源素材 → {SRC_COPY_DIR}")
    log(f"      背景 {len(bgs)} 张 + logo「{SRC_LOGO_NAME}」")

    for n in bgs:
        src, dst = os.path.join(SRC_DIR, n), os.path.join(SRC_COPY_DIR, n)
        if not os.path.exists(dst) or os.path.getsize(dst) != os.path.getsize(src):
            shutil.copy2(src, dst)
    logo_dst = os.path.join(SRC_COPY_DIR, SRC_LOGO_NAME)
    logo_src = os.path.join(SRC_DIR, SRC_LOGO_NAME)
    if not os.path.exists(logo_dst) or os.path.getsize(logo_dst) != os.path.getsize(logo_src):
        shutil.copy2(logo_src, logo_dst)
    return bgs


def build_backgrounds(bgs: list[str]) -> list[dict]:
    log(f"[2/4] 生成背景 WebP 三档 + LQIP → {OUT_IMG_DIR}")
    entries = []
    total = 0
    for idx, name in enumerate(bgs, start=1):
        src = os.path.join(SRC_COPY_DIR, name)
        im = Image.open(src)
        im.load()
        src_bytes = os.path.getsize(src)
        sid = f"bg-{idx:02d}"
        outputs = []

        # 原图若带 alpha，背景层不需要透明度 → 合成到黑底（梦境=永夜，黑底最自然）
        if im.mode in ("RGBA", "LA", "P"):
            im = im.convert("RGBA")
            flat = Image.new("RGB", im.size, (5, 6, 14))
            flat.paste(im, mask=im.getchannel("A"))
            im = flat
        else:
            im = im.convert("RGB")

        for longest, q in BG_TIERS:
            r = resize_longest(im, longest)
            out = os.path.join(OUT_IMG_DIR, f"{sid}-{longest}.webp")
            size = write_webp(r, out, q)
            total += size
            outputs.append({
                "file": relative_to_root(out), "width": r.size[0], "height": r.size[1],
                "quality": q, "bytes": size,
            })

        # LQIP：极小模糊占位（前端做 blur-up，避免首屏白闪）
        r = resize_longest(im, LQIP_LONGEST)
        out = os.path.join(OUT_IMG_DIR, f"{sid}-lqip.webp")
        size = write_webp(r, out, LQIP_QUALITY)
        total += size
        outputs.append({
            "file": relative_to_root(out), "width": r.size[0], "height": r.size[1],
            "quality": LQIP_QUALITY, "bytes": size, "role": "lqip",
        })

        entries.append({
            "id": sid,
            "kind": "background",
            "source": name,
            "sourceBytes": src_bytes,
            "sourceSha256": sha256_of(src),
            "natural": {"width": im.size[0], "height": im.size[1]},
            "outputs": outputs,
            "outputBytes": sum(o["bytes"] for o in outputs),
            "use": None,          # 人工按联系表分配（hero / intro / wiki-* / download …）
            "alt": "",
        })
        log(f"      {sid}  {name}  {im.size[0]}x{im.size[1]}  →  "
            f"{'/'.join(str(o['bytes'] // 1024) + 'KB' for o in outputs if o.get('role') != 'lqip')}"
            f"  lqip {outputs[-1]['bytes']}B")
    return entries, total


def build_logo() -> tuple[dict, int]:
    log(f"[3/4] 生成 logo 变体 → {OUT_IMG_DIR}")
    src = os.path.join(SRC_COPY_DIR, SRC_LOGO_NAME)
    im = Image.open(src).convert("RGBA")
    im.load()
    outputs = []
    total = 0

    for longest, q in LOGO_WEBP:
        r = resize_longest(im, longest)
        out = os.path.join(OUT_IMG_DIR, f"logo-{longest}.webp")
        size = write_webp(r, out, q)
        total += size
        outputs.append({"file": relative_to_root(out), "width": r.size[0], "height": r.size[1],
                        "quality": q, "bytes": size, "format": "webp"})

    for fname, longest in LOGO_PNG:
        r = resize_longest(im, longest)
        out = os.path.join(OUT_IMG_DIR, fname)
        r.save(out, "PNG", optimize=True)
        size = os.path.getsize(out)
        total += size
        outputs.append({"file": relative_to_root(out), "width": r.size[0], "height": r.size[1],
                        "bytes": size, "format": "png", "alpha": True})

    entry = {
        "id": "logo",
        "kind": "logo",
        "source": SRC_LOGO_NAME,
        "sourceBytes": os.path.getsize(src),
        "sourceSha256": sha256_of(src),
        "natural": {"width": im.size[0], "height": im.size[1]},
        "outputs": outputs,
        "outputBytes": total,
        "use": "site-logo",
        "alt": "捕梦者：崩坏的梦境",
    }
    for o in outputs:
        log(f"      {os.path.basename(o['file'])}  {o['width']}x{o['height']}  {o['bytes'] / 1024:.1f} KB")
    return entry, total


def write_manifest(bg_entries: list[dict], logo_entry: dict, bg_total: int, logo_total: int) -> int:
    total = bg_total + logo_total
    manifest = {
        "generatedAt": datetime.now(CST).isoformat(timespec="seconds"),
        "generator": "site/tools/build_assets.py",
        "budgetBytes": BUDGET_BYTES,
        "totalBytes": total,
        "items": bg_entries + [logo_entry],
        "notes": [
            "assets-source/ 只用于开发，不进部署包。",
            "use 字段由人工分配（联系表见 _recon/），前端按 use 取图。",
            "所有输出均为 WebP；logo 额外提供 PNG 兜底与 favicon。",
        ],
    }
    with open(MANIFEST_PATH, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    return total


def make_contact_sheet(bgs: list[str], out_path: str, cols: int = 4, cell: int = 320) -> None:
    rows = (len(bgs) + cols - 1) // cols
    th = round(cell * 9 / 16)
    pad, label = 8, 22
    sheet = Image.new("RGB", (cols * cell + (cols + 1) * pad, rows * (th + label) + (rows + 1) * pad),
                      (10, 11, 22))
    for i, name in enumerate(bgs):
        im = Image.open(os.path.join(SRC_COPY_DIR, name)).convert("RGB")
        im.thumbnail((cell, th), Image.LANCZOS)
        cx = pad + (i % cols) * (cell + pad)
        cy = pad + (i // cols) * (th + label + pad)
        sheet.paste(im, (cx + (cell - im.size[0]) // 2, cy))
        sheet.paste(Image.new("RGB", (cell, label), (24, 26, 46)), (cx, cy + th))
    sheet = sheet.resize((sheet.size[0] // 2, sheet.size[1] // 2), Image.LANCZOS)
    sheet.save(out_path, "WEBP", quality=72, method=6)
    log(f"[联系表] {out_path}  {sheet.size[0]}x{sheet.size[1]}  "
        f"{os.path.getsize(out_path) / 1024:.1f} KB  （顺序：左上→右下 = bg-01 … bg-{len(bgs):02d}）")


# ---------------------------------------------------------------- 主流程

def main() -> int:
    global SRC_DIR
    ap = argparse.ArgumentParser(description="捕梦者官网素材管线")
    ap.add_argument("--src", metavar="DIR", help="源素材目录（背景 PNG + logo）；默认 assets-source/ 或 $DREAM_ASSET_SRC")
    ap.add_argument("--check", action="store_true", help="只校验清单与体积，不重新编码")
    ap.add_argument("--sheet", metavar="PATH", help="额外输出背景联系表（供人工分配用途）")
    args = ap.parse_args()

    SRC_DIR = resolve_src_dir(args.src)

    if not features.check("webp"):
        raise SystemExit("Pillow 缺少 WebP 支持，无法继续")

    ensure_dirs()

    if args.check:
        if not os.path.exists(MANIFEST_PATH):
            raise SystemExit("清单不存在，请先跑一次完整构建")
        with open(MANIFEST_PATH, encoding="utf-8") as f:
            m = json.load(f)
        missing, actual = [], 0
        for it in m["items"]:
            for o in it["outputs"]:
                p = os.path.join(ROOT, o["file"].lstrip("/").replace("/", os.sep))
                if not os.path.exists(p):
                    missing.append(o["file"])
                else:
                    actual += os.path.getsize(p)
        log(f"清单条目 {len(m['items'])} 个；输出文件缺失 {len(missing)} 个；磁盘实际合计 {actual / 1048576:.2f} MB")
        if missing:
            for f_ in missing:
                log("  缺失: " + f_)
            return 1
        return 0 if actual <= BUDGET_BYTES else 1

    log("=== 捕梦者官网素材管线 ===")
    log(f"源目录: {SRC_DIR}")
    log(f"工程根: {ROOT}")
    bgs = copy_sources()
    bg_entries, bg_total = build_backgrounds(bgs)
    logo_entry, logo_total = build_logo()
    total = write_manifest(bg_entries, logo_entry, bg_total, logo_total)

    log(f"[4/4] 清单 → {MANIFEST_PATH}")
    log("")
    log(f"背景源图合计   : {sum(e['sourceBytes'] for e in bg_entries) / 1048576:.1f} MB")
    log(f"背景输出合计   : {bg_total / 1048576:.2f} MB  （{len(bg_entries)} 张 × 3 档 + LQIP）")
    log(f"logo 输出合计  : {logo_total / 1024:.1f} KB")
    log(f"站点素材总计   : {total / 1048576:.2f} MB  /  预算 {BUDGET_BYTES / 1048576:.0f} MB"
        f"  →  {'✅ 达标' if total <= BUDGET_BYTES else '❌ 超标'}")

    if args.sheet:
        make_contact_sheet(bgs, args.sheet)

    return 0 if total <= BUDGET_BYTES else 2


if __name__ == "__main__":
    sys.exit(main())
