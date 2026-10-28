/**
 * B 站 HTTP 客户端适配器 —— 只此一处对 B 站发请求（CLI 与宿主共用）。
 * 请求保护写死在这里，不靠自觉：
 *   · 两次请求至少隔 risk.minGapMs（默认 1200ms）；连击是最容易被判机器人的特征
 *   · 撞 412 / 风控码 → 指数退避熔断（5/10/20/30 分钟），状态在 api-ban.json
 *   · 只读接口可带 ttlMs 缓存（api-cache.json，按凭据区分）
 *   · 凭据只从 ~/.dsh/bili-lite-work/credentials.json 读，永远不回显
 *   · apiGet 吃 JSON；弹幕 list.so 这类 XML 文本接口走 apiText，同一套保护
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { config } from '../config/store.js';
import { DATA_DIR, CRED_FILE, BAN_FILE, CACHE_FILE } from '../config/paths.js';
import { readJson, writeJson } from './json-file.js';
export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
export const cookieHeader = (cred) => `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}`
    + (cred.buvid3 ? `; buvid3=${cred.buvid3}` : '') // 空 buvid 不发（扫码拿不到时别发个空值）
    + (cred.buvid4 ? `; buvid4=${cred.buvid4}` : ''); // 设备指纹：写接口比读接口更认它，有就带上
// ── 凭据（trim、查缺、不回显） ─────────────────────────────────────────────
export function loadCred() {
    let j;
    try {
        j = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8').replace(/^\uFEFF/, ''));
    }
    catch {
        throw new Error(`没有凭据文件：${CRED_FILE}\n  去设置页「B站养鱼」粘贴一次 cookie ✓（SESSDATA 是 HttpOnly，必须 F12 手动复制 ✗）`);
    }
    const clean = (v) => String(v ?? '').replace(/^["'\s]+|["'\s]+$/g, '');
    return { sessdata: clean(j.sessdata), bili_jct: clean(j.bili_jct), buvid3: clean(j.buvid3), buvid4: clean(j.buvid4) };
}
/** 凭据落盘（0600）：设置页验证后与扫码成功后共用这一条路，不各写一份 */
export function saveCred(cred) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CRED_FILE, JSON.stringify(cred, null, 2) + '\n');
    try {
        fs.chmodSync(CRED_FILE, 0o600);
    }
    catch { }
}
/** 真的去 nav 验证一次登录态，返回 { mid, name }（写凭据前后都该走这里，不做离线格式检查） */
export async function whoami(cred) {
    const nav = await apiGet('https://api.bilibili.com/x/web-interface/nav', { cred });
    if (nav.code !== 0 || nav.data?.isLogin !== true) {
        throw new Error(`登录验证失败：${explainCode(nav.code)}${nav.message ? `（${nav.message}）` : ''}`);
    }
    return { mid: String(nav.data.mid), name: String(nav.data.uname ?? '') };
}
/** 申请二维码：url 是二维码内容（B 站 App 扫码后确认），qrcodeKey 用于轮询（约 3 分钟有效） */
export async function qrGenerate() {
    const j = await apiGet('https://passport.bilibili.com/x/passport-login/web/qrcode/generate', { referer: 'https://passport.bilibili.com/' });
    if (j.code !== 0 || !j.data?.qrcode_key || !j.data?.url) {
        throw new Error(`申请二维码失败：${explainCode(j.code)}${j.message ? `（${j.message}）` : ''}`);
    }
    return { url: String(j.data.url), qrcodeKey: String(j.data.qrcode_key) };
}
/** 从 Set-Cookie 里挑凭据：扫码成功时 B 站用 Set-Cookie 下发 SESSDATA / bili_jct / DedeUserID，
 *  且 buvid3 / buvid4 只在这里出现；data.url 现在是一张 ticket 链接，query 里已经不带凭据了 */
function credFromSetCookie(res) {
    const raw = typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : String(res.headers.get('set-cookie') ?? '').split(/,(?=\s*[A-Za-z0-9_-]+=)/); // 老运行时：Expires 里也有逗号，只能按「逗号 + key=」切
    const jar = {};
    for (const line of raw) {
        const pair = line.split(';', 1)[0];
        const i = pair.indexOf('=');
        if (i > 0)
            jar[pair.slice(0, i).trim().toLowerCase()] = pair.slice(i + 1).trim();
    }
    return { sessdata: jar.sessdata, bili_jct: jar.bili_jct, buvid3: jar.buvid3, buvid4: jar.buvid4, mid: jar.dedeuserid };
}
/** 轮询一次：waiting 未扫码 / scanned 已扫码待确认 / expired 已过期 / done 成功（带凭据）。
 *  现行响应：外层 code 恒 0（"OK"），真正的登录状态在 data.code（86101/86090/86038/0） */
export async function qrPoll(qrcodeKey) {
    throwIfBanned();
    // 不走 apiGet：成功凭据在响应头的 Set-Cookie 里，得拿到原始 Response；且不能自动跟随跳转
    // （跨域票据链接一跳，302 之后的响应就没有 Set-Cookie 了）
    const r = await guardedFetch(`https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(qrcodeKey)}`, { referer: 'https://passport.bilibili.com/', redirect: 'error' });
    let j;
    try {
        j = await r.json();
    }
    catch {
        throw new Error(`非 JSON 响应（HTTP ${r.status}），可能是风控`);
    }
    guardCode(j);
    if (Number(j.code) !== 0)
        throw new Error(`扫码轮询失败：${explainCode(Number(j.code))}${j.message ? `（${j.message}）` : ''}`);
    const code = Number(j.data?.code);
    const status = { 86101: 'waiting', 86090: 'scanned', 86038: 'expired' }[code];
    if (status)
        return { status };
    if (code !== 0)
        throw new Error(`扫码轮询失败：${explainCode(code)}${j.data?.message ? `（${j.data.message}）` : ''}`);
    // 成功：凭据优先取 Set-Cookie；只有在没有 set-cookie 的老形态下才退回 data.url 的 query
    const jar = credFromSetCookie(r);
    let u = null;
    try {
        u = j.data?.url ? new URL(String(j.data.url)) : null;
    }
    catch {
        u = null;
    }
    const param = (k) => u?.searchParams.get(k) ?? '';
    const cred = {
        sessdata: jar.sessdata || param('SESSDATA'),
        bili_jct: jar.bili_jct || param('bili_jct'),
        buvid3: jar.buvid3 || param('buvid3'),
        buvid4: jar.buvid4 || param('buvid4'),
    };
    if (!cred.sessdata || !cred.bili_jct) {
        throw new Error('扫码成功但 B 站没下发 cookie（Set-Cookie 里没有 SESSDATA / bili_jct）—— 重扫一次；还不行就用手动粘贴 cookie');
    }
    return { status: 'done', cred, mid: jar.mid || param('DedeUserID') };
}
// ── 常见返回码 → 人话 ──────────────────────────────────────────────────────
const CODE_HINTS = {
    '0': '成功',
    '-101': '账号未登录 —— SESSDATA 失效了，重新复制一次 cookie',
    '-111': 'CSRF 校验失败 —— bili_jct 和当前 SESSDATA 不是同一个账号，两个都要重抄',
    '-400': '请求参数错误',
    '-401': '未认证 / 非法请求 —— 写接口不认这次请求：多半是 bili_jct 与 SESSDATA 不配套或已残缺（两条一起重抄），也可能是账号被限制了互动；不是风控，也没花掉额度',
    '-352': '风控拦截 —— 请求太快或太像机器人，等几分钟',
    '-799': '请求过于频繁 —— 退避一会儿',
    '10031': '操作太快（频率限制）—— 退避，别连发',
    '12015': '需要验证码 —— 停下，人在浏览器里手动过一次',
    '12051': '疑似刷屏 —— 停下，别再发',
    '12002': '评论区已关闭 / 不能评论',
    '34002': '不能给自己的视频投币',
    '34003': '这条投不了币（番剧 / 付费 / 特殊稿件）',
    '34004': '投币数超过 2 —— 一条视频最多 2 个',
    '34005': '今日投币上限（已经投满了）—— 明天再说',
    '65004': '取消赞失败 —— 本来就没点过赞',
    '22003': '这个用户不存在',
    '22004': '不能关注自己 —— 这是你和主人共用的号',
};
export const explainCode = (code) => CODE_HINTS[String(code)] ?? `code=${code}（未知返回码）`;
// ── 请求保护：节流 + 熔断 + 一点缓存 ───────────────────────────────────────
const BAN_CODES = new Set([-412, -352, -799, -509]);
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
/** Origin 跟 Referer 同源：浏览器发的 POST 一定带，缺了容易被写接口判「非法访问」 */
const originOf = (u) => { try {
    return new URL(u).origin;
}
catch {
    return 'https://www.bilibili.com';
} };
const banState = () => readJson(BAN_FILE, {});
export const banUntil = () => Number(banState().until ?? 0);
export const banWhy = () => banState().why ?? '未知原因';
function setBan(why) {
    const prev = banState();
    const streak = Number(prev.streak ?? 0) + 1;
    const mins = Math.min(30, 5 * 2 ** (streak - 1)); // 5/10/20/30 分钟指数退避
    writeJson(BAN_FILE, { until: Date.now() + mins * 60_000, why, streak, at: new Date().toISOString() });
    return mins;
}
let lastRequestAt = 0;
const cacheStore = () => readJson(CACHE_FILE, {});
function cacheKey(u, cred) {
    const url = new URL(u);
    const params = [...url.searchParams.entries()].filter(([k]) => k !== 'wts' && k !== 'w_rid').sort();
    return crypto.createHash('sha256').update(cred?.sessdata ?? '').update('\0')
        .update(url.hostname + url.pathname + '?' + new URLSearchParams(params)).digest('hex');
}
/** 熔断中就别发（apiGet / apiText 共用） */
function throwIfBanned() {
    const banned = banUntil();
    if (banned > Date.now()) {
        const mins = Math.ceil((banned - Date.now()) / 60000);
        throw new Error(`B站风控熔断中（${banWhy()}），约 ${mins} 分钟后自动恢复 —— 别再打了`);
    }
}
/** 发送段：节流 → 请求 → 412/429 熔断（apiGet / apiText / apiPost 共用，行为写死一处） */
async function guardedFetch(u, { cred, referer = 'https://www.bilibili.com/', method = 'GET', body, redirect } = {}) {
    const gap = Math.max(300, Number(config().risk?.minGapMs ?? 1200));
    const idle = Date.now() - lastRequestAt;
    if (lastRequestAt && idle < gap)
        await sleep(gap - idle);
    lastRequestAt = Date.now();
    const headers = {
        'user-agent': UA, referer,
        ...(method === 'GET' ? {} : { origin: originOf(referer) }), // 写请求补 Origin（GET 浏览器本来也不发）
        ...(cred ? { cookie: cookieHeader(cred) } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded' }),
    };
    const r = await fetch(u, {
        method, headers, redirect,
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(30000),
    });
    if (r.status === 412 || r.status === 429) {
        const mins = setBan(`HTTP ${r.status}`);
        throw new Error(`HTTP ${r.status}（B站风控）—— 已熔断 ${mins} 分钟，今天先歇了`);
    }
    if (!r.ok)
        throw new Error(`HTTP ${r.status}（接口异常或风控，稍后再试）`);
    return r;
}
/** 风控码 → 熔断（apiGet / apiPost 共用；只判定，不吞掉非风控的返回码） */
function guardCode(data) {
    if (BAN_CODES.has(Number(data.code))) {
        const mins = setBan(`code=${data.code}`);
        throw new Error(`${data.message ?? ''}（B站风控 ${data.code}）—— 已熔断 ${mins} 分钟`);
    }
    return data;
}
/** 统一 GET JSON：熔断检查 →（可选）缓存 → 发送 → 风控判定 →（可选）落缓存 */
export async function apiGet(u, { cred, ttlMs = 0, referer = 'https://www.bilibili.com/' } = {}) {
    throwIfBanned();
    const key = ttlMs > 0 ? cacheKey(u, cred) : null;
    if (key) {
        const hit = cacheStore()[key];
        if (hit && Date.now() - Number(hit.at ?? 0) < ttlMs)
            return { ...hit.data, _cached: true };
    }
    const r = await guardedFetch(u, { cred, referer });
    let data;
    try {
        data = await r.json();
    }
    catch {
        throw new Error(`非 JSON 响应（HTTP ${r.status}），可能是风控`);
    }
    guardCode(data);
    if (Number(data.code) === 0 && key) {
        const store = cacheStore();
        store[key] = { at: Date.now(), data };
        const keys = Object.keys(store);
        if (keys.length > 200)
            for (const k of keys.slice(0, keys.length - 200))
                delete store[k];
        writeJson(CACHE_FILE, store);
    }
    return data;
}
/** 文本 GET（弹幕 list.so 返回 XML 不是 JSON，apiGet 吃不下）：同一套节流/熔断，不缓存 */
export async function apiText(u, opts = {}) {
    throwIfBanned();
    return (await guardedFetch(u, opts)).text();
}
/** 写操作 POST（点赞 / 投币 / 关注 / 评论）：节流与熔断跟 apiGet 同一套；
 *  csrf 由调用方显式放进 body —— 这里不偷偷加，免得写错账号的事故被藏起来 */
export async function apiPost(u, body, { cred, referer = 'https://www.bilibili.com/' } = {}) {
    throwIfBanned();
    // csrf 先在本地挡一次：复制半截的 bili_jct 发出去只会换来 -111 / -401，白发一趟还要回滚判断
    const csrf = 'csrf' in body ? String(body.csrf) : '';
    if (csrf && !/^[0-9a-fA-F]{32}$/.test(csrf)) {
        throw new Error('csrf（bili_jct）不是 32 位十六进制 —— 多半是 cookie 复制时被截断了：SESSDATA 与 bili_jct 两条一起重抄，别只换一条');
    }
    const r = await guardedFetch(u, { cred, referer, method: 'POST', body: new URLSearchParams(body).toString() });
    let data;
    try {
        data = await r.json();
    }
    catch {
        throw new Error(`非 JSON 响应（HTTP ${r.status}），可能是风控`);
    }
    guardCode(data);
    return data;
}
// ── WBI 签名（搜索要） ─────────────────────────────────────────────────────
const MIXIN_TAB = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];
const keyOf = (u) => String(u).slice(String(u).lastIndexOf('/') + 1, String(u).lastIndexOf('.'));
let wbiMixin = null;
async function wbiMixinOf(cred) {
    if (wbiMixin)
        return wbiMixin;
    const nav = await apiGet('https://api.bilibili.com/x/web-interface/nav', { cred, ttlMs: 10 * 60_000 });
    const raw = keyOf(nav.data?.wbi_img?.img_url ?? '') + keyOf(nav.data?.wbi_img?.sub_url ?? '');
    if (raw.length !== 64)
        throw new Error('WBI 签名密钥缺失（nav 未返回 wbi_img）—— 检查登录状态');
    wbiMixin = MIXIN_TAB.map((i) => raw[i]).join('').slice(0, 32);
    return wbiMixin;
}
export async function wbi(params, cred) {
    const mixin = await wbiMixinOf(cred);
    const wts = Math.round(Date.now() / 1000);
    const clean = (v) => String(v).replace(/[!'()*]/g, '');
    const q = Object.keys({ ...params, wts }).sort()
        .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(clean(k === 'wts' ? wts : params[k]))}`).join('&');
    return `${q}&w_rid=${crypto.createHash('md5').update(q + mixin).digest('hex')}`;
}
// ── 视频内容（字幕 / 弹幕）—— 只读；读多深由 agent 自己定，工具不截断 ──────
/** player v2（要 WBI 签名）：章节 view_points + 字幕列表。
 *  实测：AI 字幕列表要登录态才返回（匿名 subtitles 为空、need_login_subtitle=true） */
export async function getPlayerInfo(bvid, cid, cred) {
    const qs = await wbi({ bvid, cid }, cred);
    const j = await apiGet(`https://api.bilibili.com/x/player/wbi/v2?${qs}`, {
        cred, ttlMs: 10 * 60_000, referer: `https://www.bilibili.com/video/${bvid}/`,
    });
    if (j.code !== 0)
        throw new Error(`player 接口 ${explainCode(j.code)}${j.message ? `（${j.message}）` : ''}`);
    return j.data ?? {};
}
/** 播放直链（抽帧用）：先要 mp4（fnval=1，durl），拿不到再退 dash 的视频流。
 *  实测：qn=80 + platform=pc + high_quality=1 才给到 720P+；匿名只有 360P（抽帧也吃登录态）。
 *  走 plain playurl 而不是 wbi 版：实测 wbi 版在匿名/无 buvid 时直接 412（会误伤熔断），
 *  plain 版带 cookie + referer 就够（qn 由登录态决定）。
 *  返回 { url, quality, segments, seconds } —— seconds 是这条直链覆盖的时长（多段视频只有第一段） */
export async function getPlayUrl(bvid, cid, cred, { qn = 80 } = {}) {
    const referer = `https://www.bilibili.com/video/${bvid}/`;
    const ask = async (fnval) => {
        const qs = new URLSearchParams({
            bvid, cid: String(cid), qn: String(qn), fnval: String(fnval), fnver: '0', fourk: '1', platform: 'pc', high_quality: '1',
        });
        return apiGet(`https://api.bilibili.com/x/player/playurl?${qs}`, { cred, referer });
    };
    const j = await ask(1);
    if (Number(j.code) !== 0)
        throw new Error(`播放地址 ${explainCode(j.code)}${j.message ? '（' + j.message + '）' : ''}`);
    const durl = j.data?.durl ?? [];
    if (durl.length) {
        return {
            url: String(durl[0].url), quality: j.data?.quality, segments: durl.length,
            seconds: Math.round(Number(durl[0].length ?? 0) / 1000) || 0,
        };
    }
    // 没有 mp4（新视频常只给 dash）：退一步拿视频流，ffmpeg 照样能读
    const d = await ask(16);
    const vs = d.data?.dash?.video ?? [];
    if (!vs.length)
        throw new Error('拿不到视频流（互动视频 / 付费 / 港澳台限定抽不了帧）');
    const best = vs.reduce((a, b) => (Number(b.id) > Number(a.id) ? b : a), vs[0]);
    const url = String(best.baseUrl ?? best.base_url ?? '');
    if (!url)
        throw new Error('video 流地址为空 —— 稍后再试');
    return { url, quality: best.id, segments: 1, seconds: 0 };
}
/** 选一条字幕：人工 CC 优先（质量高），AI 生成兜底（覆盖广） */
export const pickSubtitle = (info) => {
    const subs = info?.subtitle?.subtitles ?? [];
    return subs.find((s) => !String(s.lan ?? '').startsWith('ai-')) ?? subs[0] ?? null;
};
/** 字幕正文 → [{ from, to, text }]（秒）。形状按防御式解析：字段缺失/为空就报错，由调用方降级 */
export async function getSubtitleLines(bvid, sub, cred) {
    let u = String(sub?.subtitle_url ?? '');
    if (!u)
        throw new Error('字幕地址为空');
    if (u.startsWith('//'))
        u = 'https:' + u;
    const j = await apiGet(u, { cred, ttlMs: 24 * 3600_000, referer: `https://www.bilibili.com/video/${bvid}/` });
    const lines = (Array.isArray(j?.body) ? j.body : [])
        .map((l) => ({ from: Number(l.from) || 0, to: Number(l.to) || 0, text: String(l.content ?? '').replace(/\s+/g, ' ').trim() }))
        .filter((l) => l.text);
    if (!lines.length)
        throw new Error('字幕内容为空');
    return lines;
}
/** 弹幕速览：条数 + 热词 + 最热闹的一分钟 ——「哪里精彩」的社群信号（画面型视频也有的读）。
 *  实测：list.so 只回最近约 1200 条的窗口（stat.danmaku 是全量历史），速览够用 */
export async function getDanmakuBrief(bvid, cid, cred, { topN = 10 } = {}) {
    const xml = await apiText(`https://api.bilibili.com/x/v1/dm/list.so?oid=${cid}`, { cred, referer: `https://www.bilibili.com/video/${bvid}/` });
    const ds = [...xml.matchAll(/<d p="([^",]+)[^"]*">([\s\S]{1,200}?)<\/d>/g)];
    if (!ds.length)
        return { count: 0, top: [], dense: null };
    const ent = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };
    const dec = (s) => s.replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, e) => ent[e]).replace(/\s+/g, ' ').trim();
    const freq = new Map();
    for (const t of ds.map((m) => dec(m[2])).filter(Boolean)) {
        for (const w of t.match(/[\u4e00-\u9fa5A-Za-z]{2,8}|\d{2,}/g) ?? []) {
            if (/^1+$|^233+$|^66+$|^77+$|^0+$/.test(w))
                continue; // 刷屏数字不算热词
            freq.set(w, (freq.get(w) ?? 0) + 1);
        }
    }
    const top = [...freq.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, topN);
    const buckets = new Map();
    for (const m of ds) {
        const min = Math.floor((Number(m[1]) || 0) / 60);
        buckets.set(min, (buckets.get(min) ?? 0) + 1);
    }
    let dense = null;
    for (const [min, n] of buckets)
        if (!dense || n > dense.n)
            dense = { from: min * 60, n };
    return { count: ds.length, top, dense };
}
