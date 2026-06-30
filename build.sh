#!/usr/bin/env bash
# build.sh — DramaPrime 一键打包（macOS arm64 dmg + Windows x64 exe）
#
# 用途：一次跑出双平台产物。macOS cross-compile Windows 借助 wine 工具链。
#
# 前置依赖（首次运行需装）：
#   brew install --cask wine-stable   # ~200MB
#   brew install mono
#
# 字体 / 图标（已就绪）：
#   build-resources/icon.png  ← 直接给你 PNG
#   build-resources/icon.icns ← 我用 sips + iconutil 拼好的
#
# 用法：
#   ./build.sh             # 一次出 mac dmg + win exe
#   ./build.sh --mac       # 只出 mac
#   ./build.sh --win       # 只出 win
#   ./build.sh --refresh-icons  # 重新生成 icon.icns（如果换了源 PNG）
set -euo pipefail

cd "$(dirname "$0")"
TARGET="all"
REFRESH_ICONS=0
for arg in "$@"; do
  case "$arg" in
    --mac) TARGET="mac" ;;
    --win) TARGET="win" ;;
    --refresh-icons) REFRESH_ICONS=1 ;;
  esac
done

# ─── 0. monorepo 兄弟包 dist 同步到 apps/desktop/node_modules ──
# electron-builder asar 要求所有文件物理上在 apps/desktop/ 内；
# pnpm workspace 符号链接不在 apps/desktop 下，会 build 失败。
# 这个脚本把 packages/*/dist 物理复制到 apps/desktop/node_modules/<pkg>/dist。
echo "📦 同步 monorepo workspace 包到 apps/desktop/node_modules ..."
# ★ v0.4.15 native binding 修复：
# 之前 pnpm install 偶尔会装错架构的 prebuilt binary（Windows x86_64 DLL 被
# 复制到 macOS arm64 项目里），导致 keytar / better-sqlite3 启动时 dlopen 失败
# 整个应用直接 crash。检测 + 修复：
ensure_native_bindings() {
  local NEEDS_REBUILD=0
  local KEYTAR=$(find /Users/minimax/Desktop/Projects/video-translate-new/node_modules/.pnpm/keytar@*/node_modules/keytar/build/Release/keytar.node 2>/dev/null | head -1)
  local SQLITE=$(find /Users/minimax/Desktop/Projects/video-translate-new/node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3/build/Release/better_sqlite3.node 2>/dev/null | head -1)
  if [ -n "$KEYTAR" ] && ! file "$KEYTAR" | grep -q "Mach-O.*arm64"; then
    echo "   ⚠️  keytar binary is not arm64 Mach-O, will reinstall"
    rm -rf /Users/minimax/Desktop/Projects/video-translate-new/node_modules/.pnpm/keytar@*
    NEEDS_REBUILD=1
  fi
  if [ -n "$SQLITE" ] && ! file "$SQLITE" | grep -q "Mach-O.*arm64"; then
    echo "   ⚠️  better-sqlite3 binary is not arm64 Mach-O, will reinstall"
    rm -rf /Users/minimax/Desktop/Projects/video-translate-new/node_modules/.pnpm/better-sqlite3@*
    NEEDS_REBUILD=1
  fi
  if [ "$NEEDS_REBUILD" = "1" ]; then
    echo "   重新装 native dependencies..."
    cd /Users/minimax/Desktop/Projects/video-translate-new
    pnpm install 2>&1 | tail -3
  fi
  # 用 electron-rebuild 确保 native binding 跟当前 Electron 30+ ABI 完全匹配
  pnpm --filter @dramaprime/desktop exec electron-rebuild 2>&1 | tail -2
}
ensure_native_bindings
node scripts/sync-workspace-dist.mjs

# ─── 1. 重新生成图标（可选）────────────────────────────────────
if [ "$REFRESH_ICONS" -eq 1 ] || [ ! -f build-resources/icon.icns ] || [ ! -f build-resources/icon.png ]; then
  echo "🎨 从 PNG 重新生成 mac/win 图标..."
  if [ ! -f build-resources/icon.png ]; then
    echo "❌ build-resources/icon.png 不存在。把你设计好的 logo PNG 放到 build-resources/icon.png"
    echo "   建议尺寸：≥512×512 PNG（透明背景最佳）"
    exit 1
  fi
  mkdir -p build-resources/icons
  rm -rf build-resources/icon.iconset
  mkdir -p build-resources/icon.iconset
  # macOS sips 把 PNG 重采样到多尺寸
  for size in 16 32 64 128 256 512 1024; do
    sips -z $size $size build-resources/icon.png --out build-resources/icons/${size}.png 2>/dev/null
  done
  # iconutil 拼装 .icns
  cp build-resources/icons/16.png   build-resources/icon.iconset/icon_16x16.png
  cp build-resources/icons/32.png   build-resources/icon.iconset/icon_16x16@2x.png
  cp build-resources/icons/32.png   build-resources/icon.iconset/icon_32x32.png
  cp build-resources/icons/64.png   build-resources/icon.iconset/icon_32x32@2x.png
  cp build-resources/icons/128.png  build-resources/icon.iconset/icon_128x128.png
  cp build-resources/icons/256.png  build-resources/icon.iconset/icon_128x128@2x.png
  cp build-resources/icons/256.png  build-resources/icon.iconset/icon_256x256.png
  cp build-resources/icons/512.png  build-resources/icon.iconset/icon_256x256@2x.png
  cp build-resources/icons/512.png  build-resources/icon.iconset/icon_512x512.png
  cp build-resources/icons/1024.png build-resources/icon.iconset/icon_512x512@2x.png
  iconutil -c icns build-resources/icon.iconset -o build-resources/icon.icns
  cp build-resources/icons/256.png build-resources/icon.png
  echo "✅ 图标生成完成"
fi

# ─── 1.5. 复制图标到 electron-builder 期望的路径 ──────────────
# electron-builder 默认从 apps/desktop/build/ 找图标（不是项目根的 build-resources/）
# 之前 dmg 用的是默认 Electron 图标就是这个原因
copy_icons_for_electron_builder() {
  mkdir -p apps/desktop/build
  # ★ v0.4.13 防御：先确保 256x256（IDE watch 偶尔会改 icon.png）
  # electron-builder 严格要 ≥ 256x256
  cp build-resources/icons/256.png apps/desktop/build/icon.png
  # iconutil 已经拼好的 .icns 直接拷
  cp build-resources/icon.icns apps/desktop/build/icon.icns
  echo "   图标已同步到 apps/desktop/build/（256x256 保证）"
}

# ─── 2. macOS arm64 dmg（Apple Silicon）────────────────────────
build_mac() {
  echo ""
  echo "📦 构建 macOS arm64 dmg..."
  if [ -n "${CSC_LINK:-}" ]; then
    echo "   检测到 CSC_LINK，使用签名"
  else
    echo "   ⚠️  未配置 CSC_LINK，输出未签名 dmg（首次打开会有'未识别开发者'警告 → 右键打开即可）"
  fi
  copy_icons_for_electron_builder
  pnpm dist:mac
  echo "✅ macOS dmg 产物：apps/desktop/release/DramaPrime-*-arm64.dmg"
}

# ─── 3. Windows x64 exe（macOS 上 cross-compile 借助 wine）────────
build_win() {
  echo ""
  echo "📦 构建 Windows x64 exe（macOS cross-compile via wine）..."
  # v0.4.13 wine 路径探测：macOS brew install --cask wine-stable 后
  # wine binary 在 /Applications/Wine Stable.app/Contents/MacOS/wine
  # 默认不在 PATH，要 symlink 到 /opt/homebrew/bin/wine 或直接探测
  local WINE_BIN=""
  for cand in \
    "/opt/homebrew/bin/wine" \
    "/Applications/Wine Stable.app/Contents/MacOS/wine" \
    "/usr/local/bin/wine" \
    "/opt/local/bin/wine"; do
    if [ -x "$cand" ]; then
      WINE_BIN="$cand"
      break
    fi
  done
  if [ -z "$WINE_BIN" ] && command -v wine >/dev/null; then
    WINE_BIN="$(command -v wine)"
  fi
  if [ -z "$WINE_BIN" ]; then
    echo "❌ wine 未安装。运行：brew install --cask wine-stable"
    echo "   首次启动会下载 ~200MB 依赖，请耐心等"
    exit 1
  fi
  echo "   wine: $WINE_BIN"
  # 把 wine 所在目录加到 PATH，让 electron-builder 内部能找到
  export PATH="$(dirname "$WINE_BIN"):$PATH"
  if [ -n "${CSC_LINK:-}" ]; then
    echo "   检测到 CSC_LINK，使用签名"
  else
    echo "   ⚠️  未配置 CSC_LINK，输出未签名 exe（Windows 启动会有 SmartScreen 警告）"
  fi
  copy_icons_for_electron_builder
  pnpm dist:win
  echo "✅ Windows exe 产物：apps/desktop/release/DramaPrime-*-x64-Setup.exe"
  echo "                apps/desktop/release/DramaPrime-*-x64-portable.exe"
}

case "$TARGET" in
  all)
    build_mac
    build_win
    ;;
  mac) build_mac ;;
  win) build_win ;;
esac

echo ""
echo "🎉 全部完成！"
echo ""
echo "产物清单："
ls -lh apps/desktop/release/ 2>/dev/null | grep -E "\.(dmg|exe)$" || echo "  （未找到产物，检查上面的报错）"
echo ""
echo "📝 用户首次运行需在 Settings 填："
echo "  - MiniMax API key (https://platform.minimaxi.com)"
echo "  - 火山 ASR app_id + access_token (https://www.volcengine.com)"
echo ""
echo "📝 日志位置："
echo "  - macOS:   ~/Library/Logs/DramaPrime/"
echo "  - Windows: %APPDATA%\\DramaPrime\\logs\\"