/**
 * JSON 文件小工具：读失败给兜底值，写失败静默 ——
 * 状态类数据不值得让它炸掉主流程（与凭据/配置的「读失败要吵」不同）。
 */
import fs from 'node:fs'
import path from 'node:path'

export const readJson = <T>(f: string, fallback: T): T => {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')) as T } catch { return fallback }
}
export const writeJson = (f: string, v: unknown): void => {
  try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v)) } catch {}
}
