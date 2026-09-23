import assert from 'node:assert/strict';
import { inCompilation } from './compiler.mjs';
export const config = {iterations: 100, warmup: 10, async: false};
export function withContext(options) { return inCompilation(options,{modules:16}); }
export function run({compilation}) {
  return compilation.getStats().toJson({all:false,modules:true,ids:true,errors:true});
}
export function verify(result) {
  assert.deepEqual(result.errors,[]);
  for (const name of ['index.js',...Array.from({length:16},(_,i)=>`m${i}.js`)]) {
    assert(result.modules.some(module=>module.name===`./${name}`),`missing stats ${name}`);
  }
}
