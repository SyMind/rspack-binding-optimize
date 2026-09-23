import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, copyFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { cleanEnvironment, compare, validateIteration, snapshotArtifacts, validateConfirmation } from '../skills/rspack-binding-optimize/scripts/lib.mjs';
const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../skills/rspack-binding-optimize/scripts/cli.mjs',import.meta.url));
const worker = fileURLToPath(new URL('../skills/rspack-binding-optimize/scripts/bench-worker.mjs',import.meta.url));
const run = (...args) => exec(process.execPath,[cli,...args]);
const json = async path => JSON.parse(await readFile(path,'utf8'));
async function temp(t) { const dir = await mkdtemp(join(tmpdir(),'rspack-binding-perf-test-')); t.after(() => rm(dir,{recursive:true,force:true})); return dir; }
const session = {attempts:[],maxRounds:3,comparisonPoint:'base'};
const rejected = {schemaVersion:1,round:1,hypothesis:'convert once',baseRevision:'base',candidateRevision:'head',decision:'rejected-performance',rollback:{status:'reverted',revision:'base',evidencePath:'check.log'}};

test('收益判定：接受微小但稳定的改善，拒绝相同和退化',() => {
  const a = Array(12).fill(100);
  assert.equal(compare(a,Array(12).fill(80)).reproducibleImprovement,true);
  assert.equal(compare(a,Array(12).fill(99.99)).reproducibleImprovement,true);
  assert.equal(compare(a,a).reproducibleImprovement,false);
  assert.equal(compare(a,Array(12).fill(120)).reproducibleImprovement,false);
  assert.throws(() => compare([1],[1]),/10/);
  assert.throws(() => compare(a,Array(12).fill(NaN)),/正数/);
});
test('有噪音且区间跨零时拒绝',() => {
  const result = compare([50,60,70,80,90,100,110,120,130,140,150,160], [40,50,60,70,80,90,100,110,120,130,140,150]);
  assert(result.improvementPercent > 5);
  assert(result.ci95[0] < 0);
  assert.equal(result.reproducibleImprovement,false);
});
test('清理追踪与项目诊断变量而不改原环境',() => {
  const env = {PATH:'/bin',SFTRACE_OUTPUT_FILE:'x',XRAY_OPTIONS:'x',NAPI_BINDING_PROFILE:'1',EXTRA_PROFILE:'1'};
  assert.deepEqual(cleanEnvironment(env,['EXTRA_PROFILE']),{PATH:'/bin'});
  assert.equal(env.SFTRACE_OUTPUT_FILE,'x');
  assert.throws(() => cleanEnvironment({NODE_OPTIONS:'--cpu-prof'}),/诊断参数/);
});
test('未接受轮次必须回退；版本、轮数受约束',() => {
  assert.equal(validateIteration(rejected,session),rejected);
  assert.throws(() => validateIteration({...rejected,rollback:undefined},session),/回退/);
  assert.throws(() => validateIteration({...rejected,round:2},session),/轮次/);
  assert.throws(() => validateIteration({...rejected,baseRevision:'wrong'},session),/比较点/);
});
test('独立基准稳定改善且项目无回退即可接受，无需项目可见加速',() => {
  const row = {...rejected,decision:'accepted',correctness:{status:'passed',evidencePath:'x'},bench:{evidencePath:'x',result:{reproducibleImprovement:true},confirmationPath:'confirm',confirmation:{reproducibleImprovement:true}},project:{status:'passed',evidencePath:'x',noRegression:false}};
  assert.throws(() => validateIteration(row,session),/实际项目/);
  row.project.noRegression=true;
  assert.equal(validateIteration(row,session),row);
});
test('会话不覆盖旧证据，拒绝轮次不推进比较点',async t => {
  const dir=await temp(t), target=join(dir,'session'), log=join(dir,'rollback.log');
  await run('session-init','--dir',target,'--baseline','base');
  await assert.rejects(run('session-init','--dir',target,'--baseline','other'),/EEXIST/);
  await writeFile(log,'checked source and rebuilt\n');
  const file=join(dir,'iteration.json');
  await writeFile(file,JSON.stringify({...rejected,rollback:{...rejected.rollback,evidencePath:log}}));
  await run('session-record','--dir',target,'--result',file);
  const state=await json(join(target,'session.json'));
  assert.equal(state.baseline,'base'); assert.equal(state.comparisonPoint,'base'); assert.equal(state.attempts.length,1);
  await assert.rejects(run('session-record','--dir',target,'--result',file),/轮次/);
});
test('完整 bench CLI 进程隔离、校验和、原始样本及断言',async t => {
  const dir=await temp(t), source=join(dir,'trace.json'), caseDir=join(dir,'case');
  await writeFile(source,JSON.stringify({kind:'sftrace-summary',tid:7,hotspots:[{name:'convert'}]}));
  await run('bench-init','--dir',caseDir,'--evidence',source,'--api','target');
  // This fixture checks runner behavior only. It is not a production benchmark.
  const adapter=`import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
export const config={iterations:1,warmup:1};
export function setup({bindingPath}){assert.equal(process.env.SFTRACE_OUTPUT_FILE,undefined); return require(bindingPath);}
export function run(fn){return fn();}
export function verify(value){assert.equal(value,42);}`;
  await writeFile(join(caseDir,'case.mjs'),adapter);
  const manifest=await json(join(caseDir,'manifest.json'));
  manifest.mapping='fixture mapping';manifest.inputContract='constant integer';
  await writeFile(join(caseDir,'manifest.json'),JSON.stringify(manifest));
  const base=join(dir,'base.cjs'),head=join(dir,'head.cjs');
  await writeFile(base,'module.exports=()=>{const start=process.hrtime.bigint(); while(process.hrtime.bigint()-start<2000000n){};return 42;}');
  await copyFile(base,head);
  const context=join(dir,'context.json');
  await writeFile(context,JSON.stringify({instrumentation:false,profile:'release',rust:'fixture',host:'test',buildCommand:'test fixture'}));
  const artifacts=join(dir,'artifacts.json');
  await writeFile(artifacts,JSON.stringify({base:[base],head:[head]}));
  const output=join(dir,'run');
  await exec(process.execPath,[cli,'bench','--case',caseDir,'--base',base,'--head',head,'--base-rev','base','--head-rev','head','--context',context,'--artifacts',artifacts,'--output',output,'--samples','10'],{env:{...process.env,SFTRACE_OUTPUT_FILE:'should-be-cleared'}});
  const result=await json(join(output,'result.json'));
  assert.equal(result.samples.base.length,10);assert.equal(result.samples.head.length,10);
  assert.equal(result.hashes.base,result.hashes.head);
  assert.equal(Object.keys(result.caseHashes).length,3);
  assert.equal(result.kind,'measurement');
  await writeFile(join(caseDir,'case.mjs'),adapter.replace('assert.equal(value,42)','assert.equal(value,43)'));
  const failed=join(dir,'failed');
  await assert.rejects(exec(process.execPath,[worker,join(caseDir,'case.mjs'),base,failed]),/42 !== 43/);
  await assert.rejects(readFile(failed),/ENOENT/);
});
test('异步 case 会等待完成，错误的同步声明被拒绝',async t => {
  const dir=await temp(t),file=join(dir,'case.mjs'),output=join(dir,'result.json');
  const code=`export const config={iterations:2,warmup:0,async:true};
export const setup=()=>({}); export const run=async()=>{await new Promise(r=>setTimeout(r,2)); return 7;};
export const verify=v=>{if(v!==7)throw new Error('wrong');};`;
  await writeFile(file,code);
  await exec(process.execPath,[worker,file,'unused',output]);
  assert((await json(output)).nsPerOp > 1000000);
  await writeFile(file,code.replace('async:true','async:false'));
  await assert.rejects(exec(process.execPath,[worker,file,'unused',join(dir,'bad.json')]),/异步 case/);
});
test('session-record 重新计算原始样本，拒绝伪造 reproducibleImprovement',async t => {
  const dir=await temp(t),target=join(dir,'session'),result=join(dir,'bench.json'),rowPath=join(dir,'row.json');
  await run('session-init','--dir',target,'--baseline','base');
  await writeFile(result,JSON.stringify({kind:'measurement',revisions:{base:'base',head:'head'},samples:{base:Array(10).fill(100),head:Array(10).fill(100)},comparison:{reproducibleImprovement:true},caseHashes:{case:'hash'},context:{profile:'release'},node:'22',platform:'test',arch:'test'}));
  await writeFile(rowPath,JSON.stringify({...rejected,decision:'accepted',correctness:{status:'passed',evidencePath:'x'},bench:{evidencePath:result,result:{reproducibleImprovement:true}}}));
  await assert.rejects(run('session-record','--dir',target,'--result',rowPath),/bench 未稳定复现改善/);
  assert.equal((await json(join(target,'session.json'))).attempts.length,0);
});
test('trace 委托 record/convert 并保留失败元信息',async t => {
  const dir=await temp(t),fake=join(dir,'sftrace'),out=join(dir,'trace');
  await writeFile(fake,`#!${process.execPath}\nconst fs=require('fs');const args=process.argv.slice(2);if(args[0]==='record'){fs.writeFileSync(args[args.indexOf('-o')+1],'test trace');} else {fs.writeFileSync(args[args.indexOf('-o')+1],'test parquet');}`,{mode:0o755});
  await run('trace','--repo',dir,'--output',out,'--sftrace',fake,'--','node','workload.cjs');
  assert.equal((await json(join(out,'metadata.json'))).status,'passed');
  const raw=join(dir,'raw');
  await run('trace','--repo',dir,'--output',raw,'--sftrace',fake,'--convert','none','--','node','workload.cjs');
  assert.equal((await json(join(raw,'metadata.json'))).converted,false);
  assert.equal(await readFile(join(raw,'sf.log'),'utf8'),'test trace');
  await assert.rejects(readFile(join(raw,'sf.pola')),/ENOENT/);
  await assert.rejects(run('trace','--repo',dir,'--output',join(dir,'bad'),'--sftrace',join(dir,'missing'),'--','node','x'),/ENOENT/);
  assert.equal((await json(join(dir,'bad','metadata.json'))).status,'failed');
});
test('接受微小稳定改善后前移比较点，保留基线并拒绝改变 case',async t => {
  const dir=await temp(t),target=join(dir,'session'),result=join(dir,'bench.json'),rowPath=join(dir,'row.json'),log=join(dir,'checks.log');
  await run('session-init','--dir',target,'--baseline','base');
  await writeFile(log,'correctness and real project comparisons reviewed');
  const measurement={kind:'measurement',runId:'first',artifacts:{base:{file:'baseHash'},head:{file:'headHash'}},revisions:{base:'base',head:'head'},samples:{base:Array(10).fill(100),head:Array(10).fill(99.99)},caseHashes:{case:'hash'},context:{profile:'release'},node:'22',platform:'test',arch:'test'};
  await writeFile(result,JSON.stringify(measurement));
  const confirm=join(dir,'confirm.json');
  await writeFile(confirm,JSON.stringify({...measurement,runId:'confirmation'}));
  const row={...rejected,decision:'accepted',correctness:{status:'passed',evidencePath:log},bench:{evidencePath:result,confirmationPath:confirm},project:{status:'passed',noRegression:true,evidencePath:log}};
  await writeFile(rowPath,JSON.stringify(row));
  await run('session-record','--dir',target,'--result',rowPath);
  const state=await json(join(target,'session.json'));
  assert.equal(state.baseline,'base');assert.equal(state.comparisonPoint,'head');
  measurement.revisions={base:'head',head:'second'};measurement.caseHashes.case='changed';
  await writeFile(result,JSON.stringify(measurement));
  await writeFile(confirm,JSON.stringify({...measurement,runId:'second-confirmation'}));
  await writeFile(rowPath,JSON.stringify({...row,round:2,baseRevision:'head',candidateRevision:'second'}));
  await assert.rejects(run('session-record','--dir',target,'--result',rowPath),/新会话/);
  assert.equal((await json(join(target,'session.json'))).attempts.length,1);
});
test('withContext 在同步 callback 有效窗口内完成测量和断言',async t => {
  const dir=await temp(t), file=join(dir,'case.mjs'), output=join(dir,'result.json');
  await writeFile(file,`export const config={iterations:3,warmup:2};
export function withContext({measure}) { const ctx={active:true,count:0}; try { measure(ctx); } finally {ctx.active=false;} }
export function beforeSample(ctx) {ctx.count=0;}
export function run(ctx) {if(!ctx.active)throw new Error('stale'); return ++ctx.count;}
export function verify(v,ctx) {if(!ctx.active || v!==3)throw new Error('outside scope or warmup leaked');}`);
  await exec(process.execPath,[worker,file,'unused',output]);
  assert.equal((await json(output)).iterations,3);
  await writeFile(file,`export const run=()=>1; export const verify=()=>{}; export function withContext(){}`);
  await assert.rejects(exec(process.execPath,[worker,file,'unused',join(dir,'bad.json')]),/没有调用 measure/);
});
test('withContext 保持异步 callback 生命周期并拒绝 detached 测量',async t => {
  const dir=await temp(t),file=join(dir,'case.mjs');
  const source=`export const config={iterations:2,warmup:0,async:true};
export async function withContext({measure}) { const ctx={active:true}; await measure(ctx); ctx.active=false; }
export async function run(ctx) {await new Promise(r=>setTimeout(r,2)); if(!ctx.active)throw new Error('stale'); return 1;}
export function verify(v){if(v!==1)throw new Error('wrong');}`;
  await writeFile(file,source);
  await exec(process.execPath,[worker,file,'unused',join(dir,'result.json')]);
  await writeFile(file,source.replace('await measure(ctx)','measure(ctx)'));
  await assert.rejects(exec(process.execPath,[worker,file,'unused',join(dir,'bad.json')]),/必须 await/);
});
test('产物快照包含 JS 入口间接引用文件并检测内容变化',async t => {
  const dir=await temp(t),a=join(dir,'entry.js'),b=join(dir,'native.node');
  await writeFile(a,'export const value=1;');await writeFile(b,'native fixture');
  const before=await snapshotArtifacts([dir]);
  await writeFile(b,'changed native fixture');
  const after=await snapshotArtifacts([dir]);
  assert.equal(before[Object.keys(before).find(p=>p.endsWith('entry.js'))],after[Object.keys(after).find(p=>p.endsWith('entry.js'))]);
  assert.notDeepEqual(before,after);
});
test('独立复测需不同 runId、相同产物和条件，且不能靠第一轮的偶然收益',() => {
  const result={kind:'measurement',runId:'first',revisions:{base:'a',head:'b'},artifacts:{base:{file:'a'},head:{file:'b'}},
    caseHashes:{case:'same'},context:{profile:'release'},node:'22',platform:'test',arch:'test',
    samples:{base:Array(10).fill(100),head:Array(10).fill(99.99)}};
  assert.throws(()=>validateConfirmation(result,result),/不同 runId/);
  assert.equal(validateConfirmation(result,{...result,runId:'second'}).reproducibleImprovement,true);
  assert.throws(()=>validateConfirmation(result,{...result,runId:'second',artifacts:{}}),/产物/);
  assert.throws(()=>validateConfirmation(result,{...result,runId:'second',samples:{base:Array(10).fill(100),head:Array(10).fill(100)}}),/复测没有/);
});
test('继承的 napi-rs addon 路径不能将 base/head 指向同一个二进制',() => {
  assert.deepEqual(cleanEnvironment({NAPI_RS_NATIVE_LIBRARY_PATH:'/wrong.node',NAPI_RS_FORCE_WASI:'1',PATH:'/bin'}),{PATH:'/bin'});
});
test('声明的 native addon 未被 JS 入口加载时拒绝结果',async t => {
  const dir=await temp(t),file=join(dir,'case.mjs'),native=join(dir,'expected.node'),audit=join(dir,'audit.json'),output=join(dir,'result.json');
  await writeFile(native,'not actually loaded');
  await writeFile(audit,JSON.stringify(await snapshotArtifacts([native])));
  await writeFile(file,'export const config={iterations:1,warmup:0}; export const setup=()=>({}); export const run=()=>1; export const verify=()=>{};');
  await assert.rejects(exec(process.execPath,[worker,file,'unused',output,audit]),/native addon 未加载/);
  await assert.rejects(readFile(output),/ENOENT/);
});
test('Rspack harness 初始化复制可独立运行的 helper 并将其纳入快照',async t => {
  const dir=await temp(t), evidence=join(dir,'trace.json');
  await writeFile(evidence,JSON.stringify({kind:'sftrace-summary',tid:7,hotspots:[{name:'get_assets'}]}));
  const list=JSON.parse((await run('harness-list')).stdout);
  for (const name of Object.keys(list).filter(name=>name!=='custom')) {
    const target=join(dir,name);
    await run('bench-init','--dir',target,'--evidence',evidence,'--api','Compilation','--harness',name);
    const manifest=await json(join(target,'manifest.json'));
    assert.equal(manifest.harness,name);
    assert.deepEqual(manifest.fixtureFiles,['compiler.mjs']);
    assert((await readFile(join(target,'compiler.mjs'),'utf8')).includes('compiler.close'));
    await exec(process.execPath,['--input-type=module','-e',`const c=await import(${JSON.stringify('file://'+join(target,'case.mjs'))}); if(!c.withContext||!c.run||!c.verify) process.exit(1);`]);
  }
  await assert.rejects(run('bench-init','--dir',join(dir,'bad'),'--evidence',evidence,'--api','x','--harness','missing'),/未知 harness/);
});
