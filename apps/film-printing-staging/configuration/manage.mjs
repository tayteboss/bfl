import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { graphql } from './cli.mjs';
import { definitions, groupTypes } from './schema.mjs';
import { validateConfig } from './config.mjs';
import { ACTIVE_QUERY, assertIdentity, mutationResult, encodeRecord, readDrafts, publishDrafts, createConfigLoader } from './shopify.mjs';

export async function importDrafts(config, api = graphql) {
  validateConfig(config); assertIdentity(await api(ACTIVE_QUERY));
  const resources = [];
  for (const definition of definitions) {
    const existing = await api('query Definition($type: String!) { metaobjectDefinitionByType(type: $type) { id type fieldDefinitions { key type { name } required } access { admin storefront } } }', { type: definition.type });
    if (existing.metaobjectDefinitionByType) {
      const d = existing.metaobjectDefinitionByType;
      if (d.access.storefront !== 'NONE' || JSON.stringify(d.fieldDefinitions.map(f => [f.key,f.type.name,f.required]).sort()) !== JSON.stringify(definition.fieldDefinitions.map(f => [f.key,f.type,f.required]).sort())) throw Error(`Definition mismatch: ${definition.type}`);
      resources.push(d);
    } else {
      const result = mutationResult(await api('mutation Definition($definition: MetaobjectDefinitionCreateInput!) { metaobjectDefinitionCreate(definition: $definition) { metaobjectDefinition { id type access { admin storefront } } userErrors { field code message } } }', { definition }), 'metaobjectDefinitionCreate');
      resources.push(result.metaobjectDefinition);
    }
  }
  for (const [group,type] of Object.entries(groupTypes)) for (const row of config[group]) {
    const found = await api('query Record($handle: MetaobjectHandleInput!) { metaobjectByHandle(handle: $handle) { id } }', { handle: { type, handle: row.id } });
    if (found.metaobjectByHandle) throw Error(`Import is create-only; existing record ${type}/${row.id}. Edit it in Admin; do not overwrite.`);
    const result = mutationResult(await api('mutation Record($metaobject: MetaobjectCreateInput!) { metaobjectCreate(metaobject: $metaobject) { metaobject { id type handle } userErrors { field code message } } }', { metaobject: { type, handle: row.id, fields: encodeRecord(row) } }), 'metaobjectCreate');
    resources.push(result.metaobject);
  }
  return resources;
}
async function main() {
  const [command,input,output] = process.argv.slice(2);
  let result;
  if (command === 'import') result = await importDrafts(JSON.parse(await readFile(input,'utf8')));
  else if (command === 'validate') { assertIdentity(await graphql(ACTIVE_QUERY)); result = await readDrafts(graphql); }
  else if (command === 'publish') result = await publishDrafts(graphql);
  else if (command === 'read') result = await createConfigLoader(graphql).load({ fresh: true });
  else throw Error('Usage: node configuration/manage.mjs import FILE [OUTPUT] | validate | publish | read');
  if (output) await writeFile(output, JSON.stringify(result,null,2)+'\n');
  else process.stdout.write(JSON.stringify(result,null,2)+'\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
