# DramaPrime demucs binary 构建脚本（Windows）
#
# 用法 (PowerShell):
#   cd packaging/demucs
#   .\build.ps1
#
# 输出：
#   ..\..\binaries\demucs\windows-x64\demucs\demucs.exe
#
# 前置：
#   - Python 3.10 or 3.11 在 PATH
#   - Visual C++ Build Tools (PyInstaller 需要)

$ErrorActionPreference = "Stop"

$ScriptDir = $PSScriptRoot
$RepoRoot = (Resolve-Path "$ScriptDir\..\..").Path
# 与 electron-builder ${os}-${arch} 对齐：Windows 用 win32-x64 而非 windows-x64
$PlatformArch = "win32-x64"

Write-Host "[build.ps1] 平台: $PlatformArch"

# ── Python 检查 ────────────────────────────────────────────────────
$Python = if ($env:PYTHON) { $env:PYTHON } else { "python" }
$PyVer = & $Python -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"
Write-Host "[build.ps1] Python: $PyVer ($Python)"
if ($PyVer -notin "3.9","3.10","3.11") {
  Write-Warning "[build.ps1] Python $PyVer 未充分测试，推荐 3.10 或 3.11"
}

# ── 1. venv ────────────────────────────────────────────────────────
$VenvDir = "$ScriptDir\venv"
if (-not (Test-Path $VenvDir)) {
  Write-Host "[build.ps1] 创建 venv at $VenvDir"
  & $Python -m venv $VenvDir
}
$VenvActivate = "$VenvDir\Scripts\Activate.ps1"
. $VenvActivate

# ── 2. 装依赖 ──────────────────────────────────────────────────────
Write-Host "[build.ps1] 升级 pip 并安装依赖（首次约 5-10 分钟，~1.5GB）"
pip install --upgrade pip setuptools wheel
pip install -r "$ScriptDir\requirements.txt"

# ── 3. 预下载模型 ──────────────────────────────────────────────────
$HubCache = "$ScriptDir\torch_hub_cache"
New-Item -ItemType Directory -Force -Path "$HubCache\hub\checkpoints" | Out-Null
Write-Host "[build.ps1] 预下载 htdemucs_ft 模型到 $HubCache"
$env:TORCH_HOME = $HubCache
$env:CUDA_VISIBLE_DEVICES = ""
python -c "from demucs.pretrained import get_model; m = get_model('htdemucs_ft'); print('[build.ps1] 模型已下载:', m.sources)"

# ── 4. PyInstaller ─────────────────────────────────────────────────
Write-Host "[build.ps1] PyInstaller 打包（首次约 3-5 分钟）"
Push-Location $ScriptDir
Remove-Item -Recurse -Force build, dist -ErrorAction SilentlyContinue
pyinstaller demucs.spec --noconfirm --clean
Pop-Location

# ── 5. 搬产物 ──────────────────────────────────────────────────────
$OutDir = "$RepoRoot\binaries\demucs\$PlatformArch"
Write-Host "[build.ps1] 搬运产物到 $OutDir"
Remove-Item -Recurse -Force $OutDir -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Copy-Item -Recurse "$ScriptDir\dist\demucs\*" $OutDir

# 验证
Write-Host "[build.ps1] 验证可执行性"
& "$OutDir\demucs.exe" --help | Select-Object -First 5

# 报告体积
$Size = "{0:N1} MB" -f ((Get-ChildItem $OutDir -Recurse | Measure-Object Length -Sum).Sum / 1MB)
Write-Host ""
Write-Host "[build.ps1] ✓ 完成"
Write-Host "  输出目录: $OutDir"
Write-Host "  体积: $Size"
Write-Host "  入口: $OutDir\demucs.exe"
