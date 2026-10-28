/** 读取默认模型选择；服务缺席 / 形状不对 / 抛错都当作「没有默认选择」 */
function defaultSelection(get) {
    try {
        const service = get('agentDefaultModel');
        if (!service || typeof service.currentSelection !== 'function')
            return undefined;
        const selection = service.currentSelection();
        if (!selection || typeof selection.provider !== 'string' || !selection.provider
            || typeof selection.model !== 'string' || !selection.model)
            return undefined;
        return selection;
    }
    catch {
        return undefined;
    }
}
/**
 * 当前是否有可用模型（且与默认选择一致）。
 * @param get - 宿主服务读取函数（app 传 `(name) => ctx.get(name)`）。
 * @returns 可用时给出 provider / model；否则给出给人看的原因。
 */
export async function probeModel(get) {
    const llm = get('llm');
    if (!llm || typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') {
        return { ok: false, reason: '模型服务还没就绪' };
    }
    let providers;
    try {
        providers = llm.listProviders();
    }
    catch (e) {
        return { ok: false, reason: '读取模型 provider 失败：' + (e instanceof Error ? e.message : String(e)) };
    }
    if (!providers.length)
        return { ok: false, reason: '宿主没有注册任何模型 provider' };
    const selection = defaultSelection(get);
    const candidates = selection === undefined ? providers : providers.filter((p) => p.id === selection.provider);
    if (selection !== undefined && candidates.length === 0) {
        return { ok: false, reason: `默认模型 ${selection.provider}/${selection.model} 对应的 provider 未注册` };
    }
    let lastFailure = '';
    for (const provider of candidates) {
        let models;
        try {
            models = await llm.listModels(provider.id);
        }
        catch (e) {
            lastFailure = `${provider.id}：${e instanceof Error ? e.message : String(e)}`;
            continue;
        }
        if (!models.length)
            continue;
        if (selection !== undefined) {
            const hit = models.find((m) => m.id === selection.model);
            if (hit)
                return { ok: true, provider: provider.id, model: hit.id };
            lastFailure = `${provider.id} 没有模型 ${selection.model}`;
            continue;
        }
        return { ok: true, provider: provider.id, model: models[0].id };
    }
    if (selection !== undefined) {
        return { ok: false, reason: `默认模型 ${selection.provider}/${selection.model} 当前不可用（没有 API 凭证，或模型未开放）` };
    }
    return { ok: false, reason: lastFailure || '没有任何可用模型（没有 API 凭证，或模型未开放）' };
}
