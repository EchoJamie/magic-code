/**
 * 可序列化守护 —— 控制面消息**是纯数据**（技术方案 · 接入：消息按可序列化设计，JSON 友好）。
 *
 * 「JSON 友好」若只靠自觉，会到**最远处**才炸：跨进程桥接（第二站）与跨设备（第三站）
 * 上，函数 / 类实例 / 环写不出去——那里离产出地最远、修复最贵。故此处置为**机制**
 * （技术方案 · 设计准则 3：能靠设计兜底的，别靠自觉）：通道在**投递前**逐条校验，
 * 违者不投、抛错并点名路径。
 *
 * 判定口径＝**JSON 往返无损**：
 * - 收：`null` · 布尔 · 字符串 · 有限数字 · 数组 · 纯对象（原型为 `Object.prototype` / `null`）；
 * - 拒：函数 · `symbol` · `bigint` · `undefined`（`JSON.stringify` 丢键——有损）·
 *   非有限数字（`NaN` / `Infinity` 变 `null`——有损）· 类实例（`Date` / `Map` / 自定义类）· 环。
 *
 * 视野＝**值图上的自有可枚举字符串键**（`JSON.stringify` 所见）——symbol 键与不可枚举属性
 * 与 JSON 同视野，不在判定内。
 * 不误伤：`readonly` 与冻结对象照收；同一对象多处引用（图，非环）不判环。
 */

/** 违规点的人话描述（含路径）；纯数据则 `undefined`。 */
function violationOf(value: unknown, trail: string, stack: Set<object>): string | undefined {
  if (value === null) return undefined

  switch (typeof value) {
    case 'boolean':
    case 'string':
      return undefined
    case 'number':
      return Number.isFinite(value) ? undefined : `${at(trail)}：非有限数字（JSON 往返有损）`
    case 'object':
      break
    default:
      // function / symbol / bigint / undefined——JSON 写不出去或丢键
      return `${at(trail)}：${typeof value}`
  }

  const container = value as object

  // 环——JSON.stringify 直接抛；图（多处引用同一对象）走 add/delete 不误判
  if (stack.has(container)) return `${at(trail)}：环（JSON.stringify 抛）`

  stack.add(container)
  try {
    if (Array.isArray(container)) {
      for (const [index, item] of container.entries()) {
        const violation = violationOf(item, `${trail}[${index}]`, stack)
        if (violation !== undefined) return violation
      }
      return undefined
    }

    if (!isPlainObject(container)) return `${at(trail)}：非纯对象（类实例 / Date / Map…）`

    for (const [key, item] of Object.entries(container)) {
      const violation = violationOf(item, trail === '' ? key : `${trail}.${key}`, stack)
      if (violation !== undefined) return violation
    }
    return undefined
  } finally {
    stack.delete(container)
  }
}

/** 路径可读化——根处无路径。 */
function at(trail: string): string {
  return trail === '' ? '根' : trail
}

/** 纯对象——原型是 `Object.prototype`（字面量 / 冻结字面量）或 `null`（`Object.create(null)`）。 */
function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** 是否 JSON 往返无损（＝可序列化）。 */
export function isSerializable(value: unknown): boolean {
  return violationOf(value, '', new Set()) === undefined
}

/**
 * 断言可序列化——违者抛 `TypeError`，消息含 `label` 与违规路径（哪个字段、为何不可）。
 * 控制面通道在 `send` / `publish` **投递前**调用，故违规消息不会到达任何订阅方。
 */
export function assertSerializable(value: unknown, label = '消息'): void {
  const violation = violationOf(value, '', new Set())
  if (violation !== undefined) {
    throw new TypeError(`${label}不可序列化（JSON 往返有损）——${violation}`)
  }
}
