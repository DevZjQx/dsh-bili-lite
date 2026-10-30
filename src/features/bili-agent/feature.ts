/**
 * dsh-bili-lite · bili-agent —— 库入口（ops 层的对外门面）
 *
 * 为什么这个 feature 有两个入口：
 *   · `bili.ts` —— 可执行入口（带 shebang），人 / 终端用；宿主只引用路径，不 import。
 *   · `feature.ts` —— 纯库入口，只 re-export ops 的数据契约与函数，零副作用。
 *     别的 feature（bili-tools）要调 ops，只能走这里 —— 结构检查只放行跨 feature 的
 *     `feature.ts` 与根级带 shebang 的 `.ts`（scripts/check-structure.ts）。
 *
 * 这里不 import 任何东西、也不跑任何逻辑：一旦它带副作用，跨 feature 引用就等于
 * 顺带把 CLI 初始化了一遍。
 */
export * from './ops.ts'
