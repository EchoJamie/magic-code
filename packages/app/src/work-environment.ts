// 显式加载 npm 实现；Bun 的同名内置模块不执行 dispatcher。
// patches/undici@7.29.1.patch 移除对 Web Stream 无效的 isReadable 门槛，保证取消和断流均能结束读取。
import { EnvHttpProxyAgent, fetch as dispatchFetch } from 'undici/index.js'
import type { FetchLike } from '@magic/model'

/** 一份工作的终端快照与连接池；协作成员共享，结束责任后由 Engine 释放。 */
export type WorkEnvironment = {
  readonly env: Readonly<Record<string, string>>
  readonly fetch: FetchLike
  close(): Promise<void>
}

export function createWorkEnvironment(inherited: Readonly<Record<string, string | undefined>>): WorkEnvironment {
  const env = Object.freeze(Object.fromEntries(Object.entries(inherited).filter((entry): entry is [string, string] => typeof entry[1] === 'string')))
  const all = env['all_proxy'] ?? env['ALL_PROXY'] ?? ''
  const dispatcher = new EnvHttpProxyAgent({
    httpProxy: env['http_proxy'] ?? env['HTTP_PROXY'] ?? all,
    httpsProxy: env['https_proxy'] ?? env['HTTPS_PROXY'] ?? all,
    noProxy: env['no_proxy'] ?? env['NO_PROXY'] ?? '',
  })
  return {
    env,
    fetch: ((input, init) => dispatchFetch(input as Parameters<typeof dispatchFetch>[0], {
      ...init as Parameters<typeof dispatchFetch>[1], dispatcher,
    })) as FetchLike,
    close: () => dispatcher.close(),
  }
}
