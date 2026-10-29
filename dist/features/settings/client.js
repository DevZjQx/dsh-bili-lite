/**
 * dsh-bili-lite —— 客户端半边：DSH「设置」里的 B 站分身 section（极简版）
 *
 * 数据流：section ⇄ /dsh-bili-lite/api/*（同源 fetch ✓）⇄ ~/.dsh/bili-lite-work/bili-lite.config.json
 * 与宿主读**同一份配置**（config/store 是唯一真相）✓ 不存在两套配置。
 * ⚠️ 输入框是先改在本地、点「保存」才落盘 —— 不点保存 = 什么都没发生 ✗
 *
 * 【结构例外（SKILL §10）】本文件必须单文件：DSH web 端的 __ModuleLoader__ 直接
 * 加载包导出 ./client 这一个文件（只提供 require("react")）。因此它不 import
 * 本 feature 的任何模块，feature.ts 也不 import 它 —— 两半靠同一份 API 契约
 * （/dsh-bili-lite/api/*）与 config/store 的键清单对齐。
 * 类型也是自带的：浏览器里没有 npm 的 @types/react，这里只声明用得到的那四个方法。
 *
 * ⚠️ 禁止顶层声明：DSH 把多个插件的 client.js **拼进同一个 combo 脚本**
 * （/plugins/??a/client.js,b/client.js）当普通脚本执行，顶层 const/let/function 落在同一个
 * 全局词法作用域里 —— 以前这里写 `const loader = window.__ModuleLoader__`，和另一个插件
 * 同样写法撞名，整个 combo 报 "Identifier 'loader' has already been declared"，插件直接不激活。
 * 所以顶层只写表达式语句（window.__ModuleLoader__.load({...})），要局部变量就包 IIFE。
 */
;
window.__ModuleLoader__?.load({
    id: "dsh-bili-lite",
    factory: (require) => {
        const module = { exports: {} };
        const exports = module.exports;
        Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
        const React = require("react");
        const h = React.createElement;
        const { useCallback, useEffect, useState } = React;
        const API = "/dsh-bili-lite/api";
        const CSS = [
            ".bll{max-width:720px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:6px}",
            ".bll-title{margin:0;font-size:16px;font-weight:500;line-height:24px}",
            ".bll-intro{color:var(--dsw-alias-label-tertiary);margin:0 0 4px;font-size:13px;line-height:20px}",
            ".bll-group{margin-top:14px;font-size:13px;font-weight:600;line-height:20px}",
            ".bll-row{display:flex;justify-content:space-between;align-items:flex-start;gap:12px 20px;padding:10px 0;border-bottom:.5px solid var(--dsw-alias-border-l2);flex-wrap:wrap}",
            ".bll-row:last-child{border-bottom:none}",
            ".bll-row>div:first-child{flex:1;min-width:180px}",
            ".bll-label{font-size:13px;line-height:19px}",
            ".bll-hint{color:var(--dsw-alias-label-tertiary);margin-top:3px;font-size:11.5px;line-height:17px;white-space:pre-line}",
            ".bll-input{background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);font-size:12.5px;height:28px;padding:0 8px;min-width:160px;outline:none}",
            ".bll-input:focus-visible{border-color:var(--dsw-alias-brand-primary)}",
            ".bll-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l2)}",
            ".bll-btn{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground,#fff);border:none;border-radius:6px;font-size:12.5px;height:30px;padding:0 12px;cursor:pointer}",
            ".bll-btn:disabled{opacity:.5;cursor:default}",
            ".bll-btn2{background:transparent;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}",
            ".bll-out{white-space:pre-wrap;font-family:ui-monospace,Menlo,monospace;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary);background:rgba(127,127,127,.08);border-radius:8px;padding:10px 12px;max-height:260px;overflow:auto;margin-top:10px}",
            ".bll-err{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;margin-top:8px;white-space:pre-line}",
            ".bll-ok{color:var(--dsw-alias-state-success-primary,#3ec46d);font-size:12px;line-height:18px;margin-top:8px;white-space:pre-line}",
        ].join("");
        (() => { const tag = "bili-lite/section.css"; const old = document.getElementById(tag); if (old)
            old.remove(); const s = document.createElement("style"); s.id = tag; s.textContent = CSS; document.head.appendChild(s); })();
        // ── 字段清单（唯一真相：加字段只改这里 + 宿主白名单 ✓）─────────────────
        const FIELDS = [
            { group: "人设", path: ["persona", "name"], label: "它叫什么（可空）", hint: "只用在心跳抬头（如「【某名字心跳】」）；留空就不点名。人设正文仍写 ~/.dsh/bili-lite-work/persona.md", kind: "text" },
            { group: "心跳（节拍）", path: ["pulse", "everyMin"], label: "心跳间隔（分钟）", hint: "宿主每这么久问它一拍「现在想干嘛」；默认 60 —— 越小越活、越费 token", kind: "text" },
            { group: "克制", path: ["quota", "writeDaily"], label: "每天最多写几条", hint: "默认 3；>3 看起来会像刷量 ✗", kind: "text" },
            { group: "克制", path: ["quota", "interactDaily"], label: "每天最多互动几次", hint: "点赞 / 关注合计，默认 10；同一视频 7 天内同一种互动只做一次（写死）", kind: "text" },
            { group: "克制", path: ["risk", "minGapMs"], label: "请求间隔（毫秒）", hint: "默认 1200；连击是最容易被判机器人的特征 ✗", kind: "text" },
        ];
        const get = (o, path) => path.reduce((a, k) => a?.[k], o);
        const set = (o, path, v) => {
            const [k, ...rest] = path;
            if (!rest.length) {
                o[k] = v;
                return o;
            }
            const cur = o[k];
            if (!cur || typeof cur !== "object")
                o[k] = {};
            set(o[k], rest, v);
            return o;
        };
        const QR_STATUS = { waiting: "等待扫码…（手机 B 站 App → 扫一扫）", scanned: "已扫码 —— 请在手机上点「确认登录」", expired: "二维码已过期，重新点「显示二维码」", gone: "后台重启过，重新点「显示二维码」" };
        function BiliLiteSection() {
            const [cfg, setCfg] = useState(null);
            const [saved, setSaved] = useState(null);
            const [ck, setCk] = useState({ sessdata: "", bili_jct: "", buvid3: "", buvid4: "" });
            const [cred, setCred] = useState(null);
            const [busy, setBusy] = useState("");
            const [err, setErr] = useState("");
            const [okMsg, setOkMsg] = useState("");
            const [out, setOut] = useState("");
            const [status, setStatus] = useState(null);
            const [qr, setQr] = useState(null); // { key, img, status } —— 扫码登录会话
            const load = useCallback(async () => {
                setBusy("load");
                setErr("");
                setOkMsg("");
                try {
                    const r = await fetch(`${API}/settings`, { headers: { accept: "application/json" } });
                    const d = await r.json();
                    if (!d.ok)
                        throw new Error(d.error || "读取失败");
                    setCfg(d.config);
                    setSaved(JSON.stringify(d.config));
                    setCred(d.credentials);
                    const s = await fetch(`${API}/status`).then((x) => x.json()).catch(() => null);
                    setStatus(s);
                }
                catch (e) {
                    setErr(String(e.message || e));
                }
                finally {
                    setBusy("");
                }
            }, []);
            useEffect(() => { load(); }, [load]);
            const save = useCallback(async () => {
                setBusy("save");
                setErr("");
                setOkMsg("");
                try {
                    const body = JSON.parse(JSON.stringify(cfg));
                    const r = await fetch(`${API}/settings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
                    const d = await r.json();
                    if (!d.ok)
                        throw new Error(d.error || "保存失败");
                    setCfg(d.config);
                    setSaved(JSON.stringify(d.config));
                    setOkMsg("✓ 已保存（心跳下一拍就按新节拍算）" + (d.warn ? "\n⚠️ " + d.warn : ""));
                    load();
                }
                catch (e) {
                    setErr(String(e.message || e));
                }
                finally {
                    setBusy("");
                }
            }, [cfg, load]);
            const saveCookie = useCallback(async () => {
                setBusy("cookie");
                setErr("");
                setOkMsg("");
                try {
                    const r = await fetch(`${API}/cookie`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ck) });
                    const d = await r.json();
                    if (!d.ok)
                        throw new Error(d.error || "写入失败");
                    setOkMsg("✓ " + d.detail);
                    setCk({ sessdata: "", bili_jct: "", buvid3: "", buvid4: "" });
                    load();
                }
                catch (e) {
                    setErr(String(e.message || e));
                }
                finally {
                    setBusy("");
                }
            }, [ck, load]);
            const qrStart = useCallback(async () => {
                setBusy("qr");
                setErr("");
                setOkMsg("");
                try {
                    const r = await fetch(`${API}/qr/start`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
                    const d = await r.json();
                    if (!d.ok)
                        throw new Error(d.error || "申请二维码失败");
                    setQr({ key: d.key, img: d.img, status: "waiting" });
                }
                catch (e) {
                    setErr(String(e.message || e));
                }
                finally {
                    setBusy("");
                }
            }, []);
            // 扫码轮询：2s 一次；成功 / 失败都停下来 —— 失败必须说出来，静默重试会让页面永远停在「已扫码」
            useEffect(() => {
                if (!qr || qr.status === "expired" || qr.status === "gone")
                    return;
                const t = setInterval(async () => {
                    try {
                        const d = await fetch(`${API}/qr/poll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: qr.key }) }).then((x) => x.json());
                        if (!d.ok) {
                            setQr(null);
                            setErr(d.error || "扫码登录失败：未保存，原登录态不变");
                            return;
                        }
                        if (d.status === "done") {
                            setQr(null);
                            await load();
                            setOkMsg("✓ " + (d.detail || "已登录"));
                            return;
                        }
                        setQr((s) => (s && s.key === qr.key && s.status !== d.status ? { ...s, status: d.status } : s));
                    }
                    catch { /* 单次网络抖动不打断，下个 2s 再看（真正的失败服务端会回 ok:false） */ }
                }, 2000);
                return () => clearInterval(t);
            }, [qr, load]);
            const selftest = useCallback(async () => {
                setBusy("selftest");
                setErr("");
                setOkMsg("");
                setOut("");
                try {
                    const r = await fetch(`${API}/selftest`);
                    const d = await r.json();
                    setOut(d.items ? d.items.map((it) => `${it.ok ? "✓" : "✗"} ${it.name}：${it.detail}`).join("\n") + (d.ok ? "\n\n══ 全部通过 ✓" : "\n\n══ 有 ✗，先照提示修") : "");
                    if (!d.ok && d.error)
                        setErr(d.error);
                    load();
                }
                catch (e) {
                    setErr(String(e.message || e));
                }
                finally {
                    setBusy("");
                }
            }, [load]);
            if (!cfg)
                return h("div", { className: "bll" }, h("h3", { className: "bll-title" }, "B站养鱼"), busy ? h("div", { className: "bll-hint" }, "读取中…") : err ? h("div", { className: "bll-err" }, err) : null);
            const dirty = saved && JSON.stringify(cfg) !== saved;
            const ci = { className: "bll-input", autoComplete: "off", spellCheck: false };
            const up = (path, v) => setCfg((s) => set(JSON.parse(JSON.stringify(s)), path, v));
            const groups = [...new Set(FIELDS.map((f) => f.group))];
            const pulse = status?.pulse;
            const planLine = !pulse?.plan ? "" : pulse.plan.pending > 0
                ? ` · 它自己排了 ${pulse.plan.pending} 条计划（兜底拍暂停），下一拍 ${pulse.plan.nextDueText ?? "?"} ${pulse.plan.nextWhenText ?? ""}`
                : " · 它还没排作息（按兜底节拍来）";
            const pulseLine = !status ? "" : !pulse?.ok ? "心跳未启动（重启 DSH 试试）"
                : `每 ${pulse.everyMin} 分钟一拍 · 共 ${pulse.beats} 拍` + (pulse.lastBeatText ? ` · 上一拍 ${pulse.lastBeatText}` : " · 下一拍马上来") + planLine;
            return h("div", { className: "bll" }, h("h3", { className: "bll-title" }, String(cfg.persona?.name ?? "").trim() || "B站养鱼"), // 配了名字就显示名字（插件不写死）
            h("p", { className: "bll-intro" }, "极简版「与 AI 共用 B 站号」：作息它自己规划 —— 没排计划时宿主按兑底节拍问它「现在想干嘛」，它也能用 schedule 自己排作息和定时任务；刷视频、写日记，值得的发一条评论 —— 共用一个身份，它发的东西你都看得到。写额度 / 判重 / 风控熔断都写死在工具里。"), pulseLine ? h("div", { className: "bll-hint" }, "💓 " + pulseLine) : null, cred ? h("div", { className: "bll-hint" }, cred.present
                ? `当前账号：${cfg.self?.name || "?"}（mid ${cfg.self?.mid || "?"}）${cred.hasSess && cred.hasJct ? " ✓" : " ⚠️ 凭据缺字段"}`
                : "还没写入凭据 —— 在下面粘贴一次 cookie") : null, ...groups.map((g) => h("div", { key: g }, h("div", { className: "bll-group" }, g), h("div", null, FIELDS.filter((f) => f.group === g).map((f) => h("div", { className: "bll-row", key: f.path.join(".") }, h("div", null, h("div", { className: "bll-label" }, f.label), h("div", { className: "bll-hint" }, f.hint)), h("input", { ...ci, value: String(get(cfg, f.path) ?? ""), onChange: (e) => up(f.path, e.target.value) })))))), h("div", { className: "bll-group" }, "B 站登录"), h("div", { className: "bll-row" }, h("div", null, h("div", { className: "bll-label" }, "扫码登录（推荐）"), h("div", { className: "bll-hint" }, "手机 B 站 App → 扫一扫 → 确认登录；凭据自动验证并写入，不用手抄 cookie")), h("div", { style: { display: "flex", flexDirection: "column", gap: "8px", minWidth: "240px" } }, qr ? h("img", { src: qr.img, alt: "登录二维码", width: 168, height: 168, style: { borderRadius: "8px", border: "1px solid var(--dsw-alias-border-l2)" } }) : null, qr ? h("div", { className: "bll-hint" }, QR_STATUS[qr.status] ?? "…") : null, h("button", { className: "bll-btn bll-btn2", onClick: qr ? () => setQr(null) : qrStart, disabled: !!busy && busy !== "qr" }, qr ? "收起" : busy === "qr" ? "生成中…" : "显示二维码"))), h("div", { className: "bll-row" }, h("div", null, h("div", { className: "bll-label" }, "凭据（备用：写入后永不回显）"), h("div", { className: "bll-hint" }, "手机不在手边时：浏览器 F12 → Application → Cookies → bilibili.com 手动复制（SESSDATA 是 HttpOnly，console 拿不到 ✗）")), h("div", { style: { display: "flex", flexDirection: "column", gap: "8px", minWidth: "240px" } }, h("input", { ...ci, type: "password", placeholder: "SESSDATA", value: ck.sessdata, onChange: (e) => setCk((s) => ({ ...s, sessdata: e.target.value })) }), h("input", { ...ci, type: "password", placeholder: "bili_jct", value: ck.bili_jct, onChange: (e) => setCk((s) => ({ ...s, bili_jct: e.target.value })) }), h("input", { ...ci, type: "password", placeholder: "buvid3（可空）", value: ck.buvid3, onChange: (e) => setCk((s) => ({ ...s, buvid3: e.target.value })) }), h("input", { ...ci, type: "password", placeholder: "buvid4（可空）", value: ck.buvid4, onChange: (e) => setCk((s) => ({ ...s, buvid4: e.target.value })) }), h("button", { className: "bll-btn bll-btn2", onClick: saveCookie, disabled: !!busy || !ck.sessdata || !ck.bili_jct }, busy === "cookie" ? "验证中…" : "写入凭据（先验证再保存）"))), h("div", { className: "bll-actions" }, h("button", { className: "bll-btn", onClick: save, disabled: !!busy }, busy === "save" ? "保存中…" : "保存"), dirty ? h("span", { style: { marginLeft: "10px", color: "#ffb020", fontSize: "13px", alignSelf: "center" } }, "● 有改动还没保存（改了不点保存 = 没生效 ✗）") : null, h("button", { className: "bll-btn bll-btn2", onClick: selftest, disabled: !!busy }, busy === "selftest" ? "自检中…" : "启动自检"), h("button", { className: "bll-btn bll-btn2", onClick: load, disabled: !!busy }, "重新读取")), okMsg ? h("div", { className: "bll-ok" }, okMsg) : null, err ? h("div", { className: "bll-err" }, err) : null, out ? h("div", { className: "bll-out" }, out) : null, h("div", { className: "bll-hint" }, "装完先点「启动自检」；人设可选：写一段放到 ~/.dsh/bili-lite-work/persona.md（取前 3000 字附在每次心跳前）"));
        }
        const inject = ["slots"];
        const NS = "bili-lite";
        function apply(ctx) {
            ctx.effect(() => ctx.slots.inject("settings.section", () => ctx.slots.register({ name: "settings.section", id: NS, order: 7, label: () => "B站养鱼" }, BiliLiteSection), "bili-lite: settings section"), "bili-lite: settings section");
        }
        exports.apply = apply;
        exports.inject = inject;
        exports.BiliLiteSection = BiliLiteSection;
        return module.exports;
    },
});
