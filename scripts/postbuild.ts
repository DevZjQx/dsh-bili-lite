#!/usr/bin/env bun
/**
 * 构建后处理（唯一一步，构建链的最后）：把浏览器半边还原成「单文件脚本」。
 *
 * 为什么需要：client.ts 是给 DSH web 的 __ModuleLoader__ 当**普通脚本**加载的
 * （它只提供 require("react")，不是 ES 模块）。而 tsc 为了把没有 import/export 的
 * 源文件标成 ESM，会在产物末尾补一行 \`export {};\` —— 这一行在非 module 上下文里是
 * 语法错误。所以构建后只删这一行，别的一律不动（注释、代码顺序全部保留）。
 *
 * 它同时是个哨兵：哪天 client.ts 里不小心写了 import/export，这里会找不到那行而报错。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FILE = path.join(ROOT, 'dist', 'features', 'settings', 'client.js')

const src = fs.readFileSync(FILE, 'utf8')
const out = src.replace(/\nexport \{\};\s*$/, '\n')
if (out === src) {
  console.error('✗ 浏览器半边没有 tsc 补的 export {} —— 检查 client.ts 是否被写成了模块（它必须零 import/export）')
  process.exit(1)
}
// 顶层声明哨兵：DSH 把多个插件的 client.js 拼进同一个 combo 脚本，顶层 const/let/function
// 会和其他插件撞名（"Identifier 'loader' has already been declared"），整个脚本不执行。
const offenders = out
  .split('\n')
  .map((line, i) => ({ line, i: i + 1 }))
  .filter(({ line }) => /^(?:const|let|var|class|function|async\s+function)\b/.test(line))
if (offenders.length > 0) {
  console.error('✗ 浏览器半边有顶层声明（会和别的插件在 combo 脚本里撞名）：')
  for (const { line, i } of offenders) console.error(`  ${FILE}:${i}  ${line}`)
  process.exit(1)
}

fs.writeFileSync(FILE, out)
console.log('✓ dist/features/settings/client.js 已还原为单文件脚本（无 export、无顶层声明）')
