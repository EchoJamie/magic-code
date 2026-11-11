/**
 * 公开面检查（M01 第 10 轮补）。
 *
 * U04 / U06 均报：`FauxGateway` 类型此前**漏了转出**——消费者只能写
 * `ReturnType<typeof createFauxGateway>` 绕。本文件钉住「公开面出得全」。
 */

import { describe, expect, test } from 'bun:test'
import type { ModelGateway, WorkspaceService } from '@magic/contracts'
import { createFauxGateway, makeFauxWorkspace, makeTestStamper } from '../src/index.ts'
import type { FauxGateway, FauxWorkspace, FauxWorkspaceOptions } from '../src/index.ts'

describe('公开面', () => {
  test('`FauxGateway` 可作类型取用——且是 `ModelGateway` 的实现', () => {
    const gateway: FauxGateway = createFauxGateway({
      stamper: makeTestStamper(),
      turns: [{ text: 'x' }],
    })
    const asPort: ModelGateway = gateway

    expect(typeof gateway.stream === 'function').toBe(true)
    void asPort
  })

  test('`FauxWorkspace` 可作类型取用——且是 `WorkspaceService` 的实现', () => {
    const options: FauxWorkspaceOptions = { root: '/tmp/faux-face' }
    const workspace: FauxWorkspace = makeFauxWorkspace(options)
    const asPort: WorkspaceService = workspace

    expect(workspace.roots()).toEqual(['/tmp/faux-face'])
    void asPort
  })
})
