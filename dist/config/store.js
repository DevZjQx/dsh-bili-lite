/**
 * 配置存取 —— 默认值是唯一真相：宿主、CLI、心跳都从这里 import，不另抄一份。
 * 读写同一份 ~/.dsh/bili-lite.config.json；没有配置文件就用默认值。
 * 键清单（CONFIG_KEYS）= 设置页 POST 的顶层白名单：加字段只改 DEFAULTS。
 */
import fs from 'node:fs';
import path from 'node:path';
import { CFG_FILE } from './paths.js';
export const DEFAULTS = {
    persona: { name: '' },
    self: { mid: '', name: '' },
    pulse: { everyMin: 60 },
    quota: { writeDaily: 3, interactDaily: 10 },
    share: { enabled: true },
    risk: { minGapMs: 1200 },
};
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
/** 设置页 POST 的顶层白名单：只合并认识的键（防止被塞任意字段 ✓；共用账号：没有 owner） */
export const CONFIG_KEYS = Object.keys(DEFAULTS);
const CONFIG_KEY_SET = new Set(CONFIG_KEYS);
/** 默认值打底、用户值覆盖（递归合并：{ pulse: { everyMin: 30 } } 只改这一个键） */
function merge(base, over) {
    if (!isObject(over))
        return over;
    const out = isObject(base) ? { ...base } : {};
    for (const [k, v] of Object.entries(over))
        out[k] = merge(out[k], v);
    return out;
}
export function config() {
    let user = {};
    try {
        user = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
    }
    catch { /* 没配就用默认 */ }
    // 白名单不只管 POST —— 读的时候也只认认识的键（旧文件里已废弃的键，如 night，自动丢弃 ✓）
    const known = {};
    for (const [k, v] of Object.entries(isObject(user) ? user : {}))
        if (CONFIG_KEY_SET.has(k))
            known[k] = v;
    return merge(DEFAULTS, known);
}
export function writeConfig(next) {
    fs.mkdirSync(path.dirname(CFG_FILE), { recursive: true });
    fs.writeFileSync(CFG_FILE, JSON.stringify(next, null, 2) + '\n');
}
