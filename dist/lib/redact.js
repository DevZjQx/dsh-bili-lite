/**
 * 凭据脱敏 —— 展示与日志的唯一出口。
 *
 * 原则：凭据默认只进不出。确实需要「确认是哪一份」时，只给不可逆指纹
 * （不给明文片段 —— SESSDATA 的末几位仍可能暴露长度 / 过期信息）。
 * 日志 / 错误出口再兜一层 redact：cookie、csrf 值一律打成 ***，
 * 但它是兜底，不代替「根本不打印凭据」。
 */
import crypto from 'node:crypto';
/** 凭据指纹：sha256 前 8 位，只用于区分「是哪一份」，不可反推 */
export function credFingerprint(secret) {
    const v = String(secret ?? '');
    return v ? crypto.createHash('sha256').update(v).digest('hex').slice(0, 8) : '';
}
const COOKIE_KV = /((?:SESSDATA|bili_jct|buvid3|buvid4)\s*=\s*)[^;,\s"']+/gi;
const CSRF_KV = /((?:csrf|bili_jct)["']?\s*[:=]\s*["']?)[0-9a-fA-F]{32}\b/g;
/** 把一段文本里可能夹带的凭据值替换成 ***（日志 / 错误信息统一走这里） */
export function redact(text) {
    return String(text ?? '')
        .replace(COOKIE_KV, '$1***')
        .replace(CSRF_KV, '$1***');
}
