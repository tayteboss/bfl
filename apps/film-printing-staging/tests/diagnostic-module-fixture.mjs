import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

// Local ES module files only: actual dispatcher/dependencies, with deliberate
// negative dependency variants. No server, browser, fetch or fake verifier.
export async function moduleGraph(t,{nativeSource,diagnosticSource,observer}={}){
 const dir=await mkdtemp(join(tmpdir(),'bfl-module-test-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 await writeFile(join(dir,'package.json'),' {"type":"module"}\n');
 for(const name of ['checkout-diagnostic.js','checkout-native-cases.js','resource-session.js','cart-locator.js']){
  const source=await readFile(new URL('../theme/'+name,import.meta.url),'utf8');
  await writeFile(join(dir,name),source);
 }
 if(nativeSource!==undefined)await writeFile(join(dir,'checkout-native-cases.js'),nativeSource);
 if(diagnosticSource!==undefined)await writeFile(join(dir,'checkout-diagnostic.js'),diagnosticSource);
 if(observer!==undefined){
  const real=new URL('../theme/checkout-native-cases.js',import.meta.url).href;
  await writeFile(join(dir,'checkout-native-cases.js'),`import {createNativeCases as create} from ${JSON.stringify(real)};
export const NATIVE_REVISION='f06p-native-preflight-v3';
export function createNativeCases(options){const original=create(options);const {preflightFailure,...rest}=original;return Object.freeze({...rest${observer==='missing'?'':','+observer}});}`);
 }
 return {dir,url:pathToFileURL(join(dir,'checkout-diagnostic.js')).href};
}
