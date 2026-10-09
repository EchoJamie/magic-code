import { normalizeDataDir } from './paths.ts'
import type { DiagnosticsChange, HostDiscovery, NativeResponse } from '@magic/contracts'
import { assertHostIdentity } from './host-discovery.ts'
import { linkOf, socketHandlers } from './wire.ts'

/** Uses the same serial settings service as the App; never edits a guessed config path. */
export async function applyHostDiagnostics(discovery: HostDiscovery, change: DiagnosticsChange, source: 'app' | 'cli' = 'cli'): Promise<string> {
  const socket = await Bun.connect({ unix: discovery.socket, socket: socketHandlers() })
  const link = linkOf<NativeResponse>(socket)
  return new Promise((resolve, reject) => {
    const read = crypto.randomUUID(), apply = crypto.randomUUID()
    let saving = false
    const timer = setTimeout(() => finish(new Error(saving ? '诊断设置的保存或生效结果尚未确认，请在 App 设置中重新读取' : '读取诊断设置超时')), 70_000)
    function finish(error?: Error, note?: string): void { clearTimeout(timer); if (error) reject(error); else resolve(note ?? '诊断设置已保存'); link.close() }
    link.onClose(() => { clearTimeout(timer); reject(new Error('诊断设置连接已断开，请重新读取结果')) })
    link.onMessage(message => {
      if (message.t === 'native.error') { finish(new Error(message.reason)); return }
      if (message.t === 'native.welcome') {
        try { assertHostIdentity(message.identity, discovery) } catch (error) { finish(error as Error); return }
        link.send({ t: 'native.settings.read', request: read, serviceInstance: discovery.serviceInstance, base: discovery.base })
      } else if (message.t === 'native.settings.result' && message.serviceInstance === discovery.serviceInstance && normalizeDataDir(message.base) === normalizeDataDir(discovery.base)) {
        if (message.request !== read && message.request !== apply) return
        if (message.error) { finish(new Error(message.error)); return }
        if (message.request === read && message.snapshot) {
          saving = true
          link.send({ t: 'native.settings.apply', request: apply, serviceInstance: discovery.serviceInstance, base: discovery.base, stamp: message.snapshot.stamp, action: { type: 'diagnostics.set', source, ...change } })
        } else if (message.request === apply) finish(undefined, message.note)
      }
    })
    link.send({ t: 'hello', role: 'observer', protocol: discovery.protocol, version: discovery.version, source: discovery.source, base: discovery.base })
  })
}
