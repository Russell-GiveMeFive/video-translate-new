#!/usr/bin/env node
/**
 * sync-workspace-dist.mjs — v0.4.13 monorepo asar path fix
 *
 * electron-builder asar requires all files physically under apps/desktop/.
 * pnpm workspace symlinks (apps/desktop/node_modules/@dramaprime/xx -> ../../packages/xx)
 * make asar reject files outside the symlink target.
 *
 * This script:
 *   1. Compiles each packages/xx via tsc (if dist/ missing)
 *   2. Replaces symlinks in apps/desktop/node_modules/ with real dirs
 *   3. Copies src/ + dist/ + package.json into the real dir
 *
 * After running this, electron-builder finds files at legal paths.
 */
import { cp, mkdir, readdir, lstat, symlink, unlink, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const APPS_DESKTOP = join(ROOT, 'apps', 'desktop')
const PACKAGES = join(ROOT, 'packages')

const loadPkg = async (pkgDir) => {
  const url = new URL('file://' + join(pkgDir, 'package.json'))
  return (await import(url.href, { with: { type: 'json' } })).default
}

const fsAccess = async (path) => {
  try {
    await (await import('node:fs/promises')).access(path)
    return true
  } catch {
    return false
  }
}

const waitForDist = async (dist, maxMs = 3000) => {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    if (await fsAccess(dist)) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

const buildPackage = async (pkgDir) => {
  const name = pkgDir.split('/').pop()
  console.log(`  🔨 ${name}: tsc -p tsconfig.json`)
  await new Promise((resolve, reject) => {
    const proc = spawn('npx', ['tsc', '-p', 'tsconfig.json'], {
      cwd: pkgDir,
      stdio: 'inherit',
    })
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tsc exit ${code}`))))
  })
  // Wait for the file system to actually see dist/ (Node.js stat cache vs spawned process)
  const dist = join(pkgDir, 'dist')
  const ok = await waitForDist(dist)
  if (!ok) {
    throw new Error(`tsc success but dist/ still missing after 3s at ${dist}`)
  }
}

const syncOne = async (pkgName, pkgDir) => {
  // v0.4.14 强制每次重 build（即使 dist 已存在）— 让 tsconfig 变更（declaration 等）生效
  await buildPackage(pkgDir)
  const dist = join(pkgDir, 'dist')
  if (!(await fsAccess(dist))) {
    console.error(`  ❌ ${pkgName}: dist/ missing after tsc`)
    return false
  }

  const linkPath = join(APPS_DESKTOP, 'node_modules', pkgName)
  if (!existsSync(linkPath)) {
    console.warn(`  ⚠️  ${pkgName}: not in apps/desktop/node_modules, skipping`)
    return false
  }

  // Always: re-establish linkPath as a real dir (not symlink)
  // Use lstat (NOT stat) so symlinks are detected, not followed
  let isLink = false
  let isDir = false
  try {
    const lst = await lstat(linkPath)
    isLink = lst.isSymbolicLink()
    isDir = lst.isDirectory()
  } catch (e) {
    // doesn't exist yet
  }
  if (isLink) {
    await unlink(linkPath)
    await mkdir(linkPath, { recursive: true })
    console.log(`     replaced symlink -> real dir`)
  } else if (!isDir) {
    await unlink(linkPath)
    await mkdir(linkPath, { recursive: true })
    console.log(`     replaced file -> real dir`)
  } else {
    console.log(`     linkPath already real dir`)
  }

  // Refresh dist/ inside
  // Use shell cp (not Node.js fs.cp) to avoid Node 22's stat cache race
  const realDist = join(linkPath, 'dist')
  if (await fsAccess(realDist)) {
    await rm(realDist, { recursive: true, force: true })
  }
  await new Promise((resolve, reject) => {
    const cp = spawn('cp', ['-R', dist + '/.', realDist + '/'], { stdio: 'inherit' })
    cp.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`cp exit ${code}`))))
  })
  // Always refresh package.json (rewrite main/types/exports to point to dist/ — vite/esbuild need .js)
  const srcPkg = await loadPkg(pkgDir)
  const patchedPkg = {
    ...srcPkg,
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: { '.': './dist/index.js' },
  }
  const { writeFile } = await import('node:fs/promises')
  await writeFile(
    join(linkPath, 'package.json'),
    JSON.stringify(patchedPkg, null, 2) + '\n',
  )
  console.log(`  ✅ ${pkgName}: real dir + dist + patched package.json (main→./dist/index.js)`)
  return true
}

const main = async () => {
  const pkgDirs = (await readdir(PACKAGES, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => join(PACKAGES, d.name))

  let ok = 0
  for (const pkgDir of pkgDirs) {
    const pkg = await loadPkg(pkgDir)
    const okOne = await syncOne(pkg.name, pkgDir)
    if (okOne) ok++
  }
  console.log(`\nsync-workspace-dist: ${ok}/${pkgDirs.length} packages synced`)
}

main().catch((err) => {
  console.error('sync-workspace-dist failed:', err)
  process.exit(1)
})