import assert from 'node:assert/strict';
import { inCompilation } from './compiler.mjs';
export const config = {iterations: 1000, warmup: 100, async: false};
export function withContext(options) {
  return inCompilation(options, {prepare({compilation,sources}) {
    compilation.emitAsset('fixture.txt', new sources.RawSource('initial'));
    return {sequence:0};
  }});
}
export function run(context) {
  const {compilation,sources} = context;
  const expected = `value-${++context.sequence}`;
  // mutation + 下一次读取均在计时内，避免只测永不失效的热缓存。
  compilation.updateAsset('fixture.txt', new sources.RawSource(expected));
  return {expected,actual:String(compilation.getAsset('fixture.txt').source.source())};
}
export function verify({expected,actual},context) {
  assert.equal(actual,expected);
  assert.equal(actual,`value-${context.sequence}`);
}
