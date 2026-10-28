/**
 * 磁盘路径 —— 唯一真相（宿主插件、心跳、agent CLI 三方共用同一套解析）。
 * 纯常量：无 IO、无业务。谁要路径都从这里拿，不要自己再拼一遍。
 */
import path from 'node:path'
import os from 'node:os'

export const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir() || '.'
export const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh')
export const DATA_DIR = path.join(HOME, '.bili-lite')
export const CFG_FILE = path.join(DSH_HOME, 'bili-lite.config.json')
export const CRED_FILE = path.join(DATA_DIR, 'credentials.json')
export const LEDGER_FILE = path.join(DATA_DIR, 'ledger.json')
export const SCHEDULE_FILE = path.join(DATA_DIR, 'schedule.json')   // 它自己排的作息/定时任务（lib/schedule 唯一真相）
export const BAN_FILE = path.join(DATA_DIR, 'api-ban.json')
export const CACHE_FILE = path.join(DATA_DIR, 'api-cache.json')
export const DIARY_FILE = path.join(DSH_HOME, 'bili-lite-diary.md')
export const PERSONA_FILE = path.join(DATA_DIR, 'persona.md')
/** 抽帧九宫格的落点（shots 生成，agent 再拿路径去看图） */
export const SHOTS_DIR = path.join(DATA_DIR, 'shots')
/** 它的专用会话工作目录（心跳 / agent 会话都在这里跑） */
export const WORK_DIR = path.join(DSH_HOME, 'bili-lite-work')
