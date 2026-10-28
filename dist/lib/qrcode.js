/**
 * 极简二维码编码器（shared，纯函数零 IO）—— 只服务「扫码登录」这一个场景。
 * 支持范围按需裁剪：byte 模式 + 纠错级 L + version 1–8（最多 192 字节，登录 URL 最长 ~130 够用）。
 * 固定 mask 0 是合法的：解码器只认 format info 里写的 mask id，不要求选「最优」。
 * 算法按 ISO/IEC 18004 写死：GF(256) Reed-Solomon 纠错 + BCH(15,5)/(18,6) 保护码。
 * 渲染交给调用方：终端半块字符（qrTerminal）或宿主侧 SVG（qrSvg）。
 */
// ── GF(256)（本原多项式 0x11d）：乘法查表 ──────────────────────────────────
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100)
        x ^= 0x11d;
}
for (let i = 255; i < 512; i += 1)
    EXP[i] = EXP[i - 255];
const gmul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);
// ── 纠错级 L 的块结构：[块数, 每块数据码字, 每块纠错码字]（均匀块，交织简单）──
// 下标 = version-1；总码字 26/44/70/100/134/172/196/242 与 ISO 表一致
const RS_L = [
    [1, 19, 7], [1, 34, 10], [1, 55, 15], [1, 80, 20],
    [1, 108, 26], [2, 68, 18], [2, 78, 20], [2, 97, 24],
];
// 校正图形中心坐标（v2+；压在定位图形上的组合由调用处跳过）
const ALIGN = { 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42] };
const bchDigit = (n) => { let d = 0; while (n !== 0) {
    d += 1;
    n >>>= 1;
} return d; };
const G15 = 0x537;
const G15_MASK = 0x5412;
const G18 = 0x1f25;
/** format info：纠错级 L(01) + mask id → BCH(15,5) 再异或掩码 = 15 bit */
function formatBits(mask) {
    const data = (1 << 3) | mask;
    let d = data << 10;
    while (bchDigit(d) - bchDigit(G15) >= 0)
        d ^= G15 << (bchDigit(d) - bchDigit(G15));
    return ((data << 10) | d) ^ G15_MASK;
}
/** version info（v7+ 才需要）：BCH(18,6) */
function versionBits(v) {
    let d = v << 12;
    while (bchDigit(d) - bchDigit(G18) >= 0)
        d ^= G18 << (bchDigit(d) - bchDigit(G18));
    return (v << 12) | d;
}
/** RS 生成多项式系数（gen[0] 是最高次，恒为 1） */
function rsGen(n) {
    let g = [1];
    for (let i = 0; i < n; i += 1) {
        const next = new Array(g.length + 1).fill(0);
        for (let j = 0; j < g.length; j += 1) {
            next[j] ^= g[j];
            next[j + 1] ^= gmul(g[j], EXP[i]);
        }
        g = next;
    }
    return g;
}
/** 数据码字（尾部补 n 个 0）对生成多项式取余 → n 个纠错码字 */
function rsRemainder(words, gen) {
    const res = words.slice();
    for (let i = 0; i < words.length - (gen.length - 1); i += 1) {
        const f = res[i];
        if (f === 0)
            continue;
        for (let j = 0; j < gen.length; j += 1)
            res[i + j] ^= gmul(gen[j], f);
    }
    return res.slice(words.length - (gen.length - 1));
}
/** 比特流 → 码字：模式/长度/数据 + 终止符 + 补齐 + 0xEC/0x11 填充 + 每块纠错 + 交织 */
function codewords(bytes, v) {
    const [blocks, perBlock, ecN] = RS_L[v - 1];
    const bits = [];
    const push = (val, n) => { for (let i = n - 1; i >= 0; i -= 1)
        bits.push((val >>> i) & 1); };
    push(4, 4); // byte 模式指示
    push(bytes.length, 8); // 字符数（v1–9 固定 8 bit）
    for (const b of bytes)
        push(b, 8);
    const capBits = blocks * perBlock * 8;
    push(0, Math.min(4, capBits - bits.length)); // 终止符（放不下就短一点）
    while (bits.length % 8 !== 0)
        bits.push(0);
    const data = [];
    for (let i = 0; i < bits.length; i += 8)
        data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
    for (let pad = 0xec; data.length < blocks * perBlock; pad = pad === 0xec ? 0x11 : 0xec)
        data.push(pad);
    const gen = rsGen(ecN);
    const chunks = [];
    for (let b = 0; b < blocks; b += 1) {
        const d = data.slice(b * perBlock, (b + 1) * perBlock);
        chunks.push([...d, ...rsRemainder([...d, ...new Array(ecN).fill(0)], gen)]);
    }
    const out = []; // 先轮转数据段，再轮转纠错段
    for (let i = 0; i < perBlock; i += 1)
        for (const c of chunks)
            out.push(c[i]);
    for (let i = perBlock; i < perBlock + ecN; i += 1)
        for (const c of chunks)
            out.push(c[i]);
    return out;
}
/** 文本 → 二维码布尔矩阵（true=暗模块）。超过 192 字节直接抛错，不做多版本花活 */
export function qrMatrix(text) {
    const bytes = [...new TextEncoder().encode(String(text))];
    const vi = RS_L.findIndex(([blocks, perBlock]) => ((blocks * perBlock * 8 - 12) >> 3) >= bytes.length);
    if (vi < 0)
        throw new Error(`内容太长（${bytes.length} 字节）—— 这个编码器最多装 192 字节`);
    const v = vi + 1;
    const N = 17 + 4 * v;
    const m = Array.from({ length: N }, () => new Array(N).fill(null));
    // 定位图形（三个角）+ 一圈分隔符
    const finder = (r0, c0) => {
        for (let i = -1; i <= 7; i += 1)
            for (let j = -1; j <= 7; j += 1) {
                const r = r0 + i, c = c0 + j;
                if (r < 0 || r >= N || c < 0 || c >= N)
                    continue;
                m[r][c] = (i >= 0 && i <= 6 && (j === 0 || j === 6)) || (j >= 0 && j <= 6 && (i === 0 || i === 6)) || (i >= 2 && i <= 4 && j >= 2 && j <= 4);
            }
    };
    finder(0, 0);
    finder(0, N - 7);
    finder(N - 7, 0);
    // 校正图形：必须放在时序图形之前（压在时序线上的校正图形合法，时序要给它让路）；
    // 中心压在定位图形上的组合才跳过
    if (v >= 2)
        for (const r of ALIGN[v])
            for (const c of ALIGN[v]) {
                if (m[r][c] !== null)
                    continue;
                for (let i = -2; i <= 2; i += 1)
                    for (let j = -2; j <= 2; j += 1)
                        m[r + i][c + j] = Math.abs(i) === 2 || Math.abs(j) === 2 || (i === 0 && j === 0);
            }
    // 时序图形
    for (let i = 8; i < N - 8; i += 1) {
        if (m[i][6] === null)
            m[i][6] = i % 2 === 0;
        if (m[6][i] === null)
            m[6][i] = i % 2 === 0;
    }
    // format info（两份）+ 固定暗模块 + version info（v7+）—— 先写值，数据填充会绕开这些格
    const fb = formatBits(0);
    for (let i = 0; i < 15; i += 1) {
        const bit = ((fb >>> i) & 1) === 1;
        if (i < 6)
            m[i][8] = bit;
        else if (i < 8)
            m[i + 1][8] = bit;
        else
            m[N - 15 + i][8] = bit;
        if (i < 8)
            m[8][N - 1 - i] = bit;
        else if (i === 8)
            m[8][7] = bit;
        else
            m[8][14 - i] = bit;
    }
    m[N - 8][8] = true;
    if (v >= 7) {
        const vb = versionBits(v);
        for (let i = 0; i < 18; i += 1) {
            const bit = ((vb >>> i) & 1) === 1;
            m[(i / 3) | 0][i % 3 + N - 11] = bit;
            m[i % 3 + N - 11][(i / 3) | 0] = bit;
        }
    }
    // 数据 + mask 0（(x+y)%2===0 反转）：两列一组、从右往左之字形
    const cw = codewords(bytes, v);
    const total = cw.length * 8;
    let bi = 0;
    for (let right = N - 1; right >= 1; right -= 2) {
        if (right === 6)
            right = 5;
        const upward = ((right + 1) & 2) === 0;
        for (let t = 0; t < N; t += 1) {
            const y = upward ? N - 1 - t : t;
            for (let j = 0; j < 2; j += 1) {
                const x = right - j;
                if (m[y][x] !== null)
                    continue;
                let dark = bi < total ? ((cw[bi >>> 3] >>> (7 - (bi & 7))) & 1) === 1 : false;
                if ((x + y) % 2 === 0)
                    dark = !dark;
                m[y][x] = dark;
                bi += 1;
            }
        }
    }
    if (bi < total)
        throw new Error('二维码内部错误：数据没填满（版本选择 bug）');
    // v2–v6 各有 7 个余数位：规格留亮（解码器不读它们）
    for (const row of m)
        for (let x = 0; x < N; x += 1)
            if (row[x] === null)
                row[x] = false;
    return m;
}
/** 终端渲染：半块字符（一个字符两行模块）+ 黑码白底（\\x1b[30;47m），自带 4 模块静区 */
export function qrTerminal(m) {
    const N = m.length, B = 4, P = N + 2 * B;
    const dark = (y, x) => y >= B && y < B + N && x >= B && x < B + N && m[y - B][x - B] === true;
    const lines = [];
    for (let y = 0; y < P; y += 2) {
        let line = '';
        for (let x = 0; x < P; x += 1) {
            const t = dark(y, x), b = y + 1 < P && dark(y + 1, x);
            line += t && b ? '█' : t ? '▀' : b ? '▄' : ' ';
        }
        lines.push(`\x1b[30;47m${line}\x1b[0m`);
    }
    return lines.join('\n');
}
/** SVG（宿主给设置页 <img> 用）：白底黑码 + 4 模块静区，每个暗模块一个 path 子路径 */
export function qrSvg(m, scale = 8) {
    const N = m.length, B = 4, size = (N + 2 * B) * scale;
    let d = '';
    for (let y = 0; y < N; y += 1)
        for (let x = 0; x < N; x += 1) {
            if (m[y][x])
                d += `M${(x + B) * scale} ${(y + B) * scale}h${scale}v${scale}h-${scale}z`;
        }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
