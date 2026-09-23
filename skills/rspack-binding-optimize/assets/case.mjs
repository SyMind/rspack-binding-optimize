import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);

// 根据 trace 调整输入、批次与同步/异步模式；然后冻结基线。
export const config = { iterations: 1000, warmup: 100, async: false };
export async function setup({ bindingPath }) {
  const addon = bindingPath.endsWith('.node') ? require(bindingPath) : await import(pathToFileURL(bindingPath));
  // JS 入口保留模块 namespace；按真实导出选择 named/default API。
  // 在这里构造代表实际负载的输入；计时范围由 run 明确界定。
  return { addon };
}
export function run(context) {
  throw new Error('请按 trace 实现真实 addon 调用，不能使用 JS mock');
}
export function verify(result, context) {
  // 使用确定的期望值、摘要或不变量；不要仅断言结果非空。
  assert.fail('请为返回值及相关副作用添加语义断言');
}
