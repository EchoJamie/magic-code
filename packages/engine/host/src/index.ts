/**
 * `@magic/host` —— 引擎宿主（0.2.0 起步）。
 *
 * 0.2.0 先收拢从 `app/run` 抽出的无状态叶子：运行路径、运行事实、引擎状态、恢复流水、
 * 原生投影、通知、协作原生桥、wire、sudo 认证、进程回收、运行时启动。`manager` 与
 * 执行者生命周期随后按放置/绑定/健康/回收继续拆入本包。
 */
export * from './paths.ts'
export * from './facts.ts'
export * from './engine-state.ts'
export * from './memory.ts'
export * from './native-projection.ts'
export * from './notices.ts'
export * from './collaboration-native.ts'
export * from './wire.ts'
export * from './sudo-auth.ts'
export * from './reclaim.ts'
export * from './actions/index.ts'
