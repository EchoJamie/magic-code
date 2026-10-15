import { vendorCatalog, vendorOf, PROTOCOLS } from '../../packages/model/src/vendors.ts'
import { effectiveReasoningSupportOf } from '../../packages/model/src/selection.ts'
import { MODEL_INFO_TTL_MS } from '../../packages/model/src/model-info.ts'
import { RULE_OPS } from '../../packages/permission/src/ops.ts'
import { statusLinePreview } from '../../packages/tui/src/components/status.ts'
import type { StatusLineCell } from '@magic/contracts'

// App 编辑所需的静态资料随同版构建生成；不复制供应商执行适配。
const cells: StatusLineCell[] = ['session', 'model', 'reasoning', 'context', 'workspace']
const vendors = vendorCatalog().map(info => {
  const adapter = vendorOf(info.vendor)!
  return { ...info,
    endpoints: Object.fromEntries(info.regions.map(region => [region.id, Object.fromEntries(PROTOCOLS.map(protocol =>
      [protocol.id, adapter.baseURLOf({ vendor: info.vendor, region: region.id }, protocol.id)]))])),
    models: Object.fromEntries(info.protocols.map(protocol => [protocol.id, Object.fromEntries(protocol.models.map(model => [model, {
      ...adapter.supplement({ id: model }, protocol.id),
      editableReasoning: effectiveReasoningSupportOf({ vendor: info.vendor, protocol: protocol.id }, model),
    }]))])),
  }
})
const preview = statusLinePreview({ cells, color: true }, 300, false)
const result = { vendors, modelTTL: MODEL_INFO_TTL_MS, ruleOps: RULE_OPS,
  preview: { ...preview, cells, reducedColors: statusLinePreview({ cells }, 300, true).colors } }
if (!process.argv[2]) throw new Error('需要输出文件路径')
await Bun.write(process.argv[2], JSON.stringify(result))
