/**
 * 旧路径一次性迁移 —— 只搬，不双读。
 *
 * 旧：`~/.bili-lite/*` · `~/.dsh/bili-lite.config.json` · `~/.dsh/bili-lite-diary.md`
 * 新：全部在 `~/.dsh/bili-lite-work/`（会话工作目录 = workspace-write 的可写根）
 *
 * 宿主 apply 与 CLI 入口各调一次；幂等：目标已存在就跳过。沙箱里可能删不掉旧文件
 * （工作区外只读），那就留着 —— 新路径不会再读它们。
 */
import fs from 'node:fs'
import path from 'node:path'
import { CFG_FILE, DATA_DIR, DIARY_FILE, DSH_HOME, HOME } from './paths.ts'

const LEGACY_DATA_DIR = path.join(HOME, '.bili-lite')
const LEGACY_CFG = path.join(DSH_HOME, 'bili-lite.config.json')
const LEGACY_DIARY = path.join(DSH_HOME, 'bili-lite-diary.md')

const exists = (p: string): boolean => { try { return fs.existsSync(p) } catch { return false } }
const isDir = (p: string): boolean => { try { return fs.statSync(p).isDirectory() } catch { return false } }

/** 搬一个文件/目录：先 rename（快），跨设备或源在沙箱外时退回复制；两边都是目录就递归合并 */
function move(from: string, to: string): void {
  if (!exists(from)) return
  if (exists(to)) {
    if (!isDir(from) || !isDir(to)) return
    try { for (const name of fs.readdirSync(from)) move(path.join(from, name), path.join(to, name)) } catch { return }
    try { fs.rmdirSync(from) } catch {}
    return
  }
  try { fs.mkdirSync(path.dirname(to), { recursive: true }) } catch {}
  try { fs.renameSync(from, to); return } catch {}
  try { fs.cpSync(from, to, { recursive: true, force: false, errorOnExist: false }) } catch { return }
  try { fs.rmSync(from, { recursive: true, force: true }) } catch {}   // 删不掉（工作区外只读）就留着，不再读
}

let done = false

export function migrateLegacy(): void {
  if (done) return
  done = true
  try { fs.mkdirSync(DATA_DIR, { recursive: true }) } catch {}
  try {
    for (const name of fs.readdirSync(LEGACY_DATA_DIR)) move(path.join(LEGACY_DATA_DIR, name), path.join(DATA_DIR, name))
  } catch {}
  try { fs.rmdirSync(LEGACY_DATA_DIR) } catch {}
  move(LEGACY_CFG, CFG_FILE)
  move(LEGACY_DIARY, DIARY_FILE)
}
