import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app } from 'electron'
import { AppError } from '@dramaprime/core-types'
// @ffmpeg-installer/ffmpeg 与 @ffprobe-installer/ffprobe：
// npm install 时自动按平台下载对应静态二进制；提供一个稳定的 path export。
// 用 createRequire 而不是 ESM import，是因为这俩包是纯 CJS、不暴露 ESM entry。
import { createRequire } from 'node:module'
const require_ = createRequire(import.meta.url)

const __dirname = dirname(fileURLToPath(import.meta.url))

let _cachedFfmpeg: string | null | undefined
let _cachedFfprobe: string | null | undefined
let _cachedDemucs: string | null | undefined

const PATH_DIRS_UNIX = [
  '/opt/homebrew/bin', // Apple Silicon brew
  '/usr/local/bin', // Intel mac brew
  '/usr/bin',
  '/bin',
]

/** 候选 demucs Python 模块入口路径（用户机器上 pip install demucs 后常见位置） */
const DEMUCS_PYTHON_HINTS = [
  // macOS: pip install --user 装到这里
  `${process.env.HOME ?? ''}/Library/Python/3.13/bin/demucs`,
  `${process.env.HOME ?? ''}/Library/Python/3.12/bin/demucs`,
  `${process.env.HOME ?? ''}/Library/Python/3.11/bin/demucs`,
  `${process.env.HOME ?? ''}/Library/Python/3.10/bin/demucs`,
  `${process.env.HOME ?? ''}/Library/Python/3.9/bin/demucs`,
  // Linux: pip install --user 装到这里
  `${process.env.HOME ?? ''}/.local/bin/demucs`,
  // pipx 装的位置
  `${process.env.HOME ?? ''}/.local/pipx/venvs/demucs/bin/demucs`,
  // Conda/mamba 环境
  `${process.env.CONDA_PREFIX ?? ''}/bin/demucs`,
]

/**
 * 解析 ffmpeg / ffprobe 二进制位置（按优先级）：
 *   1. **`@ffmpeg-installer/ffmpeg` 提供的随包二进制**（dev + 生产打包都首选）
 *   2. 手动放进 binaries/ffmpeg/<os>-<arch>/ 的二进制（让用户能用自编 ffmpeg 覆盖）
 *   3. 系统 PATH（兜底，但理论上前两路已覆盖所有用户）
 *   4. 找不到 → null（上层 stage 报清晰错）
 */
export const resolveFfmpeg = (): string | null => {
  if (_cachedFfmpeg !== undefined) return _cachedFfmpeg
  _cachedFfmpeg = findBinary('ffmpeg')
  return _cachedFfmpeg
}

export const resolveFfprobe = (): string | null => {
  if (_cachedFfprobe !== undefined) return _cachedFfprobe
  _cachedFfprobe = findBinary('ffprobe')
  return _cachedFfprobe
}

export const requireFfmpeg = (): string => {
  const p = resolveFfmpeg()
  if (!p) {
    throw new AppError({
      code: 'ffmpeg.not-found',
      message:
        '未找到 ffmpeg 可执行文件。这通常意味着 @ffmpeg-installer/ffmpeg 包未正确安装——请运行 `pnpm install` 重新安装依赖。',
      retriable: false,
    })
  }
  return p
}

export const requireFfprobe = (): string => {
  const p = resolveFfprobe()
  if (!p) {
    throw new AppError({
      code: 'ffmpeg.not-found',
      message:
        '未找到 ffprobe 可执行文件。这通常意味着 @ffprobe-installer/ffprobe 包未正确安装——请运行 `pnpm install` 重新安装依赖。',
      retriable: false,
    })
  }
  return p
}

/**
 * 解析 demucs CLI 二进制位置（按优先级）：
 *   1. **系统 PATH / pip-installed demucs**（开发机 + 高阶用户首选）
 *      理由：bundled binary 是 PyInstaller onedir，对 dora/hydra 等动态 import 包不友好——
 *      v0.4 用户已反馈过 `dora/explore.py:27` 间歇崩溃。system demucs 是直接的 Python
 *      runtime，没有打包导致的间接依赖丢失问题。
 *   2. bundled standalone binary（v0.5 PyInstaller 打的，作为"客户机器没 Python"的兜底）
 *   3. 找不到 → null（demix stage 会优雅 skipped 并提示用户怎么装）
 *
 * 应急开关：
 *   - 设 `DRAMAPRIME_DEMUCS_FORCE_BUNDLED=1` 强制只用 bundled（排查打包问题用）
 *   - 设 `DRAMAPRIME_DEMUCS_PATH=/custom/path/demucs` 完全覆盖（指定特定环境的 demucs）
 */
export const resolveDemucs = (): string | null => {
  if (_cachedDemucs !== undefined) return _cachedDemucs
  _cachedDemucs = findDemucs()
  return _cachedDemucs
}

const findDemucs = (): string | null => {
  // 应急开关 0：完全覆盖
  const override = process.env.DRAMAPRIME_DEMUCS_PATH
  if (override && existsSync(override)) return override

  const exe = process.platform === 'win32' ? 'demucs.exe' : 'demucs'
  const forceBundled = process.env.DRAMAPRIME_DEMUCS_FORCE_BUNDLED === '1'

  const findSystem = (): string | null => {
    // pip / conda 显式 hint
    for (const hint of DEMUCS_PYTHON_HINTS) {
      if (hint && existsSync(hint)) return hint
    }
    // brew / 标准 unix 位置
    if (process.platform !== 'win32') {
      for (const d of PATH_DIRS_UNIX) {
        const p = join(d, exe)
        if (existsSync(p)) return p
      }
    }
    // PATH 全扫
    const envPath = process.env.PATH ?? ''
    for (const d of envPath.split(process.platform === 'win32' ? ';' : ':')) {
      if (!d) continue
      const p = join(d, exe)
      if (existsSync(p)) return p
    }
    return null
  }

  const findBundled = (): string | null => {
    const platformArch = `${process.platform}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
    const bundledRoots = [
      // dev：相对 packages 根
      join(__dirname, '../../../../binaries/demucs', platformArch),
      join(process.cwd(), 'binaries/demucs', platformArch),
      // prod：electron-builder extraResources/asarUnpack 落到 resources/binaries/demucs/
      unpackAsarPath(join(app.getAppPath(), '..', 'binaries/demucs', platformArch)),
      process.resourcesPath ? join(process.resourcesPath, 'binaries/demucs', platformArch) : null,
    ].filter(Boolean) as string[]
    for (const root of bundledRoots) {
      const p = join(root, exe)
      if (existsSync(p)) return unpackAsarPath(p)
    }
    return null
  }

  // 优先级反转（v0.4.1 修复 dora/hydra PyInstaller 崩溃）：先 system 后 bundled
  if (forceBundled) return findBundled() ?? findSystem()
  return findSystem() ?? findBundled()
}

/**
 * 把 @ffmpeg-installer 返回的 asar 内路径转成可执行路径：
 *   - dev 模式：路径就在 node_modules/ 里，直接可执行
 *   - 打包后：路径形如 `.../app.asar/node_modules/...`
 *     asar 内文件不能被 child_process spawn 执行（不是真实文件路径）。
 *     electron-builder 配的 `asarUnpack` 会把它们镜像到 `app.asar.unpacked/`，
 *     那是真实路径。这里做一次替换即可。
 */
const unpackAsarPath = (p: string): string => p.replace('app.asar', 'app.asar.unpacked')

const findBinary = (name: 'ffmpeg' | 'ffprobe'): string | null => {
  const exe = process.platform === 'win32' ? `${name}.exe` : name

  // ── 优先级 1: @ffmpeg-installer / @ffprobe-installer 提供的随包二进制 ──
  try {
    const pkg = name === 'ffmpeg' ? '@ffmpeg-installer/ffmpeg' : '@ffprobe-installer/ffprobe'
    const mod = require_(pkg) as { path?: string }
    if (mod?.path) {
      const unpacked = unpackAsarPath(mod.path)
      if (existsSync(unpacked)) return unpacked
      // dev 模式下可能 unpacked 路径不存在但原始 path 存在
      if (existsSync(mod.path)) return mod.path
    }
  } catch {
    // 包未安装或加载失败 → 走下一路径
  }

  // ── 优先级 2: 用户自带 / 手动放置 binaries/ffmpeg/<os-arch>/ ─────────
  const arch = process.platform === 'win32' ? 'x64' : process.arch === 'arm64' ? 'arm64' : 'x64'
  const bundledRoots = [
    // dev：相对 packages 根
    join(__dirname, '../../../../binaries/ffmpeg', `${process.platform}-${arch}`),
    join(process.cwd(), 'binaries/ffmpeg', `${process.platform}-${arch}`),
    // prod：electron-builder extraResources 落到 resources/binaries/ffmpeg/
    join(app.getAppPath(), '..', 'binaries/ffmpeg'),
    process.resourcesPath ? join(process.resourcesPath, 'binaries/ffmpeg') : null,
  ].filter(Boolean) as string[]
  for (const root of bundledRoots) {
    const p = join(root, exe)
    if (existsSync(p)) return p
  }

  // ── 优先级 3: 系统 PATH（兜底；理论上前两路径已覆盖所有用户）──────
  if (process.platform !== 'win32') {
    for (const d of PATH_DIRS_UNIX) {
      const p = join(d, exe)
      if (existsSync(p)) return p
    }
  }
  const envPath = process.env.PATH ?? ''
  for (const d of envPath.split(process.platform === 'win32' ? ';' : ':')) {
    if (!d) continue
    const p = join(d, exe)
    if (existsSync(p)) return p
  }

  return null
}

// ─── spawn helpers ────────────────────────────────────────────────────

export interface SpawnResult {
  code: number
  stdout: string
  stderr: string
}

export interface SpawnOpts {
  signal?: AbortSignal
  /** stderr 行回调，用于解析 ffmpeg 的进度日志 */
  onStderrLine?: (line: string) => void
}

/** 运行命令，收集 stdout/stderr，等待退出 */
export const runCmd = (
  bin: string,
  args: string[],
  opts: SpawnOpts = {},
): Promise<SpawnResult> =>
  new Promise((resolve, reject) => {
    const proc: ChildProcess = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: opts.signal,
    })
    let stdout = ''
    let stderr = ''
    let stderrBuf = ''
    proc.stdout?.setEncoding('utf8')
    proc.stderr?.setEncoding('utf8')
    proc.stdout?.on('data', (d: string) => (stdout += d))
    proc.stderr?.on('data', (d: string) => {
      stderr += d
      if (opts.onStderrLine) {
        stderrBuf += d
        let idx
        while ((idx = stderrBuf.indexOf('\n')) >= 0) {
          const line = stderrBuf.slice(0, idx)
          stderrBuf = stderrBuf.slice(idx + 1)
          opts.onStderrLine(line)
        }
      }
    })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (opts.onStderrLine && stderrBuf) opts.onStderrLine(stderrBuf)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })

/**
 * 解析 ffmpeg stderr 中的 "time=HH:MM:SS.cs" 推断处理进度。
 * 返回毫秒，无法解析返回 null。
 */
export const parseFfmpegTime = (line: string): number | null => {
  const m = line.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/)
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  const s = Number(m[3])
  return Math.round((h * 3600 + min * 60 + s) * 1000)
}
