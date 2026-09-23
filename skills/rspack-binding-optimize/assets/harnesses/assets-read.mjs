import assert from 'node:assert/strict';
import { inCompilation } from './compiler.mjs';
export const config = {iterations: 200, warmup: 20, async: false};
const count = 64, payload = 'x'.repeat(256);
export function withContext(options) {
  return inCompilation(options, {prepare({compilation, sources}) {
    for (let i=0;i<count;i++) compilation.emitAsset(`fixture-${i}.txt`,new sources.RawSource(payload));
  }});
}
export function run({compilation}) {
  return compilation.getAssets().map(asset => [asset.name, String(asset.source.source())]);
}
export function verify(result) {
  assert.equal(result.length,count);
  assert.deepEqual(new Set(result.map(([name]) => name)), new Set(Array.from({length:count},(_,i) => `fixture-${i}.txt`)));
  assert(result.every(([,source]) => source===payload));
}
