// Optional integration smoke against explicitly provided, already-built local artifacts.
import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { mkdtemp, rm, writeFile, readFile, mkdir, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { harnesses } from '../skills/rspack-binding-optimize/scripts/harnesses.mjs';
import { snapshotArtifacts, cleanEnvironment } from '../skills/rspack-binding-optimize/scripts/lib.mjs';
const {values} = parseArgs({options:{entry:{type:'string'},native:{type:'string'}}});
assert(values.entry && values.native, '--entry JS_ENTRY --native ADDON.node required');
const dir = await mkdtemp(join(tmpdir(),'napi-rspack-smoke-'));
try {
  const expected = await snapshotArtifacts([values.native]);
  const audit = join(dir,'artifacts.json');
  await writeFile(audit,JSON.stringify(expected));
  for (const [name,harness] of Object.entries(harnesses)) {
    if (name==='custom') continue;
    const caseDir=join(dir,name), result=join(caseDir,'result.json');
    await mkdir(caseDir);
    const asset=file => fileURLToPath(new URL('../skills/rspack-binding-optimize/assets/'+file,import.meta.url));
    await copyFile(asset(harness.file),join(caseDir,'case.mjs'));
    for (const file of harness.helpers) await copyFile(asset(file),join(caseDir,file.split('/').at(-1)));
    await promisify(execFile)(process.execPath,[
      fileURLToPath(new URL('../skills/rspack-binding-optimize/scripts/bench-worker.mjs',import.meta.url)),
      join(caseDir,'case.mjs'),resolve(values.entry),result,audit],{env:cleanEnvironment(),timeout:60000}).catch(error => { console.error(error.stderr, error.stdout); throw error; });
    const data = JSON.parse(await readFile(result,'utf8'));
    assert(data.iterations>0);
    assert.deepEqual(data.loadedNativeModules,Object.keys(expected));
    console.log(`${name}: semantic assertion, lifecycle, native artifact audit passed`);
  }
} finally { await rm(dir,{recursive:true,force:true}); }
