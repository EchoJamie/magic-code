import { defineTool, type ToolDefinition } from './registry.ts'

/** 参数准备先于归属查询；会话由装配绑定，模型不能传入其他会话或 PID。 */
export function defineBackgroundTools(): readonly ToolDefinition[] {
  return [
    defineTool({
      spec: { name: 'background_stop', summary: '停止本会话启动的一条后台命令，保留输出；无需查 PID 或 kill。', danger: { level: 'light' },
        parameters: { type: 'object', properties: { id: { type: 'string', minLength: 1 } }, required: ['id'], additionalProperties: false } },
      prepare(args) {
        if (typeof args.id !== 'string' || !args.id.trim()) throw new Error('id 须为非空后台命令编号')
        return { id: args.id }
      },
      async run(args, ctx) {
        if (!ctx.background) return { ok: false, output: '本会话未接入后台命令控制' }
        const result = await ctx.background.stop(args.id)
        return { ok: result.ok, output: result.ok ? JSON.stringify(result) : result.reason,
          ...(result.ok && result.finish ? { background: result.finish } : {}) }
      },
    }),
    defineTool({
      spec: { name: 'background_wait', summary: '等待本会话指定后台命令的结果并让出模型循环。任一目标变化自动接续；常驻服务不必加入，不要轮询。', danger: { level: 'light' },
        parameters: { type: 'object', properties: { ids: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1 } } }, required: ['ids'], additionalProperties: false } },
      prepare(args) {
        if (!Array.isArray(args.ids) || !args.ids.length || args.ids.some(id => typeof id !== 'string' || !id.trim())) throw new Error('ids 须为非空后台命令编号数组')
        if (new Set(args.ids).size !== args.ids.length) throw new Error('ids 不得重复')
        return { ids: args.ids as string[] }
      },
      run(args, ctx) {
        if (!ctx.background?.wait) return { ok: false, output: '本会话未接入后台等待' }
        const result = ctx.background.wait(args.ids)
        return { ok: result.ok, output: JSON.stringify(result), background: result,
          ...(result.ok && result.state === 'waiting' ? { halt: true as const } : {}) }
      },
    }),
  ]
}
