const [component, output] = process.argv.slice(2);
if (!['cli', 'engine'].includes(component) || !output) throw new Error('用法：build-components.mjs cli|engine <outfile>');
// Ink imports node:process, so Bun's global process.env define does not fold its DEV guard.
// Strip that optional debugger branch at build time; ship no DevTools or external JS dependencies.
const result = await Bun.build({
  entrypoints: [`packages/app/src/${component}.ts`],
  metafile: true,
  compile: { target: 'bun-darwin-arm64', outfile: output, autoloadDotenv: false, autoloadBunfig: false },
  minify: { syntax: true },
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [{
    name: 'ink-production',
    setup(build) {
      build.onLoad({ filter: /\/ink\/build\/(ink|reconciler)\.js$/ }, async ({ path }) => ({
        contents: (await Bun.file(path).text()).replaceAll("process.env['DEV'] === 'true'", 'false'),
        loader: 'js',
      }));
    },
  }],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

// 核对实际进入产物的模块；元数据只用于本次检查，不留下额外构建报告。
const forbidden = component === 'engine'
  ? /(?:packages\/tui\/|node_modules\/(?:ink|react|react-reconciler)\/)/
  : /packages\/app\/src\/(?:assembly\.ts|agent-assembly\/|run\/(?:host-runtime|manager|executor|engine-call|engine-service)\.ts)/;
if (!result.metafile) throw new Error('构建未返回依赖元数据');
let bundled = 0;
for (const artifact of Object.values(result.metafile.outputs)) {
  for (const [path, input] of Object.entries(artifact.inputs)) {
    if (input.bytesInOutput > 0) bundled++;
    if (input.bytesInOutput > 0 && forbidden.test(path)) throw new Error(`${component} 产物越界依赖：${path}`);
  }
}
if (bundled === 0) throw new Error('构建依赖元数据没有产物贡献，无法验证边界');
console.log(`${component}: ${bundled} 个实际产物模块，依赖边界通过`);
