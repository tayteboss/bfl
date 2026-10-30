// Local staging operator adapter; runtime consumers inject their own authenticated transport.
// No token extraction, callback, tunnel or deployment. Every operation pins store/app/path.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { CLIENT, STORE } from './schema.mjs';
const exec = promisify(execFile);
export const appPath = fileURLToPath(new URL('../', import.meta.url));
export async function graphql(query, variables = {}) {
  // Historical F03 proof/import commands remain preserved, but this candidate
  // transport is read-only. Future activation requires an explicit host adapter.
  if(!/^\s*query\b/.test(query))throw Error('REMOTE_MUTATIONS_DISABLED');
  const config = await readFile(join(appPath, 'shopify.app.staging.toml'), 'utf8');
  if (!config.includes(`client_id = "${CLIENT}"`) || !config.includes(`dev_store_url = "${STORE}"`)) throw Error('Staging config identity mismatch');
  const dir = await mkdtemp(join(tmpdir(), 'bfl-f03-'));
  try {
    await writeFile(join(dir, 'query.graphql'), query);
    await writeFile(join(dir, 'variables.json'), JSON.stringify(variables));
    try {
      await exec('shopify', ['app','execute','--config','staging','--path',appPath,'--store',STORE,'--version','2026-10','--no-input','--query-file',join(dir,'query.graphql'),'--variable-file',join(dir,'variables.json'),'--output-file',join(dir,'result.json')], { maxBuffer: 2 * 1024 * 1024, timeout: 90000 });
    } catch (error) { throw Error(`Shopify staging operation failed: ${error.stderr || error.message}`); }
    const result = JSON.parse(await readFile(join(dir,'result.json'),'utf8'));
    if (result.errors?.length) throw Error(`Shopify GraphQL errors: ${JSON.stringify(result.errors)}`);
    return result.data ?? result;
  } finally { await rm(dir, { recursive: true, force: true }); }
}
