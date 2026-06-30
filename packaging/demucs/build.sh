#!/usr/bin/env bash
# DramaPrime demucs binary 构建脚本（macOS / Linux）
#
# 用法：
#   cd packaging/demucs && ./build.sh
#
# 输出：
#   ../../binaries/demucs/<platform>-<arch>/demucs/   ← onedir 产物
#
# 平台检测：自动识别 darwin-arm64 / darwin-x64 / linux-x64
#
# 流程：
#   1. 创建 venv (隔离 Python 环境)
#   2. 装依赖（CPU-only torch + demucs + pyinstaller）
#   3. 预下载 htdemucs_ft 模型到本地 cache
#   4. 运行 PyInstaller
#   5. 把产物搬到 binaries/demucs/<platform-arch>/

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# ── 检测平台 ────────────────────────────────────────────────────────
OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS" in
  Darwin)
    PLATFORM="darwin"
    case "$ARCH" in
      arm64) PLATFORM_ARCH="darwin-arm64" ;;
      x86_64) PLATFORM_ARCH="darwin-x64" ;;
      *) echo "不支持的 macOS 架构: $ARCH"; exit 1 ;;
    esac
    ;;
  Linux)
    PLATFORM="linux"
    PLATFORM_ARCH="linux-x64"
    ;;
  *)
    echo "不支持的 OS: $OS（请用 build.ps1 for Windows）"
    exit 1
    ;;
esac

echo "[build.sh] 平台: $PLATFORM_ARCH"

# ── Python 3.10-3.11 检查（demucs 4.0.1 对 3.12 兼容性差） ─────────
PYTHON="${PYTHON:-python3}"
PYVER=$("$PYTHON" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
echo "[build.sh] Python: $PYVER ($PYTHON)"
case "$PYVER" in
  3.9|3.10|3.11) ;;
  *)
    echo "[build.sh] WARNING: Python $PYVER 未充分测试，推荐 3.10 或 3.11"
    ;;
esac

# ── 1. venv ─────────────────────────────────────────────────────────
VENV_DIR="$SCRIPT_DIR/venv"
if [ ! -d "$VENV_DIR" ]; then
  echo "[build.sh] 创建 venv at $VENV_DIR"
  "$PYTHON" -m venv "$VENV_DIR"
fi
# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"

# ── 2. 装依赖 ───────────────────────────────────────────────────────
echo "[build.sh] 升级 pip 并安装依赖（首次约 5-10 分钟，~1.5GB 下载）"
pip install --upgrade pip setuptools wheel
pip install -r "$SCRIPT_DIR/requirements.txt"

# ── 3. 预下载 htdemucs_ft 模型 ──────────────────────────────────────
HUB_CACHE="$SCRIPT_DIR/torch_hub_cache"
mkdir -p "$HUB_CACHE/hub/checkpoints"
echo "[build.sh] 预下载 htdemucs_ft 模型到 $HUB_CACHE"
TORCH_HOME="$HUB_CACHE" python -c "
import os
os.environ['CUDA_VISIBLE_DEVICES'] = ''
from demucs.pretrained import get_model
# get_model 会触发 torchhub 下载到 TORCH_HOME/hub/checkpoints/
m = get_model('htdemucs_ft')
print('[build.sh] 模型已下载，包含 sources:', m.sources)
"

# ── 4. PyInstaller ──────────────────────────────────────────────────
echo "[build.sh] PyInstaller 打包（首次约 3-5 分钟）"
cd "$SCRIPT_DIR"
rm -rf build/ dist/
pyinstaller demucs.spec --noconfirm --clean

# ── 5. 搬到 binaries/demucs/<platform-arch>/ ────────────────────────
OUT_DIR="$REPO_ROOT/binaries/demucs/$PLATFORM_ARCH"
echo "[build.sh] 搬运产物到 $OUT_DIR"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
# PyInstaller onedir 产物在 dist/demucs/，整个搬过去
cp -R dist/demucs/. "$OUT_DIR/"

# 验证：跑一下 --help 看能不能起来
echo "[build.sh] 验证可执行性"
"$OUT_DIR/demucs" --help | head -5

# 报告体积
SIZE=$(du -sh "$OUT_DIR" | awk '{print $1}')
echo ""
echo "[build.sh] ✓ 完成"
echo "  输出目录: $OUT_DIR"
echo "  体积: $SIZE"
echo "  入口: $OUT_DIR/demucs"
