#!/usr/bin/env node
import { harnesses } from './harnesses.mjs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, copyFile, stat } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { check, cleanEnvironment, compare, getSourceMetadata, readJSON, sha256, validateIteration, writeJSON, snapshotArtifacts, measurementConditions, validateConfirmation } from './lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const help = `Rspack 绑定性能工具（Node.js >= 22）
  trace --repo PATH --output DIR [--sftrace PATH] [--convert pola|none]
        [--trace-timeout-ms 300000] [--convert-timeout-ms 300000] -- COMMAND...
  harness-list
  bench-init --dir DIR --evidence SUMMARY.json --api NAME [--harness NAME]
  bench --case DIR --base BASE_ENTRY --head HEAD_ENTRY --base-rev REV --head-rev REV
        --context CONTEXT.json --output DIR [--artifacts ARTIFACTS.json] [--samples 12] [--unset-env A,B]
  session-init --dir DIR --baseline REV [--max-rounds 10]
  session-record --dir DIR --result ITERATION.json
  session-status --dir DIR

trace 记录完整 sftrace 日志并转换为 Parquet；热点分析默认运行 sftrace_index.py prepare/overview/summary。
bench 只加载非插桩产物；base/head 交错、进程隔离，输出原始样本与置信区间。
所有输出目录必须是新目录，避免覆盖证据。详细合同见 references/。`;

async function run(command, args, {cwd, env = process.env, logPath, timeout = 300000} = {}) {
  const log = logPath ? createWriteStream(logPath, {flags: 'wx'}) : null;
  let logError;
  log?.on('error', error => { logError = error; });
  const child = spawn(command, args, {cwd, env, stdio: ['ignore', 'pipe', 'pipe']});
  for (const [input, output] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    input.on('data', chunk => { output.write(chunk); log?.write(chunk); });
  }
  const handlers = ['SIGINT','SIGTERM'].map(signal => {
    const handler = () => child.kill(signal);
    process.on(signal, handler);
    return [signal, handler];
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
  try {
    await new Promise((accept, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => code === 0 ? accept() : reject(new Error(`${command} 失败: ${timedOut ? '超时' : code ?? signal}`)));
    });
  } finally {
    clearTimeout(timer);
    for (const [signal, handler] of handlers) process.off(signal, handler);
    if (log && !log.destroyed) await new Promise(done => { log.once('close', done); log.end(); });
  }
  if (logError) throw logError;
}

async function newDirectory(path) {
  const dir = resolve(path);
  await mkdir(dirname(dir), {recursive: true});
  await mkdir(dir); // EEXIST is intentional: never overwrite prior evidence.
  return dir;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || ['--help','-h'].includes(command)) return console.log(help);
  const names = ['harness','trace-timeout-ms','convert-timeout-ms','convert','repo','output','sftrace','dir','evidence','api','case','base','head','base-rev','head-rev','context','artifacts','samples','unset-env','baseline','max-rounds','result'];
  const {values: o, positionals} = parseArgs({args, options: Object.fromEntries(names.map(name => [name, {type:'string'}])), allowPositionals:true});
  const required = name => { check(o[name]?.trim(), `缺少 --${name}`); return o[name]; };
  switch (command) {
    case 'trace': {
      check(positionals.length, '在 -- 后提供实际负载命令');
      const convert = o.convert || 'pola';
      check(['pola','none'].includes(convert), '--convert 为 pola 或 none');
      const recordTimeout = Number(o['trace-timeout-ms'] || 300000);
      const convertTimeout = Number(o['convert-timeout-ms'] || 300000);
      check([recordTimeout,convertTimeout].every(n=>Number.isSafeInteger(n) && n>0), '超时必须为正整数毫秒');
      const dir = await newDirectory(required('output'));
      const repo = resolve(required('repo'));
      const metadata = {schemaVersion:1, kind:'diagnostic', benchmarkEligible:false, command:positionals,
        startedAt:new Date().toISOString(), source:await getSourceMetadata(repo)};
      await writeJSON(join(dir,'metadata.json'), metadata);
      try {
        const trace = join(dir,'sf.log');
        // Clear inherited filters so recording includes all available native frames.
        const env = {...process.env};
        delete env.SFTRACE_FILTER;
        delete env.SFTRACE_SETUP_THREAD_ONLY;
        await run(o.sftrace || 'sftrace', ['record','-o',trace,'--',...positionals], {cwd:repo, env, logPath:join(dir,'record.log'),timeout:recordTimeout});
        check((await stat(trace)).size > 0, 'sftrace 未生成有效日志；检查 XRay、setup 和加载的 addon');
        if (convert === 'pola') await run(o.sftrace || 'sftrace', ['convert','--type','pola',trace,'-o',join(dir,'sf.pola')], {cwd:repo, logPath:join(dir,'convert.log'),timeout:convertTimeout});
        metadata.status = 'passed';
        metadata.converted = convert === 'pola';
      } catch (error) { metadata.status = 'failed'; metadata.error = error.message; throw error; }
      finally { metadata.finishedAt = new Date().toISOString(); await writeJSON(join(dir,'metadata.json'),metadata,'w'); }
      console.log(convert === 'pola' ? `python3 ${join(here,'sftrace_index.py')} prepare --path ${join(dir,'sf.pola')} --index ${join(dir,'index')}` : `原始 trace 已保存：${join(dir,'sf.log')}；单独转换后建立索引。`);
      break;
    }
    case 'harness-list': console.log(JSON.stringify(harnesses,null,2)); break;
    case 'bench-init': {
      const source = resolve(required('evidence'));
      const evidence = await readJSON(source);
      check(evidence.kind === 'sftrace-summary' && evidence.hotspots?.length > 0, '需要非空 sftrace 热点摘要');
      const api = required('api');
      const harness = harnesses[o.harness || 'custom'];
      check(harness, '未知 harness；先运行 harness-list');
      const dir = await newDirectory(required('dir'));
      await copyFile(join(here,'../assets',harness.file),join(dir,'case.mjs'));
      for (const file of harness.helpers) await copyFile(join(here,'../assets',file),join(dir,file.split('/').at(-1)));
      await copyFile(source,join(dir,'trace-evidence.json'));
      await writeJSON(join(dir,'manifest.json'),{schemaVersion:1, api, evidence:source,
        evidenceHash:sha256(await readFile(source)), tid:evidence.tid,
        mapping:'请填写 trace 符号/调用方与 case 的生产代码对应关系',
        inputContract:'请填写数据规模、分布、命中/失效比例和固定 fixture',
        harness:o.harness || 'custom',
        fixtureFiles:harness.helpers.map(file => file.split('/').at(-1))});
      console.log(dir);
      break;
    }
    case 'bench': {
      const caseDir = resolve(required('case'));
      const manifest = await readJSON(join(caseDir,'manifest.json'));
      check(['mapping','inputContract'].every(k => typeof manifest[k] === 'string' && !manifest[k].startsWith('请填写') && manifest[k].trim()), '先完成 case 的生产路径映射和输入合同');
      const context = await readJSON(resolve(required('context')));
      check(context.instrumentation === false && typeof context.rust === 'string' && typeof context.buildCommand === 'string' && typeof context.profile === 'string' && (context.profile === 'release' || context.optimized === true) && typeof context.host === 'string', 'context 需要 instrumentation:false、rust、host、buildCommand、优化 profile（非 release 需 optimized:true）');
      const count = Number(o.samples || 12);
      check(Number.isInteger(count) && count >= 10 && count <= 1000, 'samples 取 10..1000');
      const paths = {base:resolve(required('base')), head:resolve(required('head'))};
      const revisions = {base:required('base-rev'), head:required('head-rev')};
      check(paths.base !== paths.head, 'base/head 需要独立产物路径，不能覆盖基线');
      const declared = o.artifacts ? await readJSON(resolve(o.artifacts)) : {base:[],head:[]};
      check(Array.isArray(declared.base) && Array.isArray(declared.head), 'artifacts 需要 base/head 文件或目录数组');
      check(o.artifacts || Object.values(paths).every(path => path.endsWith('.node')), 'JS 入口必须通过 --artifacts 声明 JS 输出及实际 native addon');
      const artifacts = {};
      for (const side of ['base','head']) artifacts[side] = await snapshotArtifacts([paths[side],...declared[side]]);
      const hashes = {};
      for (const [name,path] of Object.entries(paths)) hashes[name] = sha256(await readFile(path));
      const caseHashes = {};
      for (const file of ['case.mjs','manifest.json','trace-evidence.json',...(manifest.fixtureFiles || [])]) {
        const path = resolve(caseDir,file);
        caseHashes[file] = sha256(await readFile(path));
      }
      check(caseHashes['trace-evidence.json'] === manifest.evidenceHash, 'trace 证据已改变');
      const dir = await newDirectory(required('output'));
      const unsetEnv = (o['unset-env'] || '').split(',').filter(Boolean).sort();
      const metadata = {schemaVersion:1, kind:'measurement', runId:randomUUID(), paths, revisions, hashes, artifacts, caseHashes, caseDir, context, unsetEnv,
        node:process.version, platform:process.platform, arch:process.arch, startedAt:new Date().toISOString()};
      await writeJSON(join(dir,'metadata.json'),metadata);
      const samples = {base:[],head:[]};
      const env = cleanEnvironment(process.env, unsetEnv);
      for (const side of ['base','head']) await writeJSON(join(dir,`${side}-artifacts.json`),artifacts[side]);
      try {
        for (let i=0;i<count;i++) {
          for (const side of i % 2 ? ['head','base'] : ['base','head']) {
            const samplePath = join(dir,`${side}-${i}.json`);
            await run(process.execPath,[join(here,'bench-worker.mjs'),join(caseDir,'case.mjs'),paths[side],samplePath,join(dir,`${side}-artifacts.json`)],
              {cwd:caseDir,env,logPath:join(dir,`${side}-${i}.log`),timeout:60000});
            const sample = await readJSON(samplePath);
            check(sample.elapsedNs >= 1e6, '单批计时不足 1ms，请增大 iterations 并重建基线');
            samples[side].push(sample.nsPerOp);
          }
        }
        for (const side of ['base','head']) check(JSON.stringify(await snapshotArtifacts([paths[side],...declared[side]])) === JSON.stringify(artifacts[side]), '测量期间 JS/native 产物被修改');
        for (const [file,hash] of Object.entries(caseHashes)) check(sha256(await readFile(resolve(caseDir,file))) === hash, '测量期间 case/fixture 被修改');
        const comparison = compare(samples.base,samples.head);
        const result = {...metadata, finishedAt:new Date().toISOString(), samples, comparison};
        await writeJSON(join(dir,'result.json'),result);
        console.log(JSON.stringify(comparison,null,2));
      } catch(error) { await writeJSON(join(dir,'failure.json'),{error:error.message,samples}); throw error; }
      break;
    }
    case 'session-init': {
      const baseline = required('baseline');
      const maxRounds = Number(o['max-rounds'] || 10);
      check(Number.isInteger(maxRounds) && maxRounds > 0, '无效轮数');
      const dir = await newDirectory(required('dir'));
      await writeJSON(join(dir,'session.json'),{schemaVersion:1, baseline, comparisonPoint:baseline, maxRounds, attempts:[]});
      break;
    }
    case 'session-record': {
      const file = resolve(required('dir'),'session.json');
      const session = await readJSON(file);
      const row = await readJSON(resolve(required('result')));
      if (row.decision === 'accepted') {
        const result = await readJSON(resolve(row.bench?.evidencePath || ''));
        check(result.kind === 'measurement' && result.revisions.base === row.baseRevision && result.revisions.head === row.candidateRevision, 'bench 版本不匹配');
        row.bench.result = compare(result.samples.base, result.samples.head);
        check(row.bench.result.reproducibleImprovement, '独立 bench 未稳定复现改善');
        check(row.bench.confirmationPath, '缺少独立复测证据');
        const confirmation = await readJSON(resolve(row.bench.confirmationPath));
        row.bench.confirmation = validateConfirmation(result,confirmation);
        const fingerprint = measurementConditions(result);
        check(!session.conditionsFingerprint || session.conditionsFingerprint === fingerprint, 'case/输入/运行条件发生改变，必须建立新会话与基线');
        session.conditionsFingerprint = fingerprint;
      }
      validateIteration(row,session);
      const evidencePaths = row.decision === 'accepted' ? [row.correctness.evidencePath,row.project.evidencePath] : [row.rollback.evidencePath];
      for (const path of evidencePaths) check((await stat(resolve(path))).size > 0, `证据文件为空: ${path}`);
      session.attempts.push({...row, recordedAt:new Date().toISOString()});
      if (row.decision === 'accepted') session.comparisonPoint = row.candidateRevision;
      await writeJSON(file,session,'w');
      console.log(JSON.stringify(session,null,2));
      break;
    }
    case 'session-status': console.log(JSON.stringify(await readJSON(resolve(required('dir'),'session.json')),null,2)); break;
    default: throw new Error(`未知命令: ${command}`);
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
