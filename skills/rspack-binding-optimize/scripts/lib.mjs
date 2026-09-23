import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, writeFile, readdir, realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
export const sha256 = data => createHash('sha256').update(data).digest('hex');
export const readJSON = async path => JSON.parse(await readFile(path, 'utf8'));
export const writeJSON = (path, value, flag = 'wx') => writeFile(path, JSON.stringify(value, null, 2) + '\n', {flag});
export function check(value, message) { if (!value) throw new Error(message); }
export function cleanEnvironment(env = process.env, extra = []) {
  const result = {...env};
  for (const key of Object.keys(result)) {
    if (/^(SFTRACE|XRAY|NAPI_BINDING_PROFILE)/.test(key) || ['NAPI_RS_NATIVE_LIBRARY_PATH', 'NAPI_RS_FORCE_WASI'].includes(key) || extra.includes(key)) delete result[key];
  }
  check(!/--(?:cpu-prof|prof|inspect)/.test(result.NODE_OPTIONS || ''), '测量前移除 NODE_OPTIONS 中的诊断参数');
  return result;
}
export function median(values) {
  const a = [...values].sort((a, b) => a - b), mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}
export function compare(base, head) {
  for (const values of [base, head]) check(values.length >= 10 && values.every(n => Number.isFinite(n) && n > 0), '至少需要 10 个独立进程的有效正数样本');
  // Fixed seed makes the summary reproducible, not the measurements.
  let seed = 123456789;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  const resample = a => Array.from({length: a.length}, () => a[Math.floor(random() * a.length)]);
  const gain = (a, b) => (1 - median(b) / median(a)) * 100;
  const bootstrap = Array.from({length: 4000}, () => gain(resample(base), resample(head))).sort((a,b) => a-b);
  const improvementPercent = gain(base, head);
  const ci95 = [bootstrap[100], bootstrap[3899]];
  return {baseMedianNs: median(base), headMedianNs: median(head), improvementPercent, ci95,
    reproducibleImprovement: improvementPercent > 0 && ci95[0] > 0};
}
async function git(repoRoot, args) {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

export async function getSourceMetadata(repoRoot) {
  const root = resolve(repoRoot);
  const revision = await git(root, ["rev-parse", "HEAD"]);
  const branch = await git(root, ["branch", "--show-current"]);
  const status = (await git(root, ["status", "--short"])) ?? "";
  const diff =
    (await git(root, ["diff", "--no-ext-diff", "--binary", "HEAD"])) ?? "";
  return {
    repoRoot: root,
    revision,
    branch,
    dirty: status.length > 0,
    dirtyPaths: status.split("\n").filter(Boolean),
    dirtyFingerprint: createHash("sha256")
      .update(status)
      .update("\0")
      .update(diff)
      .digest("hex"),
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
  };
}


export function validateIteration(row, session) {
  check(row.schemaVersion === 1, 'schemaVersion 必须为 1');
  check(row.round === session.attempts.length + 1 && row.round <= session.maxRounds, '轮次不连续或超过上限');
  check(typeof row.hypothesis === 'string' && row.hypothesis.trim(), '缺少假设');
  check(row.baseRevision === session.comparisonPoint, 'baseRevision 不匹配当前比较点');
  check(typeof row.candidateRevision === 'string' && row.candidateRevision !== row.baseRevision, '需要不同的候选版本');
  check(['accepted','rejected-performance','rejected-correctness','inconclusive'].includes(row.decision), '无效决定');
  if (row.decision === 'accepted') {
    check(row.correctness?.status === 'passed' && row.correctness.evidencePath, '缺少正确性证据');
    check(row.bench?.evidencePath && row.bench.result?.reproducibleImprovement === true, '独立 bench 未稳定复现改善');
    check(row.bench.confirmationPath && row.bench.confirmation?.reproducibleImprovement === true, '缺少独立复测证据');
    check(row.project?.status === 'passed' && row.project.evidencePath && row.project.noRegression === true, '缺少实际项目验证/无回退证据');
  } else {
    check(row.rollback?.status === 'reverted' && row.rollback.revision === session.comparisonPoint && row.rollback.evidencePath, '未接受的优化必须先回退并提供核对证据');
  }
  return row;
}

// Hash complete declared outputs, not only a JS loader that may load an old addon.
export async function snapshotArtifacts(paths) {
  const hashes = {};
  const visited = new Set();
  async function visit(input) {
    const path = await realpath(resolve(input));
    if (visited.has(path)) return;
    visited.add(path);
    if ((await stat(path)).isDirectory()) {
      for (const name of (await readdir(path)).sort()) await visit(resolve(path, name));
    } else hashes[path] = sha256(await readFile(path));
  }
  for (const path of paths) await visit(path);
  return Object.fromEntries(Object.entries(hashes).sort(([a],[b]) => a.localeCompare(b)));
}

export function measurementConditions(result) {
  const conditions = {caseHashes:result.caseHashes, context:result.context, node:result.node,
    platform:result.platform, arch:result.arch, unsetEnv:result.unsetEnv || []};
  check(conditions.caseHashes && conditions.context && conditions.node && conditions.platform && conditions.arch, 'bench 缺少冻结条件');
  return sha256(JSON.stringify(conditions));
}

export function validateConfirmation(result, confirmation) {
  check(typeof result.runId === 'string' && typeof confirmation.runId === 'string' && result.runId !== confirmation.runId,
    '需要不同 runId 的独立复测，不能复用同一结果');
  check(confirmation.kind === 'measurement' && JSON.stringify(result.revisions) === JSON.stringify(confirmation.revisions), '复测版本不匹配');
  check(measurementConditions(result) === measurementConditions(confirmation), '复测条件不同');
  check(result.artifacts && confirmation.artifacts &&
    JSON.stringify(result.artifacts) === JSON.stringify(confirmation.artifacts), '复测产物不同或缺少产物记录');
  const comparison = compare(confirmation.samples.base, confirmation.samples.head);
  check(comparison.reproducibleImprovement, '独立复测没有稳定复现改善');
  return comparison;
}
