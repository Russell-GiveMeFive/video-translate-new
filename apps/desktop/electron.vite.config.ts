import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { cp } from 'node:fs/promises'

// 把 migrations 目录复制到 out/main 旁边，使运行时 fs.readdir 能找到
const copyMigrations = () => ({
  name: 'copy-migrations',
  async closeBundle() {
    const src = resolve(__dirname, 'src/main/migrations')
    const dst = resolve(__dirname, 'out/main/migrations')
    try {
      await cp(src, dst, { recursive: true })
    } catch {
      // 第一次构建时目录可能不存在；忽略
    }
  },
})

// monorepo workspace 包要被 vite bundle 进 main / preload，而不是 external。
// 否则 Node 运行时会直接 import `.ts` 源文件 → ERR_UNKNOWN_FILE_EXTENSION
const WORKSPACE_PKGS = [
  '@dramaprime/core-types',
  '@dramaprime/pipeline-core',
  '@dramaprime/provider-MiniMax',
  '@dramaprime/provider-volcengine',
  '@dramaprime/align-engine',
  '@dramaprime/subtitle',
]

const externalize = () => externalizeDepsPlugin({ exclude: WORKSPACE_PKGS })

export default defineConfig({
  main: {
    plugins: [externalize(), copyMigrations()],
    build: {
      lib: {
        entry: resolve(__dirname, 'src/main/index.ts'),
      },
      outDir: 'out/main',
      rollupOptions: {
        // 这些包必须保持 external，不被 vite bundle：
        //   - ws: conditional require 'bufferutil' / 'utf-8-validate'（可选 native 加速）
        //   - ffmpeg-installer / ffprobe-installer: 纯 CJS + 路径解析依赖真实文件位置
        external: [
          'ws',
          'bufferutil',
          'utf-8-validate',
          '@ffmpeg-installer/ffmpeg',
          '@ffprobe-installer/ffprobe',
        ],
      },
    },
    resolve: {
      alias: {
        '@main': resolve(__dirname, 'src/main'),
      },
    },
  },
  preload: {
    plugins: [externalize()],
    build: {
      lib: {
        entry: resolve(__dirname, 'src/preload/index.ts'),
        // sandbox: true 的 preload 必须是 CommonJS。这里强制输出 .cjs
        // 否则 Electron 启动会报 "Cannot use import statement outside a module"
        formats: ['cjs'],
        fileName: () => 'index.cjs',
      },
      outDir: 'out/preload',
      rollupOptions: {
        output: { format: 'cjs', entryFileNames: 'index.cjs' },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer/src'),
      },
    },
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html'),
      },
    },
  },
})


