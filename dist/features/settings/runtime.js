/**
 * 找一个真能跑 CLI 的运行时（settings feature 私有）。
 *
 * CLI 编译产物是普通 ESM（dist 目录下的 .js），Bun 与 Node 都能跑，所以按「先 bun、后 node」挑：
 *   · bun：$BUN → DSH_BUN → PATH → DSH 自带运行时 → 常见安装位置
 *   · node：$DSH_NODE → PATH → 常见安装位置（Electron 里 process.execPath 是主程序 ✗，要
 *     ELECTRON_RUN_AS_NODE=1 才肯执行脚本）
 * 两种都用「打印版本号」验证：Electron 当 app 跑时不会执行 -p/--version（只可能是空输出）✗
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
export function resolveRuntime() {
    const env = process.env;
    const isWin = process.platform === 'win32';
    const exe = (name) => (isWin ? name + '.exe' : name);
    const dshHome = env.DSH_HOME || path.join(os.homedir(), '.dsh');
    const fromDsh = (name) => {
        const out = [];
        try {
            for (const d of fs.readdirSync(path.join(dshHome, 'dsh-runtimes'))) {
                out.push(path.join(dshHome, 'dsh-runtimes', d, 'dependencies', name, 'bin', exe(name)));
                out.push(path.join(dshHome, 'dsh-runtimes', d, 'dependencies', 'node', 'bin', exe(name)));
            }
        }
        catch { }
        return out;
    };
    const onPath = (name) => String(env.PATH ?? '')
        .split(isWin ? ';' : ':').filter(Boolean).map((dir) => path.join(dir.replace(/^"|"$/g, ''), exe(name)));
    const probe = (file, extraEnv) => {
        try {
            const r = spawnSync(file, ['--version'], { env: extraEnv ?? env, encoding: 'utf8', timeout: 8000, windowsHide: true });
            return r.status === 0 && /\d+\.\d+/.test(String(r.stdout ?? '').trim());
        }
        catch {
            return false;
        }
    };
    const first = (cands) => {
        for (const file of [...new Set(cands.filter((f) => !!f))]) {
            try {
                if (fs.statSync(file).isFile() && probe(file))
                    return file;
            }
            catch { }
        }
        return null;
    };
    const bun = first([
        env.BUN, env.DSH_BUN, ...onPath('bun'), path.join(os.homedir(), '.bun', 'bin', exe('bun')),
        ...(isWin ? [] : ['/usr/local/bin/bun', '/opt/homebrew/bin/bun', '/usr/bin/bun']),
        ...fromDsh('bun'),
    ]);
    if (bun)
        return { exe: bun, kind: 'bun' };
    const node = first([
        env.DSH_NODE, env.DSH_DESKTOP_NODE_EXECUTABLE, ...onPath('node'), ...fromDsh('node'),
        ...(isWin ? [] : ['/usr/local/bin/node', '/usr/bin/node', '/opt/homebrew/bin/node']),
        ...(isWin && env.ProgramFiles ? [path.join(env.ProgramFiles, 'nodejs', exe('node'))] : []),
    ]);
    if (node)
        return { exe: node, kind: 'node' };
    if (process.versions.electron && probe(process.execPath, { ...env, ELECTRON_RUN_AS_NODE: '1' })) {
        return { exe: process.execPath, kind: 'node' };
    }
    return null;
}
