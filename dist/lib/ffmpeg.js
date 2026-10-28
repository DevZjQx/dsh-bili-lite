/**
 * ffmpeg —— 抽帧的唯一外部依赖（可选：只有 shots 用得到，其余功能不需要它）。
 *
 * 为什么单独一个文件：查找顺序要写死一处（$FFMPEG → PATH → 仓库 bin/ → ~/.dsh/bili-lite-work/bin/），
 * 找不到时给人话（装什么、怎么指路径），而不是让 agent 看到 ENOENT。
 * 不引 npm 包、不下载二进制 —— lite 只借用户机器上已有的那份。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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
/** 跑一次 ffmpeg：非零退出/超时都抛人话（stderr 只留最后两行，别糊屏） */
export function runFfmpeg(bin, args, { timeout = 120_000 } = {}) {
    const r = spawnSync(bin, args, { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 });
    if (r.error?.code === 'ETIMEDOUT' || r.signal)
        throw new Error(`ffmpeg 超时（${Math.round(timeout / 1000)}s）—— 视频太长或网络太慢，换个时间再抽`);
    if (r.status !== 0) {
        const tail = String(r.stderr ?? r.error?.message ?? '').trim().split('\n').slice(-2).join(' ').slice(0, 240);
        throw new Error(`ffmpeg 失败：${tail || '退出码 ' + r.status}`);
    }
    return r;
}
