/**
 * dsh-bili-lite · bili-agent —— ops 层（唯一的数据面）
 *
 * 为什么有这一层：同一件事现在有两个调用方 —— 终端里的 `bili.ts` 和 DSH 的工具
 * （`bili_feed` / `bili_video` / …）。tool 的契约要求 `execute` 返回一个规范化 JSON 值，
 * 由渲染层单独负责给人看的话（DSH `adding-a-tool.md`：不许让调用方去解析 prose）。
 * 所以「取数据」和「说人话」必须分开，否则两条路只有一条能拿到结构化结果。
 *
 * 这一层的三条铁律：
 *   1. 不打印、不退出、不读 argv —— 失败一律 `throw new BiliError(…)`，
 *      CLI 把它翻成退出码（2/3/4/5/6），tool 把它翻成 isError。
 *   2. 不格式化 —— 不出现「万」「MM:SS」「3 天前」。数字给秒和原值，
 *      口径（怎么显示）属于调用方。唯一的例外是 schedule.whenText（见下）。
 *   3. 副作用留在这一层 —— 账本记账、`看过` 标记、收件箱已读、计划落盘都在这里。
 *      谁上移到 tool，CLI 那条路就会漏记。
 *
 * 现状：全部 op 已迁完（feed / up / following / video / shots / inbox / history /
 * schedule / comment / interact）。CLI 只剩「解析 flags + 排版」，数据与副作用都在这里。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { apiGet, apiPost, explainCode, loadCred, whoami, wbi, getFollowingFeed, searchUsers, getSpaceVideos, getFollowings, getView, getPlayerInfo, pickSubtitle, getSubtitleLines, getDanmakuBrief, getMsgFeed, getThreadReplies, banUntil, banWhy, getPlayUrl, UA } from '../../lib/bilibili.js';
import { requireFfmpeg, runFfmpegAsync, ffmpegCaps, findFfmpegFont, isFfmpegAbort } from '../../lib/ffmpeg.js';
import { formatClock, formatClockFine } from '../../lib/timecode.js';
import { SHOTS_DIR } from '../../config/paths.js';
import { seenSet, ledgerAppend, readLedger, writesToday, interactionsToday, interactedWithin, commentedWithin, repliedWithin, today } from './ledger.js';
import { config, DEFAULTS } from '../../config/store.js';
import { readPlan, addEntry, dropEntry, clearPlan, fmtWhen, expiryText, MAX_PENDING } from '../../lib/schedule.js';
import { readJson, writeJson } from '../../lib/json-file.js';
import { INBOX_FILE } from '../../config/paths.js';
export class BiliError extends Error {
    code;
    /** 下一步该干什么（CLI 打在 ✗ 后面；tool 拼进 message 里） */
    hint;
    constructor(code, message, hint) {
        super(message);
        this.name = 'BiliError';
        this.code = code;
        this.hint = hint;
    }
}
// ── 共享小工具（只做数据整形，不碰显示口径）──────────────────────────────
const BV_RE = /^BV[0-9A-Za-z]{10}$/;
const msg = (e) => (e instanceof Error ? e.message : String(e));
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
/**
 * "90" / "1:30" / "1:02:03" → 秒。
 * 给了但认不出就 undefined —— 不静默当 0（0 秒和「不知道多长」是两件事）。
 */
function toSeconds(d) {
    if (d === null || d === undefined || d === '')
        return undefined;
    const s = String(d).trim();
    const parts = s.split(':').map(Number);
    if (parts.length >= 2 && parts.every((x) => Number.isFinite(x)))
        return parts.reduce((a, b) => a * 60 + b, 0);
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
}
/** 没凭据是常态，不是「意外」：统一翻成 credential 码，消息原样保留（里面已经写了去哪补） */
function cred() {
    try {
        return loadCred();
    }
    catch (e) {
        throw new BiliError('credential', msg(e));
    }
}
/** 搜索结果的标题带 <em> 高亮标签，去掉 */
const plainTitle = (s) => String(s ?? '').replace(/<[^>]+>/g, '');
/** 数字参数容错：NaN / 没给 → 默认值（再交给 clamp 收边界） */
const finiteOr = (n, fallback) => (Number.isFinite(Number(n)) ? Number(n) : fallback);
/** 秒级时间戳 → YYYY-MM-DD（本地时区；日期是数据，不是口径） */
const dateOnly = (sec) => new Date(sec * 1000).toLocaleDateString('sv-SE');
/** 逐句字幕拼成可读的流水：CJK 边界不加空格，英文边界加 */
const flowText = (texts) => texts.reduce((acc, t) => {
    if (!acc)
        return t;
    const cjk = /[\u4e00-\u9fff，。！？、；：…）》」』％]$/.test(acc.slice(-1)) || /^[\u4e00-\u9fff，。！？、；：…（《「『]/.test(t);
    return acc + (cjk ? '' : ' ') + t;
}, '');
/**
 * 今天的候选：关键词搜索（它自己给）→ 关注动态 → 热门，谁有谁上，凑够 n 条为止。
 *
 * 三条支路互不牵连：一条挂了只记 note，其余照给。理由是抖动是常态 ——
 * 关注动态缺 buvid3 必被 -352 拦，热门偶尔超时，为这些让整次「今天看什么」失败
 * 等于让它每一拍都在跟网络吵架。
 */
export async function feed(opts = {}) {
    // 非法数字（--n abc / 工具传了 NaN）退回默认值：静默返回空列表比报错更难查
    const wanted = Number(opts.limit ?? 5);
    const n = clamp(Math.trunc(Number.isFinite(wanted) ? wanted : 5), 1, 10);
    const keywords = (opts.keywords ?? []).map((s) => String(s).trim()).filter(Boolean).slice(0, 3);
    const credential = cred();
    const seen = seenSet();
    const notes = [];
    const pool = [];
    /** 只排除「看过」和重复；不预先排除任何题材 —— 要不要看它自己判断 */
    const push = (c) => {
        if (!BV_RE.test(c.bvid))
            return;
        if (seen.has(c.bvid))
            return;
        if (pool.some((x) => x.bvid === c.bvid))
            return;
        pool.push(c);
    };
    // ① 它自己给的关键词（不给就跳过这一路）
    for (const kw of keywords) {
        try {
            const qs = await wbi({ search_type: 'video', keyword: kw.slice(0, 40), page: 1 }, credential);
            const j = await apiGet(`https://api.bilibili.com/x/web-interface/wbi/search/type?${qs}`, { cred: credential, referer: 'https://search.bilibili.com/' });
            for (const r of j.data?.result ?? []) {
                if (!r.bvid)
                    continue;
                push({
                    bvid: r.bvid,
                    title: plainTitle(r.title),
                    up: r.author,
                    play: r.play === undefined ? undefined : Number(r.play),
                    durationSec: toSeconds(r.duration),
                    source: 'search',
                    keyword: kw,
                });
            }
        }
        catch (e) {
            notes.push(`搜「${kw}」失败：${msg(e)}`);
        }
        if (pool.length >= n * 3)
            break;
    }
    // ② 关注动态：关注是它自己做的决定，这里只把结果端上来
    if (pool.length < n) {
        if (!credential.buvid3) {
            notes.push('关注动态跳过：cookie 里没有 buvid3 —— 去设置页重抄一次 cookie；这轮先靠搜索 / 热门');
        }
        else {
            const before = pool.length;
            try {
                const items = await getFollowingFeed(credential);
                for (const it of items) {
                    const a = it.modules?.module_dynamic?.major?.archive;
                    if (!a?.bvid)
                        continue;
                    push({
                        bvid: a.bvid,
                        title: String(a.title ?? ''),
                        up: it.modules?.module_author?.name,
                        play: a.stat?.play === undefined ? undefined : Number(a.stat.play),
                        durationSec: toSeconds(a.duration_text),
                        source: 'following',
                    });
                }
                if (pool.length === before)
                    notes.push('关注动态里没有没看过的投稿 —— 关注的人还没更新，或这个号还没关注谁');
            }
            catch (e) {
                notes.push(`关注动态失败：${msg(e)}`);
            }
        }
    }
    // ③ 还是不够就用热门补
    if (pool.length < n) {
        try {
            const j = await apiGet('https://api.bilibili.com/x/web-interface/popular?pn=1&ps=20', { cred: credential });
            for (const r of j.data?.list ?? []) {
                if (!r.bvid)
                    continue;
                push({
                    bvid: r.bvid,
                    title: String(r.title ?? ''),
                    up: r.owner?.name,
                    play: r.stat?.view,
                    durationSec: toSeconds(r.duration),
                    source: 'popular',
                });
            }
        }
        catch (e) {
            notes.push(`热门列表失败：${msg(e)}`);
        }
    }
    return { candidates: pool.slice(0, n), notes };
}
/**
 * 某位 UP 的投稿列表。target 三种写法：纯 mid / 空间链接 / 名字。
 * 写名字要多花一次搜人（只读，同一套节流）—— 搜到的第一位当命中，其余进 matched.alternates，
 * 让它自己判断有没有认错人（同名 UP 很常见）。
 */
export async function up(opts) {
    const target = String(opts.target ?? '').trim();
    if (!target)
        throw new BiliError('usage', '缺少目标：mid / 空间链接 / 名字');
    const ps = clamp(Math.trunc(finiteOr(opts.limit, 20)), 1, 50);
    const pn = clamp(Math.trunc(finiteOr(opts.page, 1)), 1, 500);
    const order = opts.order ?? 'pubdate';
    if (order !== 'pubdate' && order !== 'click' && order !== 'stow') {
        throw new BiliError('usage', `--order 只认 pubdate / click / stow，收到「${String(order)}」`);
    }
    const credential = cred();
    let mid = '';
    let matched;
    const fromUrl = target.match(/space\.bilibili\.com\/(\d{1,12})/);
    if (fromUrl)
        mid = fromUrl[1];
    else if (/^\d{1,12}$/.test(target))
        mid = target;
    else {
        const hits = (await searchUsers(target, credential)).filter((u) => u.mid);
        if (!hits.length) {
            throw new BiliError('notfound', `没搜到叫「${target}」的 UP`, '换成完整的名字，或直接写 mid（following / video 的输出里有）');
        }
        const [top, ...rest] = hits;
        mid = String(top.mid);
        matched = {
            mid,
            name: String(top.uname ?? ''),
            fans: top.fans === undefined ? undefined : Number(top.fans),
            videos: top.videos === undefined ? undefined : Number(top.videos),
            alternates: rest.slice(0, 4).map((u) => ({ mid: String(u.mid), name: String(u.uname ?? '') })),
        };
    }
    const res = await getSpaceVideos(mid, credential, { pn, ps, order });
    return {
        mid,
        name: res.name,
        total: res.total,
        page: pn,
        pages: Math.max(1, Math.ceil(res.total / ps)),
        pageSize: ps,
        order,
        videos: res.list.map((v) => ({
            bvid: String(v.bvid ?? ''),
            title: plainTitle(v.title),
            play: Number(v.play ?? 0) || 0,
            danmaku: Number(v.video_review ?? 0) || 0,
            durationSec: toSeconds(v.length),
            publishedAt: v.created ? dateOnly(Number(v.created)) : undefined,
        })),
        matched,
    };
}
/**
 * 我关注了谁（名单本身，最近关注的在前）。
 * 和 feed 里的「关注动态」分工：动态只说谁最近发了什么，长期不更的看不见；
 * 这条才是完整名单，mid 可直接抄给 up 往下翻。
 *
 * vmid 只能是自己，所以现查一次 nav —— 配置里的 self 是登录那一刻的快照，换过号就指错人。
 */
export async function following(opts = {}) {
    const ps = clamp(Math.trunc(finiteOr(opts.limit, 50)), 1, 50);
    const pn = clamp(Math.trunc(finiteOr(opts.page, 1)), 1, 500);
    const credential = cred();
    const self = await whoami(credential);
    const res = await getFollowings(self.mid, credential, { pn, ps });
    const pages = Math.max(1, Math.ceil(res.total / ps));
    return {
        self: { mid: String(self.mid), name: String(self.name ?? '') },
        total: res.total,
        page: pn,
        pages,
        pageSize: ps,
        // 页码越界单说：不然会渲染出「第 2/1 页」这种对不上的标题
        outOfRange: res.total > 0 && pn > pages,
        users: res.list.map((u) => {
            const official = String(u.official?.title ?? '').trim();
            return {
                mid: String(u.mid ?? ''),
                name: String(u.uname ?? ''),
                followedAt: u.mtime ? dateOnly(Number(u.mtime)) : undefined,
                badge: official || (Number(u.vip?.vipStatus) === 1 ? '大会员' : '') || undefined,
                // 签名常带换行：压成一行，截断留给渲染层（那里才有「多长算长」的口径）
                sign: String(u.sign ?? '').replace(/\s+/g, ' ').trim() || undefined,
            };
        }),
    };
}
/**
 * 看懂一条：概览（简介 / 章节 / 字幕试读 / 弹幕热词 / 热评）或字幕正文。
 *
 * 两个入口合成一个函数，因为「先取 view」这步一样，分歧只在拿到 view 之后。
 * 概览和深读**都记 watch** 进账本（「看过」的唯一真相）—— 读了字幕也算看过，
 * 否则同一支视频会一直被 feed 当成没看过反复端上来。
 */
export async function video(opts) {
    const bvid = String(opts.bvid ?? '').trim();
    if (!BV_RE.test(bvid))
        throw new BiliError('usage', '需要一个 BV 号', '形如 BV1xx411c7mD（从 feed / up 的输出里抄）');
    const credential = cred();
    const v = await getView(bvid, credential);
    const title = String(v.title ?? '');
    if (opts.read) {
        const t = await transcript(bvid, title, v, credential, opts.read);
        recordWatch(bvid, title, v);
        return t;
    }
    const notes = [];
    const overview = {
        kind: 'overview',
        bvid,
        aid: Number(v.aid ?? 0),
        title,
        up: { mid: v.owner?.mid === undefined ? undefined : Number(v.owner.mid), name: v.owner?.name },
        publishedAt: v.pubdate ? dateOnly(Number(v.pubdate)) : undefined,
        durationSec: Number(v.duration ?? 0) || 0,
        stats: {
            view: Number(v.stat?.view ?? 0) || 0,
            danmaku: Number(v.stat?.danmaku ?? 0) || 0,
            like: Number(v.stat?.like ?? 0) || 0,
            coin: Number(v.stat?.coin ?? 0) || 0,
            favorite: Number(v.stat?.favorite ?? 0) || 0,
        },
        description: String(v.desc ?? '').trim() || undefined,
        chapters: [],
        notes,
    };
    // ── 章节 + 字幕（同一个接口，同一次失败）──
    try {
        const info = await getPlayerInfo(bvid, Number(v.cid), credential);
        overview.chapters = (Array.isArray(info.view_points) ? info.view_points : []).map((p) => ({
            fromSec: Math.round(Number(p.from) || 0),
            title: String(p.content ?? '').trim(),
        }));
        const sub = pickSubtitle(info);
        if (!sub) {
            overview.subtitleMissing = info.need_login_subtitle ? 'need-login' : 'none';
        }
        else {
            const lines = await getSubtitleLines(bvid, sub, credential);
            if (!lines.length)
                overview.subtitleMissing = 'none';
            else {
                const all = flowText(lines.map((l) => l.text));
                const last = lines[lines.length - 1];
                overview.subtitle = {
                    kind: String(sub.lan ?? '').startsWith('ai-') ? 'ai' : 'cc',
                    preview: all.slice(0, 500),
                    chars: all.length,
                    fromSec: Math.round(lines[0].from),
                    toSec: Math.round(last.to || last.from),
                };
            }
        }
    }
    catch (e) {
        notes.push({ stage: 'chapters', message: `章节/字幕读取失败：${msg(e)}` });
    }
    // ── 弹幕热词 ──
    try {
        const dm = await getDanmakuBrief(bvid, Number(v.cid), credential);
        if (dm.count > 0) {
            overview.danmaku = {
                count: dm.count,
                top: dm.top.map(([word, n]) => ({ word, n })),
                denseAtSec: dm.dense?.from,
                denseInMinute: dm.dense?.n,
            };
        }
    }
    catch (e) {
        notes.push({ stage: 'danmaku', message: `弹幕读取失败：${msg(e)}` });
    }
    // ── 热评（只取前 5 条：这是「氛围」，不是调研）──
    try {
        const j = await apiGet(`https://api.bilibili.com/x/v2/reply?type=1&oid=${v.aid}&sort=2&ps=10&pn=1`, { cred: credential });
        overview.topReplies = (j.data?.replies ?? []).slice(0, 5).map((r) => ({
            like: Number(r.like ?? 0) || 0,
            author: String(r.member?.uname ?? ''),
            text: String(r.content?.message ?? '').replace(/\s+/g, ' '),
            replyCount: r.count === undefined ? undefined : Number(r.count),
        }));
    }
    catch (e) {
        notes.push({ stage: 'replies', message: `热评读取失败：${msg(e)}` });
    }
    recordWatch(bvid, title, v);
    return overview;
}
/** 记一笔「看过」。概览与深读共用一条路 —— 两个入口各写一份是最容易漏的地方 */
function recordWatch(bvid, title, v) {
    ledgerAppend({
        type: 'watch',
        bvid,
        up: v.owner?.name ? String(v.owner.name).slice(0, 40) : undefined,
        title: title.slice(0, 60),
    });
}
/** 深读：字幕正文，全文或按时间区间，绝不截断 —— 深浅是它的事，读不设限（克制只管写） */
async function transcript(bvid, title, v, credential, read) {
    let from = 0;
    let to;
    if (read.mode === 'range') {
        from = Number(read.fromSec);
        if (!Number.isFinite(from) || from < 0)
            throw new BiliError('usage', '--read 的起始时间认不出', '写成 03:00-08:30，或秒数 180-510');
        if (read.toSec !== undefined) {
            to = Number(read.toSec);
            if (!Number.isFinite(to))
                throw new BiliError('usage', '--read 的结束时间认不出', '写成 03:00-08:30，或秒数 180-510');
            if (to <= from)
                throw new BiliError('usage', '--read 的结束时间要晚于开始时间');
        }
    }
    const upper = to ?? Infinity;
    const base = { kind: 'transcript', bvid, title, fromSec: from, toSec: to, chars: 0, text: '' };
    const info = await getPlayerInfo(bvid, Number(v.cid), credential);
    const sub = pickSubtitle(info);
    if (!sub)
        return { ...base, empty: 'no-subtitle' };
    const lines = await getSubtitleLines(bvid, sub, credential);
    const sel = lines.filter((l) => l.to > from && l.from < upper);
    if (!sel.length)
        return { ...base, subtitleKind: String(sub.lan ?? '').startsWith('ai-') ? 'ai' : 'cc', empty: 'no-lines-in-range' };
    const text = flowText(sel.map((l) => l.text));
    return { ...base, subtitleKind: String(sub.lan ?? '').startsWith('ai-') ? 'ai' : 'cc', chars: text.length, text };
}
const SHOTS_KEEP = 40;
const SHOTS_CACHE_TTL_MS = 7 * 24 * 3600_000;
/** 缓存格式版本：抽帧算法 / 产物形状变了就 +1，旧缓存自然失效 */
const SHOTS_CACHE_VERSION = 4;
const FRAME_CONCURRENCY = 4;
const FRAME_ATTEMPTS = 2;
const MAX_CANDIDATES = 40;
/** 相邻帧 SSIM ≥ 这个值就当「没变」 */
const DIFF_SSIM = 0.985;
/** 只清自己生成的图：BV-pN-时间-格数(-第几张).jpg */
const SHOTS_FILE_RE = /^BV[0-9A-Za-z]{10}(?:-p\d+)?-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}-\d+x\d+(?:-\d+of\d+)?\.jpg$/;
const even = (n) => Math.max(2, Math.round(n / 2) * 2);
/** 限并发跑任务；任何一项抛错就整体失败（abort 时其余项会很快看到 signal） */
async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (true) {
            const i = next;
            next += 1;
            if (i >= items.length)
                return;
            out[i] = await fn(items[i], i);
        }
    });
    await Promise.all(workers);
    return out;
}
/** n 帧平均分到若干张图，尽量不把最后一张塞爆（不够的格补黑） */
function sheetSizes(n, capacity) {
    if (n <= 0)
        return [];
    const count = Math.ceil(n / capacity);
    const base = Math.floor(n / count);
    const extra = n % count;
    return Array.from({ length: count }, (_, i) => base + (i < extra ? 1 : 0));
}
/** filter 里的路径转义：冒号是选项分隔符，单引号是字符串边界 */
const filterQuote = (s) => `'${s.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")}'`;
/**
 * 只画格号 + 时间码的滤镜（裁切 / 缩放已经在取帧时做过了）。
 * 格号跟这张图的行序号一致：图会进日记 / 笔记、以后还会被重读，
 * 没有格号就只能靠"每张图重新数"，脱离了这次的终端输出就对不上。
 *
 * 字画在格子顶部的黑边上（取帧时就 pad 出来了），不压画面 —— 裁切之后左上角
 * 往往正是要看的那块内容，压上去就没法看了。
 */
const LABEL_MARGIN = 3;
/**
 * 格号条的高度与字号：都跟着格子宽度走，宁可小一点也别占掉太多画面。
 * 高度 ≈ ascent + descent（Noto CJK 约 1.48 倍字号）+ 上下留白；
 * 黑边本身就是底色，所以不画 drawtext 的 box，省下一圈边距。
 * 字号沿用原来压在画面上的那档（cw/24）—— 拼图会被看图工具缩放，再小就看不清了。
 */
function labelMetrics(cw) {
    const size = Math.max(14, Math.round(cw / 24));
    return { size, height: even(Math.ceil(size * 1.55) + 2 * LABEL_MARGIN) };
}
function labelVf(font, cellNo, sec, size) {
    const text = `${cellNo} ${formatClockFine(sec)}`.replace(/:/g, '\\:');
    return `drawtext=fontfile=${filterQuote(font)}:text='${text}':x=8:y=${LABEL_MARGIN}:fontsize=${size}:fontcolor=white`;
}
function shotsCacheFile(key) {
    return path.join(SHOTS_DIR, '.cache', `${key}.json`);
}
function readShotsCache(key) {
    try {
        const meta = JSON.parse(fs.readFileSync(shotsCacheFile(key), 'utf8'));
        if (meta.v !== SHOTS_CACHE_VERSION || !meta.result || Date.now() - Number(meta.createdAt) > SHOTS_CACHE_TTL_MS)
            return null;
        const paths = Array.isArray(meta.result.paths) ? meta.result.paths : [];
        if (!paths.length || !paths.every((p) => fs.existsSync(p)))
            return null;
        return { ...meta.result, missingSec: meta.result.missingSec ?? [], cached: true };
    }
    catch {
        return null;
    }
}
function writeShotsCache(key, result) {
    try {
        const file = shotsCacheFile(key);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const meta = { v: SHOTS_CACHE_VERSION, createdAt: Date.now(), result };
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(meta));
        fs.renameSync(tmp, file);
    }
    catch { /* 缓存写失败不影响这次结果 */ }
}
/** 只留最近 40 张图；顺手清掉过期 / 指向已删图的缓存索引 */
function pruneShots() {
    try {
        if (!fs.existsSync(SHOTS_DIR))
            return;
        const files = fs.readdirSync(SHOTS_DIR)
            .filter((n) => SHOTS_FILE_RE.test(n))
            .map((n) => { const p = path.join(SHOTS_DIR, n); return { p, mtime: fs.statSync(p).mtimeMs }; })
            .sort((a, b) => b.mtime - a.mtime);
        for (const f of files.slice(SHOTS_KEEP))
            fs.rmSync(f.p, { force: true });
        const cacheDir = path.join(SHOTS_DIR, '.cache');
        if (!fs.existsSync(cacheDir))
            return;
        for (const n of fs.readdirSync(cacheDir)) {
            const p = path.join(cacheDir, n);
            try {
                const meta = JSON.parse(fs.readFileSync(p, 'utf8'));
                const stale = !meta.result || Date.now() - Number(meta.createdAt) > SHOTS_CACHE_TTL_MS * 2;
                const missing = !Array.isArray(meta.result?.paths) || !meta.result.paths.every((x) => fs.existsSync(x));
                if (stale || missing)
                    fs.rmSync(p, { force: true });
            }
            catch {
                fs.rmSync(p, { force: true });
            }
        }
    }
    catch { /* 清理失败不影响抽帧 */ }
}
/**
 * 两帧像不像（SSIM，1 = 一样）；算不出来返回 null（调用方当作「变了」）。
 * ignoreBottom > 0 时两边一起裁掉底部那条（字幕区）：口播 / 白板类视频里字幕整行重绘
 * 能把 SSIM 压到 0.98 上下（阈值 0.985，够不够全看字幕多长），裁掉之后同样的两帧回到
 * 1.0，而真换一张卡片仍然只有 0.96 —— 判据要的是后者。
 */
async function ssimScore(bin, a, b, ignoreBottom, signal) {
    const keep = 1 - Math.max(0, Math.min(0.9, ignoreBottom));
    const vf = keep < 1
        ? `[0:v]crop=iw:trunc(ih*${keep.toFixed(4)}/2)*2:0:0,setsar=1[x];`
            + `[1:v]crop=iw:trunc(ih*${keep.toFixed(4)}/2)*2:0:0,setsar=1[y];[x][y]ssim`
        : 'ssim';
    try {
        const r = await runFfmpegAsync(bin, [
            '-nostdin', '-hide_banner', '-loglevel', 'info', '-nostats',
            '-i', a, '-i', b, '-lavfi', vf, '-f', 'null', '-',
        ], { timeout: 30_000, signal });
        const m = /All:([0-9.]+)/.exec(r.stderr);
        return m ? Number(m[1]) : null;
    }
    catch (e) {
        if (isFfmpegAbort(e))
            throw new BiliError('unsupported', '抽帧被取消');
        return null;
    }
}
/**
 * 抽帧看画面：整条等间隔（grid）、指定时刻（at）、或区间密抽（range）。
 * 默认 3×3 九宫格；格号 + 时间码烧在每格顶部的黑边上（`1 12:30`），图离开终端也能对上字幕。
 *
 * 不落整段视频 —— 对直链按时间点远程 seek，只读需要的那几个字节范围。
 * 取帧 4 路并发；一帧失败重试一次，仍失败就留黑格并在 missingSec 里点名，
 * 不因为一格毁掉整张图。range + diff 时先密抽、再按 SSIM 丢掉没变的帧，
 * 帧数超过一张图的格数就出第二张 —— 宁可多一张，不把格子塞满。
 *
 * 同一 BV / page / 参数在 7 天内直接复用缓存（SHOTS_DIR 只留最近 40 张）。
 * progress 是给终端看的，工具侧不传 —— 数据一律走返回值。
 */
export async function shots(opts) {
    const bvid = String(opts.bvid ?? '').trim();
    if (!BV_RE.test(bvid))
        throw new BiliError('usage', '需要一个 BV 号', '形如 BV1xx411c7mD');
    const grid = String(opts.grid ?? '3x3');
    const m = /^(\d)x(\d)$/.exec(grid);
    const cols = Number(m?.[1]);
    const rows = Number(m?.[2]);
    if (!m || cols < 1 || rows < 1 || cols > 6 || rows > 6) {
        throw new BiliError('usage', '--grid 要写成 3x3 / 4x4 这样（每边 1–6 格）');
    }
    const capacity = cols * rows;
    const p = Math.max(1, Math.trunc(finiteOr(opts.page, 1)));
    const at = opts.at?.length ? [...new Set(opts.at)].sort((a, b) => a - b) : undefined;
    const range = opts.range;
    if (at && range)
        throw new BiliError('usage', '--at 和 --range 只能给一个', '整条就 --grid；某几秒就 --at；某一段就 --range');
    if (at && opts.diff)
        throw new BiliError('usage', '--diff 只用于 --range', '--at 给的时刻本来就是你挑的');
    if (at && opts.fps !== undefined)
        throw new BiliError('usage', '--fps 只用于 --range');
    if (opts.diff && !range)
        throw new BiliError('usage', '--diff 要配 --range', '先圈一段，再只留画面变过的帧');
    if (opts.fps !== undefined && !range)
        throw new BiliError('usage', '--fps 只用于 --range');
    const mode = at ? 'at' : range ? 'range' : 'grid';
    const fps = range && (opts.diff || opts.fps !== undefined) ? (opts.fps ?? 2) : undefined;
    if (fps !== undefined && (!Number.isFinite(fps) || fps < 1 || fps > 5)) {
        throw new BiliError('usage', '--fps 要在 1–5 之间', '区间不长，2 帧/秒通常够了');
    }
    const ignoreBottom = opts.diffIgnoreBottom ?? 0;
    if (ignoreBottom !== 0) {
        if (!opts.diff)
            throw new BiliError('usage', '--diff-ignore-bottom 只配 --diff', '它只影响「画面变没变」的判断，不影响取帧');
        if (!Number.isFinite(ignoreBottom) || ignoreBottom <= 0 || ignoreBottom > 0.9) {
            throw new BiliError('usage', '--diff-ignore-bottom 要在 0–0.9 之间', '0.15 = 忽略画面最下面 15%（字幕常在那）');
        }
    }
    const crop = opts.crop;
    if (crop) {
        const [x, y, w, h] = crop;
        const ok = [x, y, w, h].every((n) => Number.isFinite(n))
            && x >= 0 && y >= 0 && w >= 0.01 && h >= 0.01 && x + w <= 1.0001 && y + h <= 1.0001;
        if (!ok)
            throw new BiliError('usage', 'crop 要写成 x,y,w,h（0–1 的相对坐标）', '例：0.62,0.06,0.36,0.30');
    }
    const useCache = !opts.outDir;
    const cacheKey = createHash('sha1').update(JSON.stringify({
        v: SHOTS_CACHE_VERSION,
        bvid,
        page: p,
        grid,
        mode,
        at: at ? at.map((t) => t.toFixed(2)).join(',') : '',
        range: range ? `${range.fromSec.toFixed(2)}-${range.toSec.toFixed(2)}` : '',
        fps: fps ?? 0,
        diff: !!opts.diff,
        diffIgnoreBottom: ignoreBottom,
        crop: crop ? crop.map((n) => n.toFixed(3)).join(',') : '',
    })).digest('hex');
    if (useCache) {
        const hit = readShotsCache(cacheKey);
        if (hit)
            return hit;
    }
    let ff;
    try {
        ff = requireFfmpeg();
    }
    catch (e) {
        throw new BiliError('unsupported', msg(e), '装 ffmpeg：winget / brew / apt install ffmpeg，或用 $FFMPEG 指路径');
    }
    const credential = cred();
    const v = await getView(bvid, credential);
    const pages = Array.isArray(v.pages) && v.pages.length ? v.pages : [v];
    const page = pages[p - 1];
    if (!page?.cid)
        throw new BiliError('usage', `这条只有 ${pages.length} P`, `--p 最多到 ${pages.length}`);
    const dur = Number(page.duration) || Number(v.duration) || 0;
    if (dur < 1)
        throw new BiliError('unsupported', '拿不到视频时长（互动视频 / 直播回放）—— 抽不了帧');
    const play = await getPlayUrl(bvid, page.cid, credential);
    // 多段视频（老的长视频）只有第一段能抽 —— 把时间点压缩到这一段里，别在后半段白等
    const span = play.seconds > 1 ? Math.min(dur, play.seconds) : dur;
    const truncatedAtSec = play.segments > 1 ? span : undefined;
    const maxT = Math.max(0, span - 0.2);
    // ── 计划时间点 ──
    let planned = [];
    if (at) {
        planned = [...at];
        if (planned.length > MAX_CANDIDATES) {
            throw new BiliError('usage', `一次最多 ${MAX_CANDIDATES} 个时间点`, '分几次抽，或用 --range');
        }
        const bad = planned.find((t) => !Number.isFinite(t) || t < 0 || t >= span);
        if (bad !== undefined) {
            throw new BiliError('usage', `时间点 ${formatClock(bad)} 超出可抽范围 00:00–${formatClock(span)}`, play.segments > 1 ? '多条分段的老视频只抽第一段 —— 这个时间点之后抽不到' : '换个时间点');
        }
    }
    else if (range) {
        const from = Math.max(0, range.fromSec);
        const to = Math.min(span, range.toSec);
        if (!(from < to)) {
            throw new BiliError('usage', `--range 超出可抽范围（00:00–${formatClock(span)}）`, '起点要早于终点，且落在视频里');
        }
        if (fps !== undefined) {
            const step = 1 / fps;
            const out = [];
            for (let t = from + step / 2; t < to; t += step)
                out.push(Math.min(Math.max(0, to - 0.01), t));
            if (out.length > MAX_CANDIDATES) {
                // 上限是「候选帧数」，所以把两条出路都算成具体数：帧率降到多少，或区间缩到几秒
                const durSec = to - from;
                const maxFps = MAX_CANDIDATES / durSec;
                const maxSec = Math.floor(MAX_CANDIDATES / fps);
                const hint = maxFps >= 1
                    ? `降到 ${Number(maxFps.toFixed(1))}fps 以内，或把区间缩到 ${maxSec} 秒以内（现在 ${Math.round(durSec)} 秒）`
                    : `这段就算 1fps 也要 ${Math.ceil(durSec)} 帧 —— 把区间缩到 ${maxSec} 秒以内，或改用 --at 点几个时刻`;
                throw new BiliError('usage', `区间 ${formatClock(from)}–${formatClock(to)}（${Math.round(durSec)} 秒）× ${fps}fps = ${out.length} 帧，超过 ${MAX_CANDIDATES} 帧上限`, hint);
            }
            planned = out;
        }
        else {
            planned = Array.from({ length: capacity }, (_, i) => Math.min(Math.max(0, to - 0.01), from + ((i + 0.5) * (to - from)) / capacity));
        }
    }
    else {
        // 每格取「该格时间窗的中点」：开头常是黑场/片头，结尾常是黑场，掐头去尾各半格
        planned = Array.from({ length: capacity }, (_, i) => Math.min(maxT, Math.max(0, ((i + 0.5) * span) / capacity)));
    }
    opts.progress?.({
        stage: 'plan',
        title: String(v.title ?? ''),
        up: v.owner?.name ? String(v.owner.name) : undefined,
        durationSec: dur,
        page: p,
        quality: play.quality,
        segments: play.segments,
        spanSec: span,
        times: planned,
        mode,
        range: range ? { fromSec: Math.max(0, range.fromSec), toSec: Math.min(span, range.toSec) } : undefined,
        fps,
        diff: !!opts.diff,
        diffIgnoreBottom: ignoreBottom || undefined,
        candidates: planned.length,
    });
    // 格子尺寸跟画面（裁切后）比例走；竖屏就 360×640，裁一块就按裁切后的比例
    const dw = Number(v.dimension?.width) || 16;
    const dh = Number(v.dimension?.height) || 9;
    const ar = crop ? (dw * crop[2]) / (dh * crop[3]) : dw / dh;
    const base = 640;
    const cw = even(ar >= 1 ? base : base * ar);
    const ch = even(ar >= 1 ? base / ar : base);
    // 格号条在取帧时就 pad 出来：这样画字成不成功，每格尺寸都一样（拼图要求等大），
    // 画上去也只占黑边，不压画面
    const caps = ffmpegCaps(ff);
    const font = caps.drawtext ? findFfmpegFont() : null;
    let labels = !!font;
    const label = labels && font ? labelMetrics(cw) : null;
    const chp = ch + (label?.height ?? 0);
    const scalePad = [
        ...(crop
            ? [`crop=trunc(iw*${crop[2].toFixed(4)}/2)*2:trunc(ih*${crop[3].toFixed(4)}/2)*2:trunc(iw*${crop[0].toFixed(4)}/2)*2:trunc(ih*${crop[1].toFixed(4)}/2)*2`]
            : []),
        `scale=${cw}:${ch}:force_original_aspect_ratio=decrease:flags=lanczos`,
        `pad=${cw}:${chp}:(ow-iw)/2:${label ? label.height : '(oh-ih)/2'}:color=black`,
    ].join(',');
    const headers = `Referer: https://www.bilibili.com/\r\nUser-Agent: ${UA}\r\n`;
    const outDir = opts.outDir ? path.resolve(opts.outDir) : SHOTS_DIR;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);
    const stem = `${bvid}${p > 1 ? `-p${p}` : ''}-${stamp}-${cols}x${rows}`;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-shots-'));
    try {
        // ── 取帧（4 路并发；一帧失败重试一次，仍失败就留黑格）──
        const extract = async (t, file) => {
            let last = '';
            for (let attempt = 1; attempt <= FRAME_ATTEMPTS; attempt += 1) {
                if (opts.signal?.aborted)
                    throw new BiliError('unsupported', '抽帧被取消');
                try {
                    await runFfmpegAsync(ff, [
                        '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
                        '-headers', headers, '-ss', t.toFixed(2), '-i', play.url,
                        '-frames:v', '1', '-vf', scalePad, '-q:v', '2', file,
                    ], { timeout: 120_000, signal: opts.signal });
                    if (fs.existsSync(file) && fs.statSync(file).size >= 1000)
                        return { ok: true };
                    last = `${formatClock(t)} 这一帧没抽出来`;
                }
                catch (e) {
                    if (isFfmpegAbort(e))
                        throw new BiliError('unsupported', '抽帧被取消');
                    last = msg(e);
                    if (last.includes('超时'))
                        break;
                }
                fs.rmSync(file, { force: true });
            }
            return { ok: false, error: last };
        };
        let done = 0;
        const extracted = await mapLimit(planned, FRAME_CONCURRENCY, async (t, i) => {
            const file = path.join(tmp, `c${String(i).padStart(2, '0')}.jpg`);
            const r = await extract(t, file);
            done += 1;
            opts.progress?.({ stage: 'frame', done, total: planned.length });
            return { t, file: r.ok ? file : null, error: r.error };
        });
        const okFrames = extracted.flatMap((f) => (f.file ? [{ t: f.t, file: f.file }] : []));
        if (!okFrames.length) {
            const firstErr = extracted.find((f) => f.error)?.error;
            throw new BiliError('upstream', '一帧都没抽出来', firstErr ? `最后一次：${firstErr.slice(0, 160)}` : '换 --p / 稍后再试');
        }
        // ── 去重：先密抽，再只留画面真的变过的帧；时间码等选完再烧，免得文字差异干扰 SSIM ──
        let slots = [];
        let dropped;
        if (opts.diff) {
            const keep = [okFrames[0]];
            if (caps.ssim && okFrames.length > 1) {
                const pairs = okFrames.slice(1).map((f, i) => [okFrames[i], f]);
                const sims = await mapLimit(pairs, FRAME_CONCURRENCY, async ([a, b]) => ssimScore(ff, a.file, b.file, ignoreBottom, opts.signal));
                pairs.forEach(([, b], i) => {
                    const sim = sims[i];
                    if (sim === null || sim < DIFF_SSIM)
                        keep.push(b);
                });
            }
            else if (okFrames.length > 1) {
                keep.push(...okFrames.slice(1));
            }
            slots = keep.map((f) => ({ t: f.t, file: f.file }));
            dropped = planned.length - slots.length;
            opts.progress?.({
                stage: 'select', candidates: planned.length, kept: slots.length,
                dropped, missing: planned.length - okFrames.length,
            });
        }
        else {
            slots = extracted.map((f) => ({ t: f.t, file: f.file }));
        }
        const missingSec = extracted.filter((f) => !f.file).map((f) => f.t);
        // ── 格号 + 时间码 ──
        // 每张图从 1 数到格数（和返回的 timesSec 顺序一致）；先按格数分好张，
        // 才知道这一帧落到第几张、第几格。
        const sizes = sheetSizes(slots.length, capacity);
        const cellNo = new Array(slots.length);
        {
            let start = 0;
            for (const size of sizes) {
                for (let k = 0; k < size; k += 1)
                    cellNo[start + k] = k + 1;
                start += size;
            }
        }
        if (labels && font && label) {
            let labelFailed = false;
            const labelDir = path.join(tmp, 'label');
            fs.mkdirSync(labelDir, { recursive: true });
            slots = await mapLimit(slots, FRAME_CONCURRENCY, async (s, i) => {
                if (!s.file)
                    return s;
                const dst = path.join(labelDir, `l${String(i).padStart(2, '0')}.jpg`);
                try {
                    await runFfmpegAsync(ff, [
                        '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
                        '-i', s.file, '-frames:v', '1', '-vf', labelVf(font, cellNo[i], s.t, label.size), '-q:v', '2', dst,
                    ], { timeout: 30_000, signal: opts.signal });
                    if (fs.existsSync(dst) && fs.statSync(dst).size >= 1000)
                        return { t: s.t, file: dst };
                }
                catch (e) {
                    if (isFfmpegAbort(e))
                        throw new BiliError('unsupported', '抽帧被取消');
                }
                labelFailed = true;
                return s;
            });
            labels = !labelFailed;
        }
        // ── 拼图：按格数分张，超过就出第二张；缺的格用黑图补 ──
        fs.mkdirSync(outDir, { recursive: true });
        const black = path.join(tmp, 'black.jpg');
        await runFfmpegAsync(ff, [
            '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
            '-f', 'lavfi', '-i', `color=c=black:s=${cw}x${chp}:d=1`,
            '-frames:v', '1', '-q:v', '2', black,
        ], { timeout: 30_000, signal: opts.signal });
        const sheets = [];
        let cursor = 0;
        for (let s = 0; s < sizes.length; s += 1) {
            const chunk = slots.slice(cursor, cursor + sizes[s]);
            cursor += sizes[s];
            const dir = path.join(tmp, `sheet${s}`);
            fs.mkdirSync(dir, { recursive: true });
            for (let k = 0; k < capacity; k += 1) {
                fs.copyFileSync(chunk[k]?.file ?? black, path.join(dir, `f${String(k).padStart(2, '0')}.jpg`));
            }
            const file = path.join(outDir, `${stem}${sizes.length > 1 ? `-${s + 1}of${sizes.length}` : ''}.jpg`);
            await runFfmpegAsync(ff, [
                '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
                '-i', path.join(dir, 'f%02d.jpg'), '-vf', `tile=${cols}x${rows}`, '-frames:v', '1', '-q:v', '2', file,
            ], { timeout: 60_000, signal: opts.signal });
            if (!fs.existsSync(file))
                throw new BiliError('upstream', '拼图没生成', '换 --grid 少抽几帧再试');
            sheets.push({ path: file, timesSec: chunk.map((f) => f.t) });
        }
        const result = {
            bvid,
            title: String(v.title ?? ''),
            up: v.owner?.name ? String(v.owner.name) : undefined,
            path: sheets[0].path,
            paths: sheets.map((s) => s.path),
            sheets,
            cols,
            rows,
            cellWidth: cw,
            /** 含顶部格号条（没有格号条时 = 画面高） */
            cellHeight: chp,
            labelHeight: label?.height,
            timesSec: sheets.flatMap((s) => s.timesSec),
            mode,
            range: range ? { fromSec: Math.max(0, range.fromSec), toSec: Math.min(span, range.toSec) } : undefined,
            fps,
            diff: opts.diff ? true : undefined,
            diffIgnoreBottom: ignoreBottom || undefined,
            candidates: fps !== undefined ? planned.length : undefined,
            dropped,
            labels,
            missingSec,
            quality: play.quality,
            page: p,
            pageCount: pages.length,
            durationSec: dur,
            segments: play.segments,
            truncatedAtSec,
        };
        if (useCache) {
            writeShotsCache(cacheKey, result);
            pruneShots();
        }
        return result;
    }
    finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}
/** 收件箱条目（时间倒序）；翻到看过的水位就停，别为几条消息把请求打满 */
async function pullInbox(kind, credential, since, pages = 2) {
    const rows = [];
    let cursor = '';
    for (let p = 0; p < pages; p += 1) {
        const [page] = await getMsgFeed(kind, credential, { cursor, pages: 1 });
        const items = page?.items ?? [];
        if (!items.length)
            break;
        rows.push(...items);
        const times = items.map((x) => Number(x.reply_time ?? x.at_time ?? 0)).filter((t) => t > 0);
        const oldest = times.length ? Math.min(...times) : 0;
        cursor = String(page?.cursor?.id ?? '');
        if (!cursor || page?.cursor?.is_end)
            break;
        if (since && oldest && oldest < since)
            break;
    }
    return rows;
}
/** 一条通知 → 可回的形状。动态 / 专栏 / 音频的 @ 直接丢掉（lite 只回视频评论） */
function toInboxEntry(kind, row) {
    const it = row.item ?? {};
    const bvid = (String(it.uri ?? '').match(/BV[0-9A-Za-z]{10}/) ?? [''])[0];
    const aid = Number(it.subject_id ?? 0);
    if (!bvid || !aid)
        return null;
    const t = Number(row.reply_time ?? row.at_time ?? 0);
    // 「@我的」：source_content 就是那条评论；「回复我的」：正文以回读楼层为准（见 resolveReplyTarget），
    // 收件箱里 target_reply_content 只是线索 —— 官方字段语义没文档，别拿它当正文用
    const raw = kind === 'reply' ? it.target_reply_content : it.source_content;
    return {
        kind,
        id: String(row.id ?? `${t}:${row.user?.mid ?? ''}`),
        t,
        mid: String(row.user?.mid ?? ''),
        who: String(row.user?.nickname ?? row.user?.uname ?? '?'),
        bvid,
        aid,
        title: String(it.title ?? ''),
        text: String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
        source: Number(it.source_id ?? 0),
        // @ 通道的 source_id 就是 @ 我的那条评论，可以直接回；回复通道要回读楼层才知道
        rpid: kind === 'at' ? Number(it.source_id ?? 0) : 0,
        root: Number(it.root_id ?? 0),
    };
}
/** 「回复我的」→ 回读楼层，认准「他回我那条」的 rpid。认不出就留 0：挂错地方比不回更糟 */
async function resolveReplyTarget(e, credential) {
    const thread = e.root || e.source;
    if (!thread)
        return;
    try {
        const { root, replies } = await getThreadReplies(e.aid, thread, credential);
        const all = [...(root ? [root] : []), ...replies];
        const mine = all.filter((r) => String(r.mid ?? r.member?.mid ?? '') === e.mid);
        const hit = mine.find((r) => String(r.parent ?? '') === String(e.source))
            ?? [...mine].sort((a, b) => Number(b.ctime ?? 0) - Number(a.ctime ?? 0))[0];
        const rpid = Number(hit?.rpid ?? 0);
        if (!rpid)
            return;
        e.rpid = rpid;
        e.root = Number(hit?.root ?? thread) || thread;
        // 正文一律以楼层为准：收件箱那条只用来「发现有人找你」，说的话得回原帖读
        const said = String(hit?.content?.message ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
        if (said)
            e.text = said;
    }
    catch { /* 楼层读不到（删了 / 风控）：保持 rpid=0，让调用方自己去看 */ }
}
/**
 * 收件箱：谁 @ 了你 / 谁回了你。
 *
 * 发现靠官方两个收件箱（/x/msgfeed/reply 与 /at），但两者都不给「对方那条评论的 rpid」，
 * 正文语义也不可靠 ⇒ 回读楼层认「谁 + 父评论」，认不出就留空（挂错地方比不回更糟）。
 *
 * 副作用（本层的责任，别上移）：把列出来的标记已读、推进两个收件箱的时间水位。
 * 所以「调一次就消耗掉了」—— 想重复看同一批要显式 includeSeen。
 */
export async function inbox(opts = {}) {
    const n = clamp(Math.trunc(finiteOr(opts.limit, 5)), 1, 20);
    const all = opts.includeSeen === true;
    const credential = cred();
    const miss = ['sessdata', 'bili_jct'].filter((k) => !credential[k]);
    if (miss.length) {
        throw new BiliError('credential', `凭据缺 ${miss.join(', ')} —— 收件箱要登录态`, '去设置页「B站养鱼」补一次 cookie');
    }
    const st = readJson(INBOX_FILE, {});
    const since = { reply: Number(st.cursor?.reply ?? 0), at: Number(st.cursor?.at ?? 0) };
    // 串行：lib 的节流是全局的，并发两条只会一起撞 412
    const replyRows = await pullInbox('reply', credential, since.reply);
    const atRows = await pullInbox('at', credential, since.at);
    const entries = [
        ...replyRows.map((r) => toInboxEntry('reply', r)),
        ...atRows.map((r) => toInboxEntry('at', r)),
    ].filter((x) => x !== null);
    const byKey = new Map();
    for (const e of entries)
        byKey.set(`${e.kind}:${e.id}`, e); // 同一收件箱翻页会给回重叠条目（实测每条两遍）
    const merged = [...byKey.values()].sort((a, b) => b.t - a.t);
    const seen = st.seen ?? {};
    const fresh = merged.filter((e) => !seen[`${e.kind}:${e.id}`]);
    const shown = (all ? merged : fresh).slice(0, n);
    // 只对真要展示的几条回读楼层，别为全量付请求
    for (const e of shown)
        if (e.kind === 'reply')
            await resolveReplyTarget(e, credential);
    // ── 落盘：已读 + 水位（列出来的才算看过；--all 也照记）──
    const nextSeen = { ...seen };
    for (const e of shown)
        nextSeen[`${e.kind}:${e.id}`] = Date.now();
    // 只按条数裁：给「看过」加保质期会让老消息以 [新] 复现（假信号），而更老的条目早被 cursor 的两页窗口挡在外面了
    const kept = Object.entries(nextSeen).slice(-1000);
    const maxT = (rows) => rows.reduce((m, r) => Math.max(m, Number(r.reply_time ?? r.at_time ?? 0)), 0);
    writeJson(INBOX_FILE, {
        seen: Object.fromEntries(kept),
        cursor: { reply: Math.max(since.reply, maxT(replyRows)), at: Math.max(since.at, maxT(atRows)) },
    });
    return {
        // 两个数分开：「新的」是拉到的里面没见过的几条，不是本次列了几条
        // （合成一个数会让人以为跑一次就清完了，实际得跑四趟）
        fresh: fresh.length,
        total: merged.length,
        shown: shown.length,
        remaining: (all ? merged.length : fresh.length) - shown.length,
        messages: shown.map((e) => ({
            kind: e.kind,
            id: e.id,
            atSec: e.t,
            seen: !!seen[`${e.kind}:${e.id}`],
            from: { mid: e.mid, name: e.who },
            bvid: e.bvid,
            title: e.title,
            text: e.text,
            replyTo: e.rpid ? { rpid: e.rpid, root: e.root || undefined } : undefined,
        })),
    };
}
export async function comment(opts) {
    const bvid = String(opts.bvid ?? '').trim();
    const message = String(opts.message ?? '');
    if (!BV_RE.test(bvid))
        throw new BiliError('usage', '需要一个 BV 号', '形如 BV1xx411c7mD');
    if (!message.trim())
        throw new BiliError('usage', '正文不能为空');
    if (opts.mode !== 'dry' && opts.mode !== 'go')
        throw new BiliError('usage', '写操作必须显式 dry 或 go', '先 dry 看一眼，再 go 真发');
    // 回复：parent 是要回的那条评论，root 是楼层根（不填 = 它自己就是根）
    const parent = opts.reply ? Number(opts.reply.rpid) : 0;
    const threadRoot = opts.reply?.root === undefined ? 0 : Number(opts.reply.root);
    if (parent && (!Number.isFinite(parent) || parent <= 0))
        throw new BiliError('usage', '--reply 要填 rpid（纯数字，从 inbox 里抄）');
    if (threadRoot && !parent)
        throw new BiliError('usage', '--root 只在和 --reply 一起用时才有意义');
    if (threadRoot && (!Number.isFinite(threadRoot) || threadRoot <= 0))
        throw new BiliError('usage', '--root 要填根评论的 rpid（纯数字）');
    const actualRoot = parent ? (threadRoot || parent) : 0;
    // ── 护栏：顺序不能改（分享 → 额度 → 判重 → 内容规则）──
    const cfg = config();
    if (cfg.share?.enabled === false)
        throw new BiliError('guard', '分享已在设置里关闭（share.enabled=false）→ 这次不发（看视频 / 写日记照常）');
    const limit = Math.max(0, Number(cfg.quota?.writeDaily ?? DEFAULTS.quota.writeDaily));
    const wrote = writesToday();
    if (wrote.length >= limit)
        throw new BiliError('guard', `今天的写额度用完了（${wrote.length}/${limit}）`, '明天再说 —— 克制是功能，不是 bug');
    // 判重键：发新评论按 BV 号，回别人按那条评论的 rpid（同一视频下可以分别回不同的人）
    if (parent) {
        if (repliedWithin(parent))
            throw new BiliError('guard', `这条评论 7 天内已经回过（rpid ${parent}）`, '同一句话回两遍像刷屏');
    }
    else if (commentedWithin(bvid)) {
        throw new BiliError('guard', '这个视频 7 天内已经评过', '判重按 BV 号算；要回别人的评论用 reply');
    }
    if (message.includes('@')) {
        throw new BiliError('usage', '共用账号不需要、也不应该 @ 任何人（@ 的是别人的粉丝，不是主人）', '去掉正文里的 @ 再发');
    }
    if (message.length > 500)
        throw new BiliError('usage', `正文 ${message.length} 字 —— 太长了，像刷屏`, '压到 500 字以内');
    const credential = cred();
    const miss = ['sessdata', 'bili_jct'].filter((k) => !credential[k]);
    if (miss.length)
        throw new BiliError('credential', `凭据缺 ${miss.join(', ')} —— 写操作必须要`, '去设置页「B站养鱼」补一次 cookie');
    const v = await getView(bvid, credential);
    const body = { type: '1', oid: String(v.aid), message, plat: '1', csrf: credential.bili_jct };
    if (parent) {
        body.root = String(actualRoot);
        body.parent = String(parent);
    }
    const referer = `https://www.bilibili.com/video/${bvid}/`;
    const url = 'https://api.bilibili.com/x/v2/reply/add';
    const plan = {
        url, method: 'POST', referer,
        form: { ...body, csrf: '***' },
        account: cfg.self?.name ? String(cfg.self.name) : undefined,
        counted: true,
        usedToday: wrote.length,
        limit,
        remainingAfter: Math.max(0, limit - wrote.length - 1),
    };
    const object = {
        bvid,
        title: String(v.title ?? ''),
        aid: Number(v.aid ?? 0),
        replyTo: parent ? { rpid: parent, root: threadRoot || undefined } : undefined,
    };
    if (opts.mode === 'dry')
        return { kind: 'dry', plan, object };
    // --go：先校验登录态（cookie 失效就别浪费额度）
    const nav = await apiGet('https://api.bilibili.com/x/web-interface/nav', { cred: credential });
    if (nav.code !== 0 || nav.data?.isLogin !== true) {
        throw new BiliError('auth', `登录态失效：${explainCode(nav.code)}`, '重抄 cookie 再来');
    }
    const j = await apiPost(url, body, { cred: credential, referer });
    if (Number(j.code) !== 0) {
        throw new BiliError('upstream', `${parent ? '回复' : '发送'}失败：${explainCode(j.code)}${j.message ? `（B站原文：${j.message}）` : ''}`);
    }
    const newRpid = Number(j.data?.rpid ?? 0) || undefined;
    ledgerAppend({
        type: 'comment', bvid, target: `BV:${bvid}`, note: message.slice(0, 60), newRpid,
        ...(parent ? { rpid: parent, root: actualRoot } : {}),
    });
    return { kind: 'done', object, rpid: newRpid, usedToday: wrote.length + 1, limit, account: loginOf(nav) };
}
export async function interact(opts) {
    const target = String(opts.target ?? '').trim();
    const action = opts.action;
    const undo = opts.undo === true;
    if (action !== 'like' && action !== 'follow')
        throw new BiliError('usage', '一次只做一件事：like 或 follow');
    if (opts.mode !== 'dry' && opts.mode !== 'go')
        throw new BiliError('usage', '写操作必须显式 dry 或 go', '先 dry 看一眼，再 go 真做');
    const isBv = BV_RE.test(target);
    if (!isBv && !(action === 'follow' && /^\d{1,12}$/.test(target))) {
        throw new BiliError('usage', `目标要写成 BV 号${action === 'follow' ? '（或直接写 UP 的 UID）' : ''}`);
    }
    const cfg = config();
    if (cfg.share?.enabled === false)
        throw new BiliError('guard', '分享已在设置里关闭（share.enabled=false）→ 这次不做（看视频 / 写日记照常）');
    const credential = cred();
    const miss = ['sessdata', 'bili_jct'].filter((k) => !credential[k]);
    if (miss.length)
        throw new BiliError('credential', `凭据缺 ${miss.join(', ')} —— 写操作必须要`, '去设置页「B站养鱼」补一次 cookie');
    // 视频类互动要拿 aid（点赞接口只认 aid）与 UP 的 mid（关注）；只读，dry 也要这一步
    const v = isBv ? await getView(target, credential) : {};
    const fid = action !== 'follow' ? '' : (isBv ? String(v.owner?.mid ?? '') : target);
    if (action === 'follow' && !fid)
        throw new BiliError('notfound', '拿不到 UP 的 mid', '用 UID 直接关注');
    if (action === 'follow' && String(cfg.self?.mid ?? '') === fid) {
        throw new BiliError('usage', '这是你自己（与主人共用的号）—— 不能关注自己');
    }
    const key = action === 'follow' ? `uid:${fid}` : target;
    const limit = Math.max(0, Number(cfg.quota?.interactDaily ?? DEFAULTS.quota.interactDaily));
    const acted = interactionsToday();
    if (!undo) {
        if (acted.length >= limit)
            throw new BiliError('guard', `今天的互动额度用完了（${acted.length}/${limit}）`, '明天再说 —— 克制是功能，不是 bug');
        if (interactedWithin(key, action)) {
            throw new BiliError('guard', `这个${action === 'follow' ? ' UP' : '视频'} 7 天内已经${action === 'follow' ? '关注' : '点赞'}过`, `判重按 ${action === 'follow' ? 'mid' : 'BV 号'}算`);
        }
    }
    let url;
    let body;
    if (action === 'like') {
        url = 'https://api.bilibili.com/x/web-interface/archive/like';
        body = { aid: String(v.aid), like: undo ? '2' : '1', csrf: credential.bili_jct };
    }
    else {
        url = 'https://api.bilibili.com/x/relation/modify';
        body = { fid, act: undo ? '2' : '1', re_src: '11', csrf: credential.bili_jct };
    }
    const referer = isBv ? `https://www.bilibili.com/video/${target}/` : 'https://space.bilibili.com/';
    const plan = {
        url, method: 'POST', referer,
        form: { ...body, csrf: '***' },
        account: cfg.self?.name ? String(cfg.self.name) : undefined,
        counted: !undo,
        usedToday: acted.length,
        limit,
        remainingAfter: undo ? Math.max(0, limit - acted.length) : Math.max(0, limit - acted.length - 1),
    };
    const object = {
        kind: (isBv ? 'video' : 'user'),
        bvid: isBv ? target : undefined,
        mid: action === 'follow' ? fid : undefined,
        title: isBv ? String(v.title ?? '') : undefined,
        upName: isBv && action === 'follow' ? (v.owner?.name ? String(v.owner.name) : undefined) : undefined,
    };
    if (opts.mode === 'dry')
        return { kind: 'dry', plan, object };
    // --go：先校验登录态（cookie 失效就别白发一次写请求）
    const nav = await apiGet('https://api.bilibili.com/x/web-interface/nav', { cred: credential });
    if (nav.code !== 0 || nav.data?.isLogin !== true) {
        throw new BiliError('auth', `登录态失效：${explainCode(nav.code)}`, '重抄 cookie 再来');
    }
    if (action === 'follow' && String(nav.data.mid) === fid) {
        throw new BiliError('usage', '这是你自己（与主人共用的号）—— 不能关注自己');
    }
    const j = await apiPost(url, body, { cred: credential, referer });
    if (Number(j.code) !== 0) {
        throw new BiliError('upstream', `${undo ? '取消' : ''}${action === 'follow' ? '关注' : '点赞'}失败：${explainCode(j.code)}${j.message ? `（B站原文：${j.message}）` : ''}`);
    }
    ledgerAppend({ type: 'interact', action, undo: undo || undefined, target: key, bvid: isBv ? target : undefined, note: `${undo ? '取消' : ''}${action === 'follow' ? '关注' : '点赞'} ${isBv ? target : fid}` });
    return { kind: 'done', object, counted: !undo, usedToday: undo ? acted.length : acted.length + 1, limit, account: loginOf(nav) };
}
/** nav 回执 → 登录态摘要（两个写操作都要报一句「登录态 ✓ 谁」） */
function loginOf(nav) {
    if (!nav.data?.uname)
        return undefined;
    return { name: String(nav.data.uname), mid: String(nav.data.mid ?? '') };
}
/** 同步：只碰本地 json，不发请求 */
export function schedule(cmd) {
    if (cmd.action === 'add') {
        let added;
        try {
            added = addEntry({
                at: cmd.at,
                daily: cmd.daily,
                every: cmd.every,
                label: cmd.label,
                forDays: cmd.forDays === undefined ? undefined : String(cmd.forDays),
            });
        }
        catch (e) {
            throw new BiliError('usage', msg(e));
        }
        return {
            action: 'add',
            entry: entryView(added.entry),
            note: added.note ?? undefined,
            pending: readPlan().entries.length,
            maxPending: MAX_PENDING,
        };
    }
    if (cmd.action === 'list') {
        const p = readPlan();
        return {
            action: 'list',
            entries: [...p.entries]
                .sort((a, b) => Date.parse(a.nextDue) - Date.parse(b.nextDue))
                .map(entryView),
            fired: p.fired.slice(-5).reverse().map((f) => ({ at: f.at, id: f.id, label: f.label })),
            pending: p.entries.length,
            maxPending: MAX_PENDING,
        };
    }
    if (cmd.action === 'drop') {
        const id = String(cmd.id ?? '').trim();
        if (!id)
            throw new BiliError('usage', '要给 id', 'schedule list 看 id');
        if (!dropEntry(id))
            throw new BiliError('notfound', `没有 [${id}] 这条`, 'schedule list 对一眼');
        return { action: 'drop', id, pending: readPlan().entries.length, maxPending: MAX_PENDING };
    }
    const removed = clearPlan();
    return { action: 'clear', removed, pending: readPlan().entries.length, maxPending: MAX_PENDING };
}
/** ScheduleEntry → 对外的视图（两个格式化函数借自 lib/schedule，理由见类型注释） */
function entryView(e) {
    return {
        id: e.id,
        label: e.label,
        kind: e.kind,
        whenText: fmtWhen(e),
        nextDue: e.nextDue,
        fires: Number(e.fires) || 0,
        createdAt: e.createdAt,
        expiresAt: e.expiresAt,
        forDays: e.forDays,
        expiryText: expiryText(e) ?? undefined,
    };
}
/**
 * 账本与口味回顾。两者是同一份数据（ledger.json）的两个视角，合成一个 op 是因为
 * 它们共享「读账本 + 按天切」这层，合并后设置页与工具都只面对一个入口。
 *
 * 纯本地：不发请求，也不需要凭据。
 */
export function history(q) {
    if (q.kind === 'ledger') {
        const led = readLedger();
        const limit = Math.max(0, Number(config().quota?.writeDaily ?? DEFAULTS.quota.writeDaily));
        const ilimit = Math.max(0, Number(config().quota?.interactDaily ?? DEFAULTS.quota.interactDaily));
        const banned = banUntil();
        return {
            kind: 'ledger',
            day: today(),
            written: writesToday().map((x) => ({ at: x.at, type: x.type, bvid: x.bvid, note: x.note, title: x.title })),
            writeLimit: limit,
            interacted: interactionsToday().map((x) => ({ at: x.at, action: x.action, note: x.note })),
            interactLimit: ilimit,
            watchedToday: led.log
                .filter((x) => x.type === 'watch' && new Date(x.at).toLocaleDateString('sv-SE') === today())
                .map((x) => String(x.bvid ?? '')),
            ban: banned > Date.now() ? { untilMs: banned, reason: banWhy() } : undefined,
        };
    }
    const days = clamp(Math.trunc(finiteOr(q.days, 30)), 1, 3650);
    const lim = clamp(Math.trunc(finiteOr(q.limit, 15)), 1, 60);
    const log = readLedger().log;
    const since = Date.now() - days * 86_400_000;
    const recent = log.filter((x) => new Date(x.at).getTime() >= since);
    const watched = recent.filter((x) => x.type === 'watch');
    const comments = recent.filter((x) => x.type === 'comment');
    const acts = recent.filter((x) => x.type === 'interact' && !x.undo);
    const byAct = (a) => acts.filter((x) => x.action === a).length;
    // UP 只从新记录里有（watch.up 是后加的）；老记录只有标题，照样能读
    const ups = new Map();
    for (const x of watched)
        if (x.up)
            ups.set(x.up, (ups.get(x.up) ?? 0) + 1);
    // 标题索引取自整份账本：动过手的那条自己未必带标题
    const titles = new Map();
    for (const x of log)
        if (x.bvid && x.title)
            titles.set(x.bvid, x.title);
    return {
        kind: 'taste',
        days,
        totalEntries: log.length,
        earliestDay: log.length ? new Date(log[0].at).toLocaleDateString('sv-SE') : undefined,
        counts: { watched: watched.length, comments: comments.length, interactions: acts.length, likes: byAct('like'), follows: byAct('follow') },
        limit: lim,
        topUps: [...ups].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, count]) => ({ name, count })),
        recentWatched: watched.slice(-lim).reverse().map((x) => ({ at: x.at, bvid: String(x.bvid ?? ''), title: x.title, up: x.up })),
        touched: [...comments, ...acts]
            .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
            .slice(0, lim)
            .map((x) => ({
            at: x.at,
            kind: x.type === 'comment' ? 'comment' : 'interact',
            action: x.action,
            isReply: x.type === 'comment' ? !!x.rpid : undefined,
            note: x.note,
            bvid: x.bvid,
            title: x.bvid ? titles.get(x.bvid) : undefined,
        })),
    };
}
