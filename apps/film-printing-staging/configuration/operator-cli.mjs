// Separate executable, intentionally excluded from the runtime image.
import {lstatSync,readFileSync,openSync,writeFileSync,fsyncSync,closeSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {readConfig,need,safeCode} from '../backend/config.mjs';
import {parseStrictJson} from '../pricing/prepare.mjs';
import {runConfigurationOperator} from './operator.mjs';

try {
  const [action,version,reviewArg,outputArg,...extra]=process.argv.slice(2);
  need(['inspect','apply','recover'].includes(action)&&version&&reviewArg&&outputArg&&!extra.length,'OPERATOR_USAGE');
  // Disabled before reading credentials, private storage or network.
  need(process.env.BFL_CONFIGURATION_OPERATOR===action,'OPERATOR_DISABLED');
  need(process.env.BFL_ALL_WRITERS_STOPPED==='yes','STOP_ALL_WRITERS_FIRST');
  let review,expectedVersion;
  if(action==='inspect')need(version==='-'&&reviewArg==='-','OPERATOR_USAGE');
  else {
    expectedVersion=version;
    const path=resolve(reviewArg),s=lstatSync(path);
    need(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&(s.mode&0o077)===0&&s.size<=262144,'PRIVATE_REVIEW_REQUIRED');
    review=parseStrictJson(new TextDecoder('utf-8',{fatal:true}).decode(readFileSync(path)));
  }
  const config=readConfig();need(config.mode==='disabled','RUNTIME_WRITES_MUST_BE_DISABLED');
  // Exclusive, private, durable receipt reservation precedes any remote request.
  // A crash/unknown outcome leaves the receipt incomplete; never overwrite it.
  const output=resolve(outputArg),parent=dirname(output),directory=lstatSync(parent);
  need(directory.isDirectory()&&!directory.isSymbolicLink()&&(directory.mode&0o077)===0,'PRIVATE_RECEIPT_DIRECTORY_REQUIRED');
  const fd=openSync(output,'wx',0o600);
  try {
    fsyncSync(fd);
    const parentFd=openSync(parent,'r');try{fsyncSync(parentFd);}finally{closeSync(parentFd);}
    const result=await runConfigurationOperator({action,mode:process.env.BFL_CONFIGURATION_OPERATOR,config,expectedVersion,review,allWritersStopped:true});
    writeFileSync(fd,JSON.stringify(result,null,2)+'\n');fsyncSync(fd);
    console.log(JSON.stringify({status:action==='inspect'?'unreviewed_inspection_saved':result.status,checkout_ready:false}));
  } finally{closeSync(fd);}
} catch(e){console.error(JSON.stringify({error:safeCode(e),checkout_ready:false}));process.exitCode=1;}
