/**
 * ffmpeg —— 抽帧的唯一外部依赖（可选：只有 shots 用得到，其余功能不需要它）。
 *
 * 为什么单独一个文件：查找顺序要写死一处（$FFMPEG → PATH → 仓库 bin/ → ~/.dsh/bili-lite-work/bin/），
 * 找不到时给人话（装什么、怎么指路径），而不是让 agent 看到 ENOENT。
 * 不引 npm 包、不下载二进制 —— lite 只借用户机器上已有的那份。
 *
 * 调用一律走 runFfmpegAsync：抽帧要能并发、要能真的被打断（spawnSync 只能在
 * 两帧之间看 signal，已经起跑的那一帧只能干等）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from '../config/paths.js';
const EXE = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const isFile = (f) => {
    if (!f)
        return false;
    try {
        return fs.statSync(f).isFile();
    }
    catch {
        return false;
    }
};
function onPath() {
    for (const d of String(process.env.PATH ?? '').split(path.delimiter)) {
        if (!d)
            continue;
        const f = path.join(d, EXE);
        if (isFile(f))
            return f;
    }
    return null;
}
/** ffmpeg 在哪（找不到 = null）。顺序：$FFMPEG → PATH → 仓库 bin/ → ~/.dsh/bili-lite-work/bin/ */
export function ffmpegPath() {
    return [process.env.FFMPEG, onPath(), path.join(ROOT, 'bin', EXE), path.join(DATA_DIR, 'bin', EXE)]
        .find(isFile) ?? null;
}
/** 要路径，没有就抛「怎么办」（不是 ENOENT） */
export function requireFfmpeg() {
    const p = ffmpegPath();
    if (p)
        return p;
    throw new Error([
        '找不到 ffmpeg —— 只有「抽帧九宫格」要它，其余功能照常用。装一个或指个路径即可：',
        '  ① 装进 PATH：winget install ffmpeg（Windows）/ brew install ffmpeg（macOS）/ apt install ffmpeg（Linux）',
        '  ② 用环境变量指定：FFMPEG=/绝对/路径/ffmpeg',
        `  ③ 或者把它放到 ${path.join(DATA_DIR, 'bin', EXE)}`,
    ].join('\n'));
}
/** 体检（selftest 用）：能跑起来才算 ok */
export function ffmpegInfo() {
    const bin = ffmpegPath();
    if (!bin)
        return { ok: false, path: null, version: null };
    const r = spawnSync(bin, ['-hide_banner', '-version'], { encoding: 'utf8', timeout: 10_000 });
    const line = String(r.stdout ?? '').split('\n')[0].trim();
    return r.status === 0 && line ? { ok: true, path: bin, version: line } : { ok: false, path: bin, version: null };
}
const capsCache = new Map();
/** 这台机器上的 ffmpeg 带没带 drawtext / ssim（各查一次，进程内缓存）。查不到一律当没有 */
export function ffmpegCaps(bin) {
    const hit = capsCache.get(bin);
    if (hit)
        return hit;
    let caps = { drawtext: false, ssim: false };
    try {
        const r = spawnSync(bin, ['-hide_banner', '-filters'], { encoding: 'utf8', timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
        const s = String(r.stdout ?? '');
        caps = { drawtext: /\bdrawtext\b/.test(s), ssim: /\bssim\b/.test(s) };
    }
    catch { /* 保守：当作没有 */ }
    capsCache.set(bin, caps);
    return caps;
}
const FONT_CANDIDATES = {
    win32: ['C:\\Windows\\Fonts\\arial.ttf', 'C:\\Windows\\Fonts\\segoeui.ttf', 'C:\\Windows\\Fonts\\msyh.ttc'],
    darwin: ['/System/Library/Fonts/Supplemental/Arial.ttf', '/System/Library/Fonts/Helvetica.ttc', '/Library/Fonts/Arial.ttf'],
    linux: [
        '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
        '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
        '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
        '/usr/share/fonts/TTF/DejaVuSans.ttf',
        '/usr/share/fonts/dejavu/DejaVuSans.ttf',
        '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc',
        '/usr/share/fonts/Adwaita/AdwaitaSans-Regular.ttf',
    ],
};
/** Linux/macOS 上再兜底问一次 fontconfig（很多发行版把字体装在奇怪的位置） */
function fcMatchFont() {
    if (process.platform === 'win32')
        return null;
    try {
        const r = spawnSync('fc-match', ['-f', '%{file}', 'sans'], { encoding: 'utf8', timeout: 5_000 });
        const p = String(r.stdout ?? '').trim();
        return r.status === 0 && isFile(p) ? p : null;
    }
    catch {
        return null;
    }
}
let fontProbe = { done: false, path: null };
/** 找一款能画时间码的字体：$FFMPEG_FONT → 各平台常见路径 → fc-match；找不到 = null（图照抽，只是不烧码） */
export function findFfmpegFont() {
    if (isFile(process.env.FFMPEG_FONT))
        return process.env.FFMPEG_FONT;
    if (fontProbe.done)
        return fontProbe.path;
    const path = (FONT_CANDIDATES[process.platform] ?? []).find(isFile) ?? fcMatchFont();
    fontProbe = { done: true, path };
    return path;
}
/** 这次失败是不是「被调用方取消」—— 取消不该重试，也不该当成缺帧 */
export const isFfmpegAbort = (e) => e instanceof Error && e.message === 'ffmpeg 被取消';
/**
 * 异步跑一次 ffmpeg：支持并发与 AbortSignal（abort 时直接 kill 正在跑的子进程）。
 * 非零退出 / 超时 / 起不来都抛人话；stderr 只留尾部（SSIM 的结果也在这里）。
 */
export function runFfmpegAsync(bin, args, { timeout = 120_000, signal } = {}) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new Error('ffmpeg 被取消'));
            return;
        }
        const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        let settled = false;
        let timer;
        function finish(action) {
            if (settled)
                return;
            settled = true;
            if (timer)
                clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            action();
        }
        function onAbort() {
            child.kill('SIGKILL');
            finish(() => reject(new Error('ffmpeg 被取消')));
        }
        timer = setTimeout(() => {
            child.kill('SIGKILL');
            finish(() => reject(new Error(`ffmpeg 超时（${Math.round(timeout / 1000)}s）—— 视频太长或网络太慢，换个时间再抽`)));
        }, timeout);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) {
            onAbort();
            return;
        }
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (d) => { stderr = (stderr + d).slice(-8000); });
        child.on('error', (e) => finish(() => reject(new Error(`ffmpeg 起不来：${e.message}`))));
        child.on('close', (code, sig) => finish(() => {
            if (code === 0) {
                resolve({ stderr });
                return;
            }
            const tail = stderr.trim().split('\n').slice(-2).join(' ').slice(0, 240);
            reject(new Error(`ffmpeg 失败：${tail || '退出码 ' + code + (sig ? ` / ${sig}` : '')}`));
        }));
    });
}
