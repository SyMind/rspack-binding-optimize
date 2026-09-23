// 只在有效的同步 processAssets 窗口调用 measure；初始化和 close 不计时。
import { mkdtemp, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function inCompilation({bindingPath, measure}, {modules = 0, prepare = () => {}} = {}) {
  const {rspack, sources} = await import(pathToFileURL(bindingPath));
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rspack-binding-case-')));
  let compiler;
  try {
    if (modules) {
      await Promise.all(Array.from({length: modules}, (_, i) => writeFile(join(root, `m${i}.js`), `export default ${i};\n`)));
      await writeFile(join(root, 'index.js'), Array.from({length: modules}, (_, i) =>
        `import m${i} from './m${i}.js'; console.log(m${i});`).join('\n'));
    }
    compiler = rspack({
      mode: 'none', context: root, entry: modules ? './index.js' : {},
      cache: false, devtool: false, target: 'node',
      optimization: {minimize:false, concatenateModules:false},
      output: {path: join(root,'dist')},
      plugins: [{apply(compiler) {
        compiler.hooks.thisCompilation.tap('BindingCase', compilation => {
          compilation.hooks.processAssets.tap('BindingCase', () => {
            const extra = prepare({compilation, sources, root});
            measure({compilation, sources, root, ...extra});
          });
        });
      }}],
    });
    await new Promise((accept, reject) => compiler.run((error, stats) => {
      if (error) return reject(error);
      if (!stats || stats.hasErrors()) return reject(new Error(stats?.toString({all:false,errors:true}) || 'Missing stats'));
      accept();
    }));
  } finally {
    try {
      if (compiler) await new Promise((accept, reject) => compiler.close(error => error ? reject(error) : accept()));
    } finally { await rm(root, {recursive:true,force:true}); }
  }
}
