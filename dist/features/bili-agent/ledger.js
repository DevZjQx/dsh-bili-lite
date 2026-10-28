// ============================================================================
// dsh-bili-lite · 账本 —— 额度 / 判重 / 「看过」的唯一真相（~/.dsh/bili-lite-work/ledger.json）
// comment 与 watch 都记进来；日记里出现过的 BV 号也算「看过」。
// ============================================================================
import fs from 'node:fs';
import { LEDGER_FILE, DIARY_FILE } from '../../config/paths.js';
import { readJson, writeJson } from '../../lib/json-file.js';
export const today = () => new Date().toLocaleDateString('sv-SE');
export function readLedger() { return readJson(LEDGER_FILE, { log: [] }); }
export function ledgerAppend(entry) {
    const led = readLedger();
    led.log.push({ at: new Date().toISOString(), ...entry });
    if (led.log.length > 2000)
        led.log = led.log.slice(-1500);
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
export function seenSet() {
    const seen = new Set();
    const led = readLedger();
    for (const x of led.log)
        if (x.bvid)
            seen.add(x.bvid);
    try {
        for (const bv of fs.readFileSync(DIARY_FILE, 'utf8').matchAll(/\bBV[0-9A-Za-z]{10}\b/g))
            seen.add(bv[0]);
    }
    catch { }
    return seen;
}
