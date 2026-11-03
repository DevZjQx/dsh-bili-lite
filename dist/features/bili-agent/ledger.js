// ============================================================================
// dsh-bili-lite · 账本 —— 额度 / 判重 / 「看过」的唯一真相（~/.dsh/bili-lite-work/ledger.json）
// comment 与 watch 都记进来；「看过」只看这份账本，且只留最近 200 条。
// ============================================================================
import { LEDGER_FILE } from '../../config/paths.js';
import { readJson, writeJson } from '../../lib/json-file.js';
export const today = () => new Date().toLocaleDateString('sv-SE');
export function readLedger() { return readJson(LEDGER_FILE, { log: [] }); }
/** 「看过」只留最近 200 条 —— 口味回顾 / 去重只看这么远，更早的交给日记 */
const WATCH_KEEP = 200;
export function ledgerAppend(entry) {
    const led = readLedger();
    led.log.push({ at: new Date().toISOString(), ...entry });
    if (led.log.length > 2000)
        led.log = led.log.slice(-1500);
    // 只裁 watch：comment / interact 要撑住 7 天判重与当日额度，不能被看过的洪流挤掉
    if (entry.type === 'watch') {
        let drop = led.log.filter((x) => x.type === 'watch').length - WATCH_KEEP;
        if (drop > 0) {
            led.log = led.log.filter((x) => {
                if (drop > 0 && x.type === 'watch') {
                    drop--;
                    return false;
                }
                return true;
            });
        }
    }
    writeJson(LEDGER_FILE, led);
}
export function writesToday() {
    return readLedger().log.filter((x) => x.type === 'comment' && new Date(x.at).toLocaleDateString('sv-SE') === today());
}
/** 今天做过的互动（赞 / 关注）—— 取消类不算额度 */
export function interactionsToday() {
    return readLedger().log.filter((x) => x.type === 'interact' && !x.undo
        && new Date(x.at).toLocaleDateString('sv-SE') === today());
}
/** 今天投出去的硬币总共几枚（投币额度按枚算；老记录没有 coins 就当 0） */
export function coinsToday() {
    return interactionsToday().reduce((n, x) => n + (x.action === 'coin' ? Number(x.coins ?? 0) || 0 : 0), 0);
}
/** 同一个目标、同一种互动，days 天内做过没有 —— 看最后一条记录：
 *  最后一次是取消（undo）→ 现在没这个互动，不算；否则按时间判 days 天。
 *  这样「赞 → 取消 → 再赞」不会被 7 天前的旧赞卡死，取消也仍然是纠正、不是在刷。 */
export function interactedWithin(target, action, days = 7) {
    const log = readLedger().log;
    let last = null;
    for (const x of log) {
        if (x.type === 'interact' && x.action === action && x.target === target)
            last = x;
    }
    if (!last || last.undo)
        return false;
    return Date.now() - new Date(last.at).getTime() < days * 86_400_000;
}
export function commentedWithin(bvid, days = 7) {
    return readLedger().log.some((x) => x.type === 'comment' && x.bvid === bvid
        && Date.now() - new Date(x.at).getTime() < days * 86_400_000);
}
/** 同一条评论 7 天内回过没有 —— 回复的判重键是 rpid，不是 BV 号（同一视频下可以分别回不同的人） */
export function repliedWithin(rpid, days = 7) {
    return readLedger().log.some((x) => x.type === 'comment' && String(x.rpid ?? '') === String(rpid)
        && Date.now() - new Date(x.at).getTime() < days * 86_400_000);
}
export function seenSet() {
    const seen = new Set();
    for (const x of readLedger().log)
        if (x.bvid)
            seen.add(x.bvid);
    return seen;
}
