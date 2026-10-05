/** 真 CLI/宿主/SDK 的测试传输隔离：仅允许本次 loopback，官方地址也由本地夹具接收。 */
const fixture = process.env['U113_FIXTURE_URL']
if (fixture === undefined) throw new Error('U113 受控端点未指定')
const base = new URL(fixture)
const actualFetch = globalThis.fetch
globalThis.fetch = (async (input: string | Request | URL, init?: RequestInit) => {
  const source = new URL(input instanceof Request ? input.url : String(input))
  const target = new URL(source)
  if (source.origin === 'https://api.deepseek.com') {
    target.href = base.href.replace(/\/$/, '') + source.pathname + source.search
  } else if (source.origin !== base.origin) throw new Error(`U113 禁止外部请求：${source.origin}`)
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
  headers.set('X-U113-Original-URL', source.href)
  return actualFetch(input instanceof Request ? new Request(target.href, input) : target, { ...init, headers })
}) as typeof globalThis.fetch
