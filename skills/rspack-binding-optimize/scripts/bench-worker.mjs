import { createRequire } from 'node:module';
import { realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { writeJSON, readJSON, check } from './lib.mjs';

const [casePath, bindingPath, resultPath, auditPath] = process.argv.slice(2);
const c = await import(pathToFileURL(casePath));
check(['run','verify'].every(k => typeof c[k] === 'function'), 'case 必须导出 run/verify');
check(typeof c.setup === 'function' || typeof c.withContext === 'function', 'case 需要 setup 或 withContext');
check(!(c.setup && c.withContext), 'setup 与 withContext 只能选择一种');
const {iterations = 1000, warmup = 100, async: isAsync = false} = c.config || {};
check(Number.isSafeInteger(iterations) && iterations > 0 && Number.isSafeInteger(warmup) && warmup >= 0, '无效批次');

// A synchronous callback must not yield before all native-backed accesses finish.
function measureSync(context) {
  let result;
  for (let i=0;i<warmup;i++) result = c.run(context);
  check(!result?.then, '异步 case 必须设置 config.async=true');
  const prepared = c.beforeSample?.(context);
  check(!prepared?.then, '同步 case 的 beforeSample 必须同步');
  const start = process.hrtime.bigint();
  for (let i=0;i<iterations;i++) result = c.run(context);
  const elapsedNs = Number(process.hrtime.bigint() - start);
  check(!result?.then, '异步 case 必须设置 config.async=true');
  return {result, nsPerOp: elapsedNs / iterations, elapsedNs, iterations};
}
async function measureAsync(context) {
  let result;
  for (let i=0;i<warmup;i++) result = await c.run(context);
  await c.beforeSample?.(context);
  const start = process.hrtime.bigint();
  for (let i=0;i<iterations;i++) result = await c.run(context);
  const elapsedNs = Number(process.hrtime.bigint() - start);
  await c.verify(result, context);
  return {nsPerOp: elapsedNs / iterations, elapsedNs, iterations};
}

let sample;
if (c.withContext) {
  let invocations = 0;
  let pending;
  let closed = false;
  const measure = context => {
    check(!closed, 'withContext 已结束，不能访问失效的上下文');
    check(++invocations === 1, 'withContext 每个进程必须且只能调用一次 measure');
    if (isAsync) {
      pending = measureAsync(context).then(value => { sample = value; });
      return pending;
    }
    const {result, ...value} = measureSync(context);
    const verification = c.verify(result, context);
    check(!verification?.then, '同步 withContext 的 verify 必须在 callback 返回前完成');
    sample = value;
  };
  await c.withContext({bindingPath, measure});
  closed = true;
  check(invocations === 1, 'withContext 没有调用 measure');
  // Do not accept fire-and-forget work after the owning lifecycle has closed.
  check(sample, '异步 withContext 必须 await/返回 measure 的 Promise');
  await pending;
} else {
  const context = await c.setup({bindingPath});
  try {
    if (isAsync) sample = await measureAsync(context);
    else {
      const {result, ...value} = measureSync(context);
      await c.verify(result, context);
      sample = value;
    }
  } finally { await c.teardown?.(context); }
}

const require = createRequire(import.meta.url);
const loadedNativeModules = await Promise.all(Object.keys(require.cache).filter(path => path.endsWith('.node')).map(path => realpath(path)));
if (auditPath) {
  const expected = await readJSON(auditPath);
  const expectedNative = Object.keys(expected).filter(path => path.endsWith('.node'));
  check(expectedNative.every(path => loadedNativeModules.includes(path)), '声明的 native addon 未加载，检查 JS 入口和包解析');
  check(loadedNativeModules.every(path => expectedNative.includes(path)), '加载了未声明的 native addon，可能误用基线/已发布包');
}
await writeJSON(resultPath, {...sample, loadedNativeModules});
