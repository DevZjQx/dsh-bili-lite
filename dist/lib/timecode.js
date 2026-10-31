/**
 * 时间码 —— 抽帧参数解析与图上标注的唯一写法。
 *
 * 为什么单独一个文件：CLI 的 --at / --range / --crop 与工具的 at / range / crop
 * 必须按同一套规则认（"90" / "1:30" / "1:02:03" 都是秒），否则两条入口会在
 * 边界上分叉。纯函数：不读 argv、不打印、不退出。
 */
/** "90" / "1:30" / "1:02:03" → 秒；认不出返回 null（不静默当 0） */
export function parseClock(input) {
    const s = String(input ?? '').trim();
    if (!s)
        return null;
    const parts = s.split(':');
    if (parts.length > 3)
        return null;
    const nums = parts.map((x) => { const t = x.trim(); return t === '' ? NaN : Number(t); });
    if (nums.some((n) => !Number.isFinite(n) || n < 0))
        return null;
    // 分、秒的位必须 < 60；最前面那一段可以是分钟或小时（"90:00" 允许）
    if (nums.length > 1 && nums.slice(1).some((n) => n >= 60))
        return null;
    return nums.reduce((a, b) => a * 60 + b, 0);
}
/** "00:12, 01:30, 95" → 秒数组；有任何一个认不出就整体返回 null */
export function parseClockList(input) {
    const parts = String(input ?? '').split(/[,，、;；\s]+/).filter(Boolean);
    if (!parts.length)
        return null;
    const out = [];
    for (const p of parts) {
        const n = parseClock(p);
        if (n === null)
            return null;
        out.push(n);
    }
    return out;
}
/** "02:10-02:35" / "130-155" → { fromSec, toSec }；结束必须晚于开始 */
export function parseClockRange(input) {
    const m = /^([^-]+)-(.+)$/.exec(String(input ?? '').trim());
    if (!m)
        return null;
    const fromSec = parseClock(m[1]);
    const toSec = parseClock(m[2]);
    if (fromSec === null || toSec === null || toSec <= fromSec)
        return null;
    return { fromSec, toSec };
}
/** 裁剪：相对坐标 x,y,w,h（0–1），如 "0.1,0.1,0.6,0.6"；越界就整体返回 null */
export function parseCrop(input) {
    const parts = String(input ?? '').split(/[,，\s]+/).filter(Boolean);
    if (parts.length !== 4)
        return null;
    const nums = parts.map(Number);
    if (nums.some((n) => !Number.isFinite(n)))
        return null;
    const [x, y, w, h] = nums;
    if (x < 0 || y < 0 || w < 0.01 || h < 0.01 || w > 1 || h > 1)
        return null;
    if (x + w > 1.0001 || y + h > 1.0001)
        return null;
    return [x, y, w, h];
}
/** 秒 → 图上时间码：mm:ss，超过一小时才带 h: */
export function formatClock(sec) {
    const total = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
/** 秒 → 带十分之一秒的时间码（00:12.3）；整秒不带小数，区间密抽时同一秒里也能分开 */
export function formatClockFine(sec) {
    const rounded = Math.max(0, Math.round((Number(sec) || 0) * 10) / 10);
    const whole = Math.floor(rounded);
    const tenth = Math.round((rounded - whole) * 10);
    const h = Math.floor(whole / 3600);
    const m = Math.floor((whole % 3600) / 60);
    const s = whole % 60;
    const base = h
        ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
        : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return tenth ? `${base}.${tenth}` : base;
}
