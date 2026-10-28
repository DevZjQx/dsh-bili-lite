#!/usr/bin/env node
// ============================================================================
// 结构检查 —— 让防弹边界失败（SKILL §8 的无依赖实现）
//
// 层级与方向：shared(config,lib) → features → app，方向不可逆。
//   1. 无 barrel：src 下不允许任何 index.*（模块之下唯一入口原则）
//   2. src 顶层只允许 app / config / lib / features
//   3. 共享层（config、lib）不得 import features 或 app
//   4. feature 不得 import app
//   5. 跨 feature 只能 import 对方入口：feature.(m)js，或带 shebang 的根级 .mjs
//      （CLI 框架约定，如 bili-agent/bili.mjs）
//   6. 浏览器半边（features/<x>/client.js）：单文件加载契约，不允许任何静态 import
//   7. 每个 feature 必须有入口；全部源文件过 node --check
//
// 说明：import 识别用正则而非 AST —— 够用且零依赖；别在注释里写长得像
// `from '…'` 的句子。
// ============================================================================
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(ROOT, 'src')

const IMPORT_RES = [
  /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?[\w$*{},\s]+?\s*from\s*['"]([^'"]+)['"]/g,
  /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
  /import\(\s*['"]([^'"]+)['"]\s*\)/g,
]

const rel = (f) => path.relative(ROOT, f)
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
  const p = path.join(dir, d.name)
  return d.isDirectory() ? walk(p) : (/\.(js|mjs)$/.test(d.name) ? [p] : [])
})
const kindOf = (f) => {
  const [l1, l2] = path.relative(SRC, f).split(path.sep)
  if (l1 === 'app') return { layer: 'app', feature: null }
  if (l1 === 'features') return { layer: 'feature', feature: l2 }
  if (l1 === 'config' || l1 === 'lib') return { layer: 'shared', feature: null }
  return { layer: 'unknown', feature: null }
}
const resolveLocal = (from, spec) => {
  const base = path.resolve(path.dirname(from), spec)
  for (const c of [base, base + '.js', base + '.mjs']) {
    if (existsSync(c) && statSync(c).isFile()) return c
  }
  return null
}

const files = walk(SRC)
const errors = []

// 1) 无 barrel 2) 顶层白名单
for (const f of files) {
  if (/index\.(js|mjs)$/.test(f)) errors.push(`${rel(f)}: 不允许 index barrel（每个模块只有一个入口）`)
  if (kindOf(f).layer === 'unknown') errors.push(`${rel(f)}: src 顶层只允许 app / config / lib / features`)
}

for (const f of files) {
  const src = readFileSync(f, 'utf8')
  const { layer, feature } = kindOf(f)
  const isBrowserEntry = layer === 'feature'
    && path.basename(f) === 'client.js'
    && path.dirname(f) === path.join(SRC, 'features', feature)

  // 6) 浏览器半边：零静态 import（require("react") 由加载器提供，不在此限）
  if (isBrowserEntry) {
    for (const re of IMPORT_RES) {
      re.lastIndex = 0
      if (re.test(src)) errors.push(`${rel(f)}: 浏览器半边单文件加载，不允许静态 import（SKILL §10 例外见文件头）`)
    }
    continue
  }

  for (const re of IMPORT_RES) {
    re.lastIndex = 0
    for (const m of src.matchAll(re)) {
      const spec = m[1]
      if (!spec.startsWith('.') && !spec.startsWith('/')) continue   // node: 内建 / 外部包
      const target = resolveLocal(f, spec)
      if (!target) { errors.push(`${rel(f)}: 解析不到 ${spec}`); continue }
      if (!target.startsWith(SRC + path.sep)) continue
      const t = kindOf(target)
      const tRel = path.relative(SRC, target)
      // 3) 共享层不得 import features / app
      if (layer === 'shared' && (t.layer === 'feature' || t.layer === 'app')) {
        errors.push(`${rel(f)}: 共享层不得 import ${tRel}（方向 shared → features → app）`)
      }
      // 4) feature 不得 import app
      if (layer === 'feature' && t.layer === 'app') {
        errors.push(`${rel(f)}: feature 不得 import app（${tRel}）—— 组合发生在 app`)
      }
      // 5) 跨 feature 只能走入口
      if (layer === 'feature' && t.layer === 'feature' && t.feature !== feature) {
        const isEntry = /(^|\/)feature\.(js|mjs)$/.test(tRel) || path.basename(target) === 'bili.mjs'
        if (!isEntry) errors.push(`${rel(f)}: 跨 feature 深层 import（${tRel}）—— 只能走对方入口`)
      }
    }
  }
}

// 7a) 语法检查（全部文件，含浏览器半边）
for (const f of files) {
  const chk = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' })
  if (chk.status !== 0) errors.push(`${rel(f)}: 语法错误\n${chk.stderr}`)
}

// 7b) 每个 feature 必须有入口
const featuresDir = path.join(SRC, 'features')
for (const d of readdirSync(featuresDir, { withFileTypes: true }).filter((x) => x.isDirectory())) {
  const dir = path.join(featuresDir, d.name)
  const names = readdirSync(dir)
  const hasEntry = names.some((n) => /^feature\.(js|mjs)$/.test(n))
    || names.some((n) => n.endsWith('.mjs') && readFileSync(path.join(dir, n), 'utf8').startsWith('#!'))
  if (!hasEntry) errors.push(`src/features/${d.name}: 缺公共入口（feature.(m)js，或带 shebang 的根级 .mjs）`)
}

if (errors.length) {
  console.error(`✗ 结构检查 ${errors.length} 处：\n\n${errors.map((e) => '  · ' + e).join('\n')}\n`)
  process.exit(1)
}
console.log(`✓ 结构检查通过（${files.length} 个源文件：shared → features → app 方向不可逆 · 无 barrel · 浏览器半边零 import · 语法全过）`)
