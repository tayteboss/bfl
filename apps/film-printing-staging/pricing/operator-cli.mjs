// Separate operator executable, absent from the runtime image. Remote mode must
// be explicit. Never discovers credentials, initializes storage or releases locks.
import {readFileSync,writeFileSync,lstatSync,openSync,closeSync,fsyncSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {readConfig,need,safeCode} from '../backend/config.mjs';
import {parseStrictJson} from './prepare.mjs';
import {runPricingOperator} from './operator.mjs';

function read(path,max=262144) {
  const s=lstatSync(path);need(s.isFile()&&!s.isSymbolicLink()&&s.size<=max,'OPERATOR_INPUT_INVALID');
  return readFileSync(path,'utf8');
}
try {
  const [action,sourceArg,mappingArg,bundleArg,version,reviewArg,outputArg,...extra]=process.argv.slice(2);
  need(['inspect','apply','recover'].includes(action)&&sourceArg&&mappingArg&&bundleArg&&version&&reviewArg&&outputArg&&!extra.length,'OPERATOR_USAGE');
  need(process.env.BFL_PRICING_OPERATOR===action,'OPERATOR_DISABLED');
  need(process.env.BFL_ALL_WRITERS_STOPPED==='yes','STOP_ALL_WRITERS_FIRST');
  const config=readConfig(),source=resolve(sourceArg),bundleDir=resolve(bundleArg);
  need(config.mode==='disabled','RUNTIME_WRITES_MUST_BE_DISABLED');
  const input={capture:parseStrictJson(read(join(source,'source-export.json'))),metafieldValue:read(join(source,'metafield-value.json')),
    script:read(join(source,'source/film-service.js')),section:read(join(source,'source/film-printing.liquid')),mapping:parseStrictJson(read(resolve(mappingArg)))};
  const prepared={catalogValue:read(join(bundleDir,'price-catalog.proposed.json')),formValue:read(join(bundleDir,'film-services.proposed.json')),expectedVersion:version};
  let review;
  if(action==='inspect')need(reviewArg==='-','OPERATOR_USAGE');
  else {
    const path=resolve(reviewArg),s=lstatSync(path);need((s.mode&0o077)===0&&s.nlink===1,'PRIVATE_REVIEW_REQUIRED');
    review=parseStrictJson(read(path));
  }
  // Reserve a new private receipt BEFORE any remote action. Existing receipts
  // are never overwritten; a crash leaves a clearly incomplete empty file.
  const fd=openSync(resolve(outputArg),'wx',0o600);
  try {
    const result=await runPricingOperator({action,mode:process.env.BFL_PRICING_OPERATOR,config,input,prepared,review,allWritersStopped:true});
    writeFileSync(fd,JSON.stringify(result,null,2)+'\n');fsyncSync(fd);
    console.log(JSON.stringify({status:action==='inspect'?'unreviewed_inspection_saved':result.status,checkout_ready:false}));
  } finally{closeSync(fd);}
} catch(e){console.error(JSON.stringify({error:safeCode(e),checkout_ready:false}));process.exitCode=1;}
