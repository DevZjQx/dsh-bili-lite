/**
 * 模型就绪探针（shared，纯逻辑）—— 心跳投递前问一句「宿主现在能不能真的跑一轮模型」。
 *
 * 为什么需要：每一拍投出去都会变成一次真实的模型调用。没有 API 凭证 / 没有可用
 * 模型时，这一拍注定以 `MISSING_CREDENTIAL`（或同类错误）告终，还会在会话里留下
 * 一次失败的 run —— 与其每分钟撞一次墙，不如投之前先看 llm 的目录：
 *   · `llm-deepseek` / `llm-pi-ai` 的 `listModels` 都是凭证门控的：没 key 返回空；
 *   · 因此「某条 route 有模型」本身就等于「这条路能发请求」，不需要另读 credentials；
 *   · 有默认选择（`agentDefaultModel.currentSelection()`）时按它检查，因为新会话
 *     用的就是它；没有默认选择时退化为「任一 provider 有模型」。
 *
 * 探测不到服务（DSH 刚启动 / 服务没挂）也按「未就绪」处理：软等待，不抛、不记账。
 * 这里只回答能/不能，节奏与文案仍归 bili-pulse。
 */
import type {
  AgentDefaultModelLike, LlmModelInfoLike, LlmProviderInfoLike, LlmRuntimeLike, ModelSelectionLike,
} from './dsh.ts'

export type ModelReadiness =
  | { ok: true; provider: string; model: string }
  | { ok: false; reason: string }

/** 读取默认模型选择；服务缺席 / 形状不对 / 抛错都当作「没有默认选择」 */
function defaultSelection(get: <T = unknown>(name: string) => T | undefined): ModelSelectionLike | undefined {
  try {
    const service = get<AgentDefaultModelLike>('agentDefaultModel')
    if (!service || typeof service.currentSelection !== 'function') return undefined
    const selection = service.currentSelection()
    if (!selection || typeof selection.provider !== 'string' || !selection.provider
      || typeof selection.model !== 'string' || !selection.model) return undefined
    return selection
  } catch {
    return undefined
  }
}

/**
 * 当前是否有可用模型（且与默认选择一致）。
 * @param get - 宿主服务读取函数（app 传 `(name) => ctx.get(name)`）。
 * @returns 可用时给出 provider / model；否则给出给人看的原因。
 */
export async function probeModel(get: <T = unknown>(name: string) => T | undefined): Promise<ModelReadiness> {
  const llm = get<LlmRuntimeLike>('llm')
  if (!llm || typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') {
    return { ok: false, reason: '模型服务还没就绪' }
  }

  let providers: LlmProviderInfoLike[]
  try {
    providers = llm.listProviders()
  } catch (e) {
    return { ok: false, reason: '读取模型 provider 失败：' + (e instanceof Error ? e.message : String(e)) }
  }
  if (!providers.length) return { ok: false, reason: '宿主没有注册任何模型 provider' }

  const selection = defaultSelection(get)
  const candidates = selection === undefined ? providers : providers.filter((p) => p.id === selection.provider)
  if (selection !== undefined && candidates.length === 0) {
    return { ok: false, reason: `默认模型 ${selection.provider}/${selection.model} 对应的 provider 未注册` }
  }

  let lastFailure = ''
  for (const provider of candidates) {
    let models: ReadonlyArray<LlmModelInfoLike>
    try {
      models = await llm.listModels(provider.id)
    } catch (e) {
      lastFailure = `${provider.id}：${e instanceof Error ? e.message : String(e)}`
      continue
    }
    if (!models.length) continue
    if (selection !== undefined) {
      const hit = models.find((m) => m.id === selection.model)
      if (hit) return { ok: true, provider: provider.id, model: hit.id }
      lastFailure = `${provider.id} 没有模型 ${selection.model}`
      continue
    }
    return { ok: true, provider: provider.id, model: models[0].id }
  }

  if (selection !== undefined) {
    return { ok: false, reason: `默认模型 ${selection.provider}/${selection.model} 当前不可用（没有 API 凭证，或模型未开放）` }
  }
  return { ok: false, reason: lastFailure || '没有任何可用模型（没有 API 凭证，或模型未开放）' }
}
