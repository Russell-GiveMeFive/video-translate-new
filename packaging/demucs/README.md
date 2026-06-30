# DramaPrime — Demucs Binary Packaging

把 demucs CLI + CPU-only PyTorch + htdemucs_ft 模型权重打成 standalone binary，
让最终用户**不用预装 Python / pip / demucs** 即可用 demix 功能。

## 为什么打包

| 不打包 | 打包后 |
|--------|--------|
| 用户要 `pip install demucs`，新手卡死 | 装好 app 即用 |
| Python / 依赖冲突可能性 | 与系统 Python 完全隔离 |
| 安装路径不固定，定位麻烦 | 已知路径 `binaries/demucs/<platform>/demucs` |
| 占系统 `~/.cache/torch/` 几百 MB | 模型权重也打进 binary |

## 体积参考

| 平台 | onedir 总体积 | binary 入口 | 模型 |
|------|---------------|-----------|------|
| darwin-arm64 | ~350 MB | `demucs` (~10MB) | htdemucs_ft (~80MB in `_internal/torch_hub/`) |
| darwin-x64 | ~380 MB | `demucs` | 同上 |
| win32-x64 | ~420 MB | `demucs.exe` | 同上 |

注：Windows 体积略大是因为 MSVC runtime DLL；最终 dmg / nsis 安装包用 LZMA 压缩可瘦到 ~40-60%。
平台目录命名与 electron-builder 的 `${os}-${arch}` 占位符对齐（darwin / win32）。

## 目录结构

```
packaging/demucs/
├── README.md           # 你正在看
├── requirements.txt    # 锁定 torch-cpu / demucs / pyinstaller 版本
├── demucs_entry.py     # PyInstaller 入口（封装 demucs.separate.main）
├── demucs.spec         # PyInstaller spec 配置
├── build.sh            # macOS / Linux 构建脚本
├── build.ps1           # Windows 构建脚本
├── torch_hub_cache/    # 预下载的模型权重（构建时填充，提交忽略）
├── venv/               # Python 隔离环境（忽略）
├── build/              # PyInstaller 临时（忽略）
└── dist/               # PyInstaller 产物（忽略）
```

## 构建（本地）

### macOS Apple Silicon (arm64)

```bash
cd packaging/demucs
./build.sh
# 产物：binaries/demucs/darwin-arm64/demucs/
```

### macOS Intel (x64)

```bash
# 必须在 Intel Mac 或 Rosetta Python 下跑
arch -x86_64 ./build.sh
```

### Linux x64

```bash
cd packaging/demucs
./build.sh
# 产物：binaries/demucs/linux-x64/demucs/
```

### Windows x64

```powershell
# PowerShell（管理员可选）
cd packaging\demucs
.\build.ps1
# 产物：binaries\demucs\win32-x64\demucs\demucs.exe
```

## 构建时间预算

| 步骤 | 时间 |
|------|------|
| 创建 venv + pip install | 5-10 min（首次） / < 30s（后续） |
| 下载 htdemucs_ft 模型 | 1-2 min（80MB） |
| PyInstaller 打包 | 3-5 min |
| **首次总耗时** | **~15 分钟** |
| 后续 incremental | ~5 分钟 |

## 与 Electron 集成

`apps/desktop/src/main/ffmpeg/index.ts` 的 `resolveDemucs()` 按以下优先级查找：

1. **打包内的 binary**：`binaries/demucs/<platform-arch>/demucs[.exe]`（最高优先级）
2. 系统 PATH（用户自己 `pip install demucs`）
3. macOS 常见位置（`~/Library/Python/3.x/bin/demucs`）

electron-builder 的 `asarUnpack` 配置确保 `binaries/demucs/` 整个目录在打包后仍可 spawn。

## CI/CD

GitHub Actions workflow 在 `.github/workflows/build-demucs.yml`：

- **触发**：push tag `v*` 或手动 `workflow_dispatch`
- **3 个 job 并行**：
  - `macos-14`（Apple Silicon arm64）
  - `macos-13`（Intel x64）
  - `windows-latest`（x64）
- **产物**：每个 job 上传 `demucs-<platform-arch>.tar.gz` 到 workflow artifact + 自动 attach 到 GitHub Release

## 故障排查

### `ModuleNotFoundError: No module named 'XXX'`（运行时）

某个隐藏依赖没被 PyInstaller 抓到。在 `demucs.spec` 的 `hiddenimports` 加上：
```python
hiddenimports = [..., 'XXX']
```

### `Symbol not found: _PyXXX` (macOS)

Python 版本与构建时不一致。最好用 `python3.11` 明确指定：
```bash
PYTHON=python3.11 ./build.sh
```

### 体积过大（> 600MB）

通常是 CUDA torch 没排除。验证：
```bash
du -sh dist/demucs/_internal/torch/lib/
```
应该 < 200MB（CPU-only）。如超 1GB，检查 requirements.txt 是不是用了 `--index-url https://download.pytorch.org/whl/cpu`。

### Windows: `cannot find vcruntime140.dll`

PyInstaller 应该自动带，如果没——装 [Microsoft Visual C++ Redistributable](https://aka.ms/vs/17/release/vc_redist.x64.exe) 或者重新 PyInstaller。

### 模型权重没打进 binary

检查构建时 `[demucs.spec] collected N model files` 是否 > 0。
N=0 说明 `torch_hub_cache/` 是空的——重新跑 build 脚本，那个 Python 下载步骤可能失败了。

## 维护

- **更新 demucs 版本**：改 `requirements.txt` 里 `demucs==X.Y.Z`
- **更新模型**：在 `demucs.spec` 里改预下载逻辑（目前固定 htdemucs_ft）
- **更新 PyInstaller**：留意是否兼容当前 Python 版本

---

**文档版本**：v0.6 / 2026-06-08
