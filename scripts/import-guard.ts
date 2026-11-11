/**
 * 依赖与写入边界守卫——实现集中在 test/scaffold.test.ts（AST 判定 + 包发现），
 * 这里只提供非测试命令入口，避免同一套规则写两份。
 */
const root = new URL('..', import.meta.url).pathname
const child = Bun.spawn(['bun', 'test', './test/scaffold.test.ts'], {
  cwd: root,
  stdio: ['inherit', 'inherit', 'inherit'],
})
process.exit(await child.exited)
