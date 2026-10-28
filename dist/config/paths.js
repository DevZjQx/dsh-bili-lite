/**
 * 磁盘路径 —— 唯一真相（宿主插件、心跳、agent CLI 三方共用同一套解析）。
 * 纯常量：无 IO、无业务。谁要路径都从这里拿，不要自己再拼一遍。
 *
 * 全部落在 WORK_DIR（它的会话工作目录）里：DSH 的 workspace-write 沙箱只允许写
 * 会话 cwd —— 数据跟着会话走，就不需要 additionalWritableRoots，更不需要
 * danger-full-access（旧路径的一次性迁移见 config/migrate.ts）。
 */
import path from 'node:path';
import os from 'node:os';
export const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir() || '.';
export const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh');
/** 它的专用会话工作目录（心跳 / agent 会话都在这里跑）= 沙箱可写根 */
export const WORK_DIR = path.join(DSH_HOME, 'bili-lite-work');
/** 数据根 = 会话工作区：cookie / 账本 / 计划 / 缓存 / 日记 / 人设 / 抽帧图都在这下面 */
export const DATA_DIR = WORK_DIR;
export const CFG_FILE = path.join(WORK_DIR, 'bili-lite.config.json');
export const CRED_FILE = path.join(WORK_DIR, 'credentials.json');
export const LEDGER_FILE = path.join(WORK_DIR, 'ledger.json');
export const SCHEDULE_FILE = path.join(WORK_DIR, 'schedule.json'); // 它自己排的作息/定时任务（lib/schedule 唯一真相）
export const BAN_FILE = path.join(WORK_DIR, 'api-ban.json');
export const CACHE_FILE = path.join(WORK_DIR, 'api-cache.json');
/** 收件箱（谁 @ 了我 / 谁回了我）：已看过的消息 id + 翻页水位 —— 只用于「哪条是新的」 */
export const INBOX_FILE = path.join(WORK_DIR, 'inbox.json');
export const DIARY_FILE = path.join(WORK_DIR, 'diary.md');
export const PERSONA_FILE = path.join(WORK_DIR, 'persona.md');
/** 抽帧九宫格的落点（shots 生成，agent 再拿路径去看图） */
export const SHOTS_DIR = path.join(WORK_DIR, 'shots');
