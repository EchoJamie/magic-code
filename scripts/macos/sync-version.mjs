/**
 * 发布版本号只有一个来源：`package.json` 的 `version`。
 *
 * `packages/contracts/src/conversation/native.ts` 的 `SOFTWARE_VERSION` 会被编进
 * `magic-engine` / `magic-cli` 的 `--version`，安装器按它判断兼容与是否需要 `--upgrade`；
 * 它同时被 Swift 侧读取（`MagicProtocolVersion`），所以必须是源码里的真实常量。
 *
 * 构建脚本在打包前调用本脚本把它对齐——不再靠人记住改两处。
 */
import { readFileSync, writeFileSync } from 'node:fs'

const source = 'packages/contracts/src/conversation/native.ts'
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const pattern = /export const SOFTWARE_VERSION = '([^']+)'/
const text = readFileSync(source, 'utf8')
const found = pattern.exec(text)
if (!found) throw new Error(`${source} 里找不到 SOFTWARE_VERSION`)
if (found[1] === pkg.version) process.exit(0)
writeFileSync(source, text.replace(pattern, `export const SOFTWARE_VERSION = '${pkg.version}'`))
console.log(`版本号已对齐 package.json：${found[1]} → ${pkg.version}（${source}）`)
