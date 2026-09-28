// Ink imports node:process, so Bun's global process.env define does not fold its DEV guard.
// Strip that optional debugger branch at build time; ship no DevTools or external JS dependencies.
const result = await Bun.build({
  entrypoints: ['packages/app/src/cli.ts'],
  compile: { target: 'bun-darwin-arm64', outfile: process.argv[2], autoloadDotenv: false, autoloadBunfig: false },
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
