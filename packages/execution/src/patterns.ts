/**
 * 路径模式 —— 规则文档 `paths` 那一格的**展开与匹配**（U32）。
 *
 * 一处两个面：**大括号展开**（`{ts,tsx}`——写一组候选，省得把同一条模式抄三遍）与
 * **glob 匹配**（`**` 跨段 · `*` 段内 · `?` 单字符）。
 *
 * **基准是所属项目根**（产品口径：规则子目录只是组织方式，路径基准仍是项目根）——
 * 故这里处理的一律是**根相对**模式与**根相对**路径，绝对那一头由调用方（`rules.ts`）
 * 先归位。
 *
 * **两条硬要求**（工单明文，各落一处）：
 * - **无效模式不扩大为全匹配**——读不懂的模式一律**报错退回**，绝不退化成「哪都算命中」。
 *   放宽一条读不懂的规则，正与「解析从严」相抵（同权限域 `parseRules` 的姿态）。
 * - **避免无界大括号展开**——`{a,b}{c,d}{e,f}…` 是乘法级的组合爆炸，故展开有上限
 *   （`MAX_PATTERN_EXPANSIONS`），超了**报错**而不是悄悄截断成前若干条。
 *
 * 不取件（本包只依赖契约）：这一小套模式不属于任何外部格式的完备实现，够写 `paths` 即可
 * ——其余字符一律按字面处理（`.git` 里的点不会变成「任意字符」）。
 */

/**
 * 一条模式的展开上限——**条数**。
 *
 * 由头：`{a,b}` 一层是两倍，三层就是八倍，六层六十倍——`paths: ["{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}"]`
 * 一行就能要六十四条，再往下是随手指敲出来的规模。64 够任何讲道理的分组，
 * 越过它的写法**报错**（用户看得见是哪一条），而不是替他砍掉一半。
 */
export const MAX_PATTERN_EXPANSIONS = 64

/**
 * **同层大括号组数的上限**——递归深度就是它。
 *
 * 为什么宽度上限（64 条）拦不住这一条：展开是**深度优先**的，攒够 64 条之前得先一路下探到底
 * ——`"{a,b}"` 写两万四千遍（约 120KB，还在单份文档 128KB 的上限之内）就是两万四千层递归，
 * **栈当场爆掉**：不是「一条读不懂的规则不生效」，是 `magic --check` 与整个会话崩在栈上。
 * 而规约文件是**仓库里的东西**——克隆一个带这种文件的仓库就能让程序起不来。
 *
 * 故组数**在展开之前**先数一遍。16 组已是任何讲道理写法的十倍有余（宽度上限 64 早就在
 * 第 7 组前后先撞上），且它与调用栈深浅无关——同一个输入恒同一个结论。
 */
export const MAX_BRACE_GROUPS = 16

/** 模式解析的判别式——`ok: false` 带**缘由**（静默丢弃会让人对着一条不生效的规则发呆）。 */
export type PatternExpansion =
  | { readonly ok: true; readonly patterns: readonly string[] }
  | { readonly ok: false; readonly reason: string }

/**
 * 展开一条模式——大括号分组在此拆开，其余原样。
 *
 * 失败四类（都**退回**，不降级）：括号不成对 / 嵌套 · 组数超上限 · 展开超上限 ·
 * 单条模式本身不成立（见 `problemOfPattern`）。
 */
export function expandPatterns(raw: string): PatternExpansion {
  const source = raw.trim()
  const groups = (source.match(/\{/g) ?? []).length
  if (groups > MAX_BRACE_GROUPS) {
    return {
      ok: false,
      reason: `大括号有 ${groups} 组（上限 ${MAX_BRACE_GROUPS}）——请拆成几条 paths 分别写`,
    }
  }

  const expanded = expandBraces(source)
  if (!expanded.ok) return expanded
  if (expanded.patterns.length > MAX_PATTERN_EXPANSIONS) {
    return {
      ok: false,
      reason: `大括号展开出 ${expanded.patterns.length} 条以上模式（上限 ${MAX_PATTERN_EXPANSIONS}）——请拆成几条 paths 分别写`,
    }
  }

  for (const pattern of expanded.patterns) {
    const problem = problemOfPattern(pattern)
    if (problem !== undefined) return { ok: false, reason: problem }
  }

  return { ok: true, patterns: expanded.patterns }
}

/**
 * 大括号展开——**同层可以有好几组**（`src/{a,b}/*.{ts,tsx}` 是两组），**嵌套不认**。
 *
 * 嵌套拒绝而不是支持：`{a,{b,c}}` 的语义在各方实现里并不一致（笛卡尔积还是并集？），
 * 与其各猜一种，不如明说「不支持嵌套」——用户拆成两条 paths 即可，代价小、行为确定。
 *
 * 展开是**边拆边攒、到上限就停**——`{a,b}` 叠七层就是 128 条，先攒完再判上限的话，
 * 上限本身就成了纸糊的（要拦住的是「展开规模」，那得在展开**过程中**拦）。
 */
function expandBraces(pattern: string): PatternExpansion {
  const out: string[] = []
  const problem = expandInto(pattern, out)
  if (problem !== undefined) return { ok: false, reason: problem }

  return ok(out)
}

/** 拆一层、递归拆其余；`out` 攒结果，`tooMany` 时返回缘由。 */
function expandInto(pattern: string, out: string[]): string | undefined {
  const open = pattern.indexOf('{')

  if (open === -1) {
    if (pattern.includes('}')) return '大括号不成对（多了一个 `}`）'
    out.push(pattern)
    return undefined
  }

  const close = pattern.indexOf('}', open + 1)
  if (close === -1) return '大括号不成对（`{` 没有配对的 `}`）'

  const head = pattern.slice(0, open)
  const body = pattern.slice(open + 1, close)
  const tail = pattern.slice(close + 1)

  if (head.includes('}')) return '大括号不成对（多了一个 `}`）'
  if (body.includes('{') || body.includes('}')) {
    return '不支持嵌套大括号——请把分组拆成几条 paths 写'
  }

  const alternatives = body.split(',').map((part) => part.trim())
  if (alternatives.some((part) => part === '')) {
    return '大括号里有一项是空的——`{a,}` 这种写法认不出你要什么'
  }

  for (const alternative of alternatives) {
    const problem = expandInto(head + alternative + tail, out)
    if (problem !== undefined) return problem
    if (out.length > MAX_PATTERN_EXPANSIONS) return tooMany(MAX_PATTERN_EXPANSIONS + 1)
  }

  return undefined
}

function tooMany(count: number): string {
  return `大括号展开出 ${count} 条以上模式（上限 ${MAX_PATTERN_EXPANSIONS}）——请拆成几条 paths 分别写`
}

function ok(patterns: readonly string[]): PatternExpansion {
  return { ok: true, patterns }
}

/**
 * 一条**已展开**的模式本身成立不成立。
 *
 * 三条判据，都指向同一个方向——**别让它静默变宽**：
 * - 空的 → 拒（空模式配任何前缀都不是用户要的）；
 * - 以 `/` 开头 → 拒：基准是项目根，写绝对路径说明理解错了基准，替它猜「大概是根相对」
 *   会把一条范围写错的规则**照单生效**；
 * - 有 `..` 段 → 拒：模式声明的是「根内哪一摊」，出根的范围不该由一条路径模式悄悄扩大。
 */
function problemOfPattern(pattern: string): string | undefined {
  if (pattern === '') return '模式是空的'
  if (pattern.startsWith('/')) {
    return `模式「${pattern}」以 / 开头——paths 按**项目根相对**写（如 \`src/**/*.ts\`），不写绝对路径`
  }
  if (pattern.split('/').includes('..')) {
    return `模式「${pattern}」里有 \`..\`——paths 管的是项目根内，出根的范围不在这里声明`
  }
  if (pattern.includes('\0')) return `模式「${pattern}」含不可见字符`

  return undefined
}

/**
 * 模式 → 正则：`**` 跨段 · `*` 段内 · `?` 单字符，其余字面。
 *
 * **两个星号紧接一个斜杠是特例**（与权限域那支的差别，刻意留下）：它表示「零层或多层目录」，
 * 故「`src` ＋ 两个星号 ＋ 斜杠 ＋ `*.ts`」要能命中 `src/a.ts`（一层目录都没有）——
 * 若照两个星号一律翻成「任意字符」，那个模式就要求 `src` 之后**至少**得有一层目录，
 * 而用户写它时想的是「src 底下所有 ts」。反过来，**收尾**的两个星号仍是「任意字符」：
 * 用户写它就是要 src 里任何东西。
 *
 * 未展开的大括号走到这里**不会发生**（`expandPatterns` 已拆开）；万一到了，按字面处理
 * ——大括号不是通配，不会静默变成「任意」。
 */
export function compilePattern(pattern: string): RegExp {
  let source = ''
  let index = 0

  while (index < pattern.length) {
    const char = pattern[index] ?? ''

    if (char === '*' && pattern[index + 1] === '*') {
      if (pattern[index + 2] === '/') {
        source += '(?:.*/)?'
        index += 3
        continue
      }
      source += '.*'
      index += 2
      continue
    }
    if (char === '*') {
      source += '[^/]*'
      index += 1
      continue
    }
    if (char === '?') {
      source += '[^/]'
      index += 1
      continue
    }

    source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    index += 1
  }

  return new RegExp(`^${source}$`)
}

/** 一条模式命中一条**根相对**路径不命中——编译一次、比对一次（逐条现编够小，不做缓存）。 */
export function matchesPattern(pattern: string, relative: string): boolean {
  return compilePattern(pattern).test(relative)
}
