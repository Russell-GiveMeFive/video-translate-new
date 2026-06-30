"""
PyInstaller spec for DramaPrime demucs binary.

用法：
    pyinstaller demucs.spec --noconfirm

输出：
    dist/demucs/                      ← onedir 产物
        demucs (macOS/Linux) or demucs.exe (Windows)
        _internal/
            torch_hub/checkpoints/    ← 预下载的 htdemucs_ft 权重
            ...其他 torch / demucs 运行时

用 --onedir 而不是 --onefile 的原因：
  - onefile 启动时要解压临时目录，每次冷启动 5-10s
  - 译制流水线每次跑都会调用 demucs，启动慢用户感知很差
  - onedir 启动 < 1s，且 Electron asar 打包时可整个 unpack
"""
import os
import sys
from pathlib import Path

# ──────────────────────────────────────────────────────────────────────
# 配置
# ──────────────────────────────────────────────────────────────────────

SCRIPT_DIR = Path(SPECPATH)  # SPECPATH 是 PyInstaller 注入的，等于 spec 文件目录
ENTRY = str(SCRIPT_DIR / 'demucs_entry.py')

# 预下载的 htdemucs_ft 权重位置（运行 build.sh 时会先下好放这里）
PRELOADED_HUB = str(SCRIPT_DIR / 'torch_hub_cache')

# ──────────────────────────────────────────────────────────────────────
# 收集 demucs 模型权重作为 data file
# ──────────────────────────────────────────────────────────────────────

datas = []
if Path(PRELOADED_HUB).exists():
    # 把整个 torch_hub_cache 目录搬到 dist/demucs/_internal/torch_hub/
    for root, dirs, files in os.walk(PRELOADED_HUB):
        for f in files:
            src = os.path.join(root, f)
            rel = os.path.relpath(root, PRELOADED_HUB)
            dst = os.path.join('torch_hub', rel) if rel != '.' else 'torch_hub'
            datas.append((src, dst))
    print(f'[demucs.spec] collected {len(datas)} model files from {PRELOADED_HUB}')
else:
    print(f'[demucs.spec] WARNING: {PRELOADED_HUB} not found—run build.sh first to pre-download models')

# ──────────────────────────────────────────────────────────────────────
# 隐藏依赖（PyInstaller 静态分析抓不到的动态 import）
# ──────────────────────────────────────────────────────────────────────

hiddenimports = [
    # demucs 内部模块
    'demucs.separate',
    'demucs.pretrained',
    'demucs.apply',
    'demucs.htdemucs',
    'demucs.hdemucs',
    'demucs.demucs',
    # 依赖
    'julius',
    'einops',
    'lameenc',
    'diffq',
    'openunmix',
    'dora',
    'dora.hydra',
    'omegaconf',
    'hydra',
    # torchaudio 后端
    'torchaudio.io',
    'torchaudio._backend',
    'torchaudio._backend.soundfile_backend',
    'soundfile',
    # 注：`_soundfile_data` 只有手动装 soundfile-data 包才有，macOS 上 soundfile 自带 libsndfile 二进制
]

# ──────────────────────────────────────────────────────────────────────
# 排除（用不到的，能省 200-500MB）
# ──────────────────────────────────────────────────────────────────────

excludes = [
    # GUI——demucs CLI 不需要
    'matplotlib',
    'tkinter',
    'IPython',
    'jupyter',
    'notebook',
    # ⚠️ 经验：torch 的子模块**全部不能 exclude**——它们之间 import 链非常密
    # 排过 torch.distributed → torch._jit_internal 崩
    # 排过 torch.distributed.rpc → 一样崩
    # 排过 torch.testing → torch.autograd.gradcheck 崩
    # 结论：torch 整个保留，体积换稳定性。瘦身留给 v0.7 ONNX 方案
    #
    # 大依赖但 demucs 不直接用（这些不在 torch 链上，可以排）
    'scipy.signal.signaltools',
    'sklearn',
    'pandas',
]

# ──────────────────────────────────────────────────────────────────────
# Analysis + EXE + COLLECT
# ──────────────────────────────────────────────────────────────────────

block_cipher = None

a = Analysis(
    [ENTRY],
    pathex=[],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=excludes,
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,  # onedir 模式：binaries 在 _internal/
    name='demucs',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,          # UPX 压缩对 torch 的 .so 不友好，关掉
    console=True,
    disable_windowed_traceback=False,
    target_arch=None,   # 让 PyInstaller 跟随当前 Python 架构（arm64/x64）
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='demucs',
)
