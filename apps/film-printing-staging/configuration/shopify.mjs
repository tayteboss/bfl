import { APP, STORE, NAMESPACE, definitions, groupTypes } from './schema.mjs';
import { ConfigurationError, canonical, digest, makeRelease, verifyRelease, freeze, validateConfig } from './config.mjs';

export const ACTIVE_QUERY = `query BflActiveConfiguration {
  shop { myshopifyDomain }
  currentAppInstallation { id app { id } metafield(namespace: "${NAMESPACE}", key: "active_config") { value compareDigest } }
}`;
const META_FIELDS = 'id handle type updatedAt fields { key value }';
export function assertIdentity(data) {
  if (data.shop?.myshopifyDomain !== STORE || data.currentAppInstallation?.app?.id !== APP)
    throw new ConfigurationError('WRONG_TARGET', 'Expected isolated BFL staging store/app');
  return data.currentAppInstallation;
}
export function mutationResult(data, name) {
  const result = data[name];
  if (!result || result.userErrors?.length) throw new ConfigurationError('SHOPIFY_WRITE_REJECTED', JSON.stringify(result?.userErrors ?? name));
  return result;
}
export function decodeRecord(node, definition) {
  const row = { id: node.handle };
  for (const { key, value } of node.fields) {
    const spec = definition.fieldDefinitions.find(f => f.key === key);
    if (!spec) throw new ConfigurationError('UNKNOWN_FIELD', key);
    if (value === null || value === '') continue;
    row[key] = spec.type === 'json' || spec.type === 'boolean' || spec.type.startsWith('number_') ? JSON.parse(value) : value;
  }
  return row;
}
export function encodeRecord(row) {
  return Object.entries(row).filter(([key,value]) => key !== 'id' && value != null)
    .map(([key,value]) => ({ key, value: typeof value === 'string' ? value : JSON.stringify(value) }));
}
export async function readDrafts(graphql) {
  const config = { schema_version: 1, store: STORE };
  const records = [];
  for (const [group, type] of Object.entries(groupTypes)) {
    const data = await graphql(`query Drafts($type: String!) { metaobjects(type: $type, first: 250) { nodes { ${META_FIELDS} } pageInfo { hasNextPage } } }`, { type });
    if (data.metaobjects.pageInfo.hasNextPage) throw new ConfigurationError('TOO_MANY_RECORDS', type);
    config[group] = data.metaobjects.nodes.map(node => decodeRecord(node, definitions.find(d => d.type === type))).sort((a,b) => a.id.localeCompare(b.id));
    records.push(...data.metaobjects.nodes.map(({ id, updatedAt, handle, type }) => ({ id, updatedAt, handle, type })));
  }
  validateConfig(config);
  return { config, records: records.sort((a,b) => a.id.localeCompare(b.id)) };
}
export async function publishDrafts(graphql, {writesEnabled=false,lifecycle,now}={}) {
  if(!writesEnabled)throw new ConfigurationError('AUTHORITY_WRITES_DISABLED','Candidate source publication is disabled');
  if(!lifecycle)throw new ConfigurationError('LIFECYCLE_REQUIRED','Use the shared private job store');
  const {createAuthorityAdmin}=await import('../checkout/shopify.mjs');
  const admin=createAuthorityAdmin(graphql,{writesEnabled,lifecycle,now});
  const context=await admin.read();
  const first = await readDrafts(graphql);
  const second = await readDrafts(graphql);
  if (digest(first) !== digest(second)) throw new ConfigurationError('DRAFT_CHANGED', 'Edits occurred during validation; retry after editing finishes');
  const release = makeRelease(second.config);
  const archiveKey = `release_${release.sha256.slice(0,24)}`;
  const prior = await graphql(`query Archive($key: String!) { shop { myshopifyDomain } currentAppInstallation { id app { id } metafield(namespace: "${NAMESPACE}", key: $key) { type value compareDigest } } }`, { key: archiveKey });
  const installation=assertIdentity(prior);
  if(installation.id!==context.installationId)throw new ConfigurationError('WRONG_TARGET','Installation changed');
  const archive = installation.metafield;
  if (archive && canonical(verifyRelease(JSON.parse(archive.value))) !== canonical(release)) throw new ConfigurationError('ARCHIVE_CONFLICT', archiveKey);
  if(archive && (archive.type!=='json' || !archive.compareDigest))throw new ConfigurationError('ARCHIVE_CONFLICT',archiveKey);
  const result=await admin.cutover({context,release,archive:{key:archiveKey,field:archive??{type:'json',value:canonical(release),compareDigest:null}}});
  return { release, records: second.records, ...result };
}

// Inject an authenticated server-side Admin GraphQL transport. Never use in a browser.
// No stale fallback after expiry. A version mismatch forces one read, then rejects.
export function createConfigLoader(graphql, { ttlMs = 30000, now = Date.now, sourceScope } = {}) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 0 || ttlMs > 30000) throw new ConfigurationError('INVALID_TTL', 'Use 0–30000ms');
  let cache = null, expiresAt = 0, pending = null;
  async function refresh() {
    if (!pending) pending = (async () => {
      const installation = assertIdentity(await graphql(ACTIVE_QUERY));
      if (!installation.metafield) throw new ConfigurationError('MISSING_CONFIGURATION', 'No published release');
      const release = freeze(verifyRelease(JSON.parse(installation.metafield.value),{sourceScope}));
      cache = release; expiresAt = now() + ttlMs;
      return release;
    })().finally(() => { pending = null; });
    return pending;
  }
  return {
    async load({ expectedVersion, fresh = false } = {}) {
      const release = fresh || !cache || now() >= expiresAt || (expectedVersion && cache.version !== expectedVersion) ? await refresh() : cache;
      if (expectedVersion !== undefined && expectedVersion !== release.version) throw new ConfigurationError('VERSION_MISMATCH', 'Revalidate the job against the active configuration');
      return release;
    },
    invalidate() { cache = null; expiresAt = 0; },
  };
}
