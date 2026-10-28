/**
 * 凭据的宿主侧读写（settings feature 私有）：
 *   · parseCookie —— 粘贴容错：整段 cookie 头 / 裸值都收；格式不对直接拒（不拿 undefined 去发请求）
 *   · credState —— 只回「能不能用」，不回显任何凭据内容
 */
import fs from 'node:fs';
import { CRED_FILE } from '../../config/paths.js';
/** 只回「能不能用」，不回显任何凭据内容 */
export function credState() {
    try {
        const c = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'));
        return { present: true, hasSess: !!c.sessdata, hasJct: !!c.bili_jct, hasBuvid: !!c.buvid3 };
    }
    catch {
        return { present: false, hasSess: false, hasJct: false, hasBuvid: false };
    }
}
export function parseCookie(input = {}) {
    const pick = (raw, key) => {
        const value = String(raw ?? '').trim();
        const m = value.match(new RegExp('(?:^|;)\\s*' + key + '=([^;]+)', 'i'));
        return (m ? m[1] : value.replace(new RegExp('^' + key + '\\s*=', 'i'), ''))
            .replace(/^["'\s]+|["';\s]+$/g, '').trim();
    };
    const cred = {
        sessdata: pick(input.sessdata, 'SESSDATA'),
        bili_jct: pick(input.bili_jct, 'bili_jct'),
        buvid3: pick(input.buvid3, 'buvid3'),
    };
    if (cred.sessdata.length < 20 || cred.sessdata.length > 8192
        || !/^[0-9a-fA-F]{32}$/.test(cred.bili_jct)
        || Object.values(cred).some((v) => /[\r\n;\x00-\x1f\x7f]/.test(v) || v.length > 8192)) {
        throw new Error('凭据不完整或格式无效：需要 SESSDATA（HttpOnly，必须 F12 → Application → Cookies 手动复制 ✗）+ bili_jct（32 位十六进制）');
    }
    return cred;
}
