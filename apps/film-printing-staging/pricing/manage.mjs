// Read local authenticated-source exports, write a NEW review directory. No network,
// credential discovery, runtime activation, or remote import/publication command.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {parseStrictJson,prepareCatalog,verifyPreparedCatalog} from './prepare.mjs';

const args=process.argv.slice(2);
const verify=args[0]==='--verify';if(verify)args.shift();
if(verify?args.length!==4:args.length!==3 && args.length!==4)throw Error('Usage: node pricing/manage.mjs SOURCE_DIRECTORY REVIEWED_MAPPING_JSON NEW_OUTPUT_DIRECTORY [PREVIOUS_CATALOG_JSON]\nVerify: node pricing/manage.mjs --verify SOURCE_DIRECTORY REVIEWED_MAPPING_JSON OUTPUT_DIRECTORY EXPECTED_PRICE_VERSION');
const [source,mappingFile,out]=args.slice(0,3).map(p=>resolve(p));
const previousFile=!verify&&args[3]?resolve(args[3]):null;
const read=p=>readFile(p,'utf8');
const [capture,metafieldValue,script,section,mapping,previous]=await Promise.all([
  read(join(source,'source-export.json')).then(parseStrictJson),read(join(source,'metafield-value.json')),
  read(join(source,'source/film-service.js')),read(join(source,'source/film-printing.liquid')),
  read(mappingFile).then(parseStrictJson),previousFile?read(previousFile).then(parseStrictJson):null,
]);
const input={capture,metafieldValue,script,section,mapping};
if(verify) {
  const result=verifyPreparedCatalog(input,{catalogValue:await read(join(out,'price-catalog.proposed.json')),formValue:await read(join(out,'film-services.proposed.json')),expectedVersion:args[3]});
  console.log(JSON.stringify({status:'verified_local_import_bytes',price_version:result.version,rows:result.catalog.rows.length,checkout_ready:false}));
  process.exit(0);
}
const result=prepareCatalog(input,previous);
await mkdir(out); // Deliberately refuses to overwrite an earlier review/import bundle.
for(const [name,value] of Object.entries({
  'price-catalog.proposed.json':result.value,
  'film-services.proposed.json':result.formValue,
  'diagnostics.json':JSON.stringify(result.diagnostics,null,2)+'\n',
  'selections.json':JSON.stringify(result.selections,null,2)+'\n',
}))await writeFile(join(out,name),value,{flag:'wx'});
console.log(JSON.stringify({status:result.diagnostics.status,rows:result.catalog.rows.length,price_version:result.version,checkout_ready:false,output:out}));
