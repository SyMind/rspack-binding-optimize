import assert from 'node:assert/strict';
import { inCompilation } from './compiler.mjs';
export const config = {iterations: 200, warmup: 20, async: false};
export function withContext(options) { return inCompilation(options,{modules:16}); }
export function run({compilation}) {
  return [...compilation.modules].map(module => ({
    identifier:module.identifier(),
    chunks:[...compilation.chunkGraph.getModuleChunksIterable(module)].map(chunk => chunk.id),
  }));
}
export function verify(result,{root}) {
  for (const name of ['index.js',...Array.from({length:16},(_,i)=>`m${i}.js`)]) {
    const row=result.find(row=>row.identifier===`${root}/${name}`);
    assert(row,`missing module ${name}: ${JSON.stringify(result)}`);
    assert.equal(row.chunks.length,1);
    assert(row.chunks.every(id=>id!==null && id!==undefined));
  }
}
