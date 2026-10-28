/**
 * 找一个真能跑脚本的 node（settings feature 私有）。
 * Electron 里 process.execPath 是主程序 ✗ 跑不了脚本 —— 依次试 DSH 自带运行时、
 * PATH、常见安装位置，用「打印 node 版本」验证：Electron 当 app 跑时不会执行
 * -p（只可能是空输出）✗
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'

export function resolveNode() {
  const env = process.env
  const isWin = process.platform === 'win32'
  const bin = isWin ? 'node.exe' : 'node'
  const dshHome = env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const cands = [env.DSH_NODE, env.DSH_DESKTOP_NODE_EXECUTABLE]
  try { for (const d of fs.readdirSync(path.join(dshHome, 'dsh-runtimes'))) cands.push(path.join(dshHome, 'dsh-runtimes', d, 'dependencies', 'node', 'bin', bin)) } catch {}
  for (const dir of String(env.PATH ?? '').split(isWin ? ';' : ':')) if (dir) cands.push(path.join(dir.replace(/^"|"$/g, ''), bin))
  if (!isWin) cands.push('/usr/local/bin/node', '/usr/bin/node', '/opt/homebrew/bin/node')
  if (isWin && env.ProgramFiles) cands.push(path.join(env.ProgramFiles, 'nodejs', bin))
  const probe = (file, env2) => {
    try {
      const r = spawnSync(file, ['-p', 'process.versions.node'], { env: env2, encoding: 'utf8', timeout: 8000, windowsHide: true })
      return r.status === 0 && /^\d+\./.test(String(r.stdout ?? '').trim())
    } catch { return false }
  }
  for (const file of [...new Set(cands.filter(Boolean))]) {
    try { if (fs.statSync(file).isFile() && probe(file, env)) return file } catch {}
  }
  if (process.versions.electron) {
    const e = { ...env, ELECTRON_RUN_AS_NODE: '1' }
    if (probe(process.execPath, e)) return process.execPath
  }
  return null
}
