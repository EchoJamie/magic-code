/**
 * `@magic/app` —— 装配根（**唯一 import 具体实现的地方**）。
 *
 * 一切「选择与绑定」在此：读配置与密钥 · 构造各域实现 · 依次注入 · 构造控制域 ·
 * 接外壳（技术方案 · 领域划分 · 装配视图）。**装配不承载逻辑。**
 *
 * 公开面三件（对同行「公开面」纪律的同一条口径——只出**端口装配 ＋ 构造入参形态**）：
 *
 * | 件 | 落点 |
 * | --- | --- |
 * | **全链装配**——`assemble` | `./assembly.ts` |
 * | **配置加载**——`loadConfig`（＋`ConfigError` / `describeConfig`） | `./config.ts` |
 * | **外壳位驱动**——`attachShell` / `runShellScript`（真外壳归 U09） | `./shell.ts` |
 *
 * 另出一件**生产面独有**的铸造器：`createStamper`——契约 `EventStamper` 的落地
 * （「产出方铸 · 装配按会话实例构造」）。测试面那一份在 `@magic/faux`，两者同因
 * 泛型构造面的固有限制各带一次断言，不是重复实现（见 `assembly.ts` 头注）。
 *
 * 不出去的：`./cli.ts`（入口，非库面）。
 */

// —— 全链装配 ——

export { assemble, createStamper } from './assembly.ts'
export type { AssembleOptions, Assembly, EnvironmentVars } from './assembly.ts'

// —— 配置加载 ——

export { ConfigError, describeConfig, loadConfig } from './config.ts'
export type { LoadConfigOptions, LoadedConfig } from './config.ts'

// —— 模型信息缓存与配置保存（U41）——

export { MODEL_CACHE_DIR, createFileModelInfoCache } from './model-cache.ts'
export { editConfigFile, removeProvider, saveProvider, setModelDefault } from './config-save.ts'
export type { EditConfigInput, SaveOutcome } from './config-save.ts'

// —— 外壳位（真外壳归 U09）——

export { attachShell, runShellScript } from './shell.ts'
export type {
  AttachShellOptions,
  ShellDecision,
  ShellDecisionRequest,
  ShellHandle,
  ShellScript,
  ShellStep,
  ShellSwitch,
} from './shell.ts'
