// Offline candidate preparation only. Actual observed location IDs/origins must
// come from authenticated operator custody. Output is not an admitted scope.
import {prepareCatalog,validateStagingLabReadback} from './prepare.mjs';
import {canonical,digest,freeze,verifyRelease} from '../configuration/config.mjs';
import {requireValue as need} from '../shipping/packing.mjs';

const PACKING_SOURCE='0117e94dca2c7a735ededae104b7dd939bd134591c63e998255396964d4d42a0';
export function prepareFixedEngineering({pricingInput,packingRelease}) {
  const prepared=prepareCatalog(pricingInput),mapping=pricingInput.mapping;
  need(mapping.status==='reviewed_staging_test_lab_mapping' && prepared.catalog.rows.length===888,'FIXED_ENGINEERING_MAPPING');
  const locations=validateStagingLabReadback(mapping).locations;
  verifyRelease(packingRelease);
  need(packingRelease.sha256===PACKING_SOURCE,'PACKING_SOURCE_CHANGED');
  const source=packingRelease.config,selectors=new Map();
  for(const row of prepared.catalog.rows)selectors.set(canonical([row.service,row.size,row.paper]),row);
  need(selectors.size===28,'FIXED_ENGINEERING_SELECTORS');
  const provenance=(original,detail)=>({source:'Fixed-size staging TEST-only preparation from F03 '+packingRelease.version,
    evidence:detail+'; original evidence: '+original.provenance.evidence,
    sha256:PACKING_SOURCE});
  const usedPackages=new Set();
  const rules=[...selectors.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([,row])=>{
    const matches=source.rules.filter(r=>r.service===row.service && r.size_key===row.size && r.lab==='all_labs');
    need(matches.length===1,'PACKING_RULE_UNAVAILABLE');
    const observed=matches[0];
    need(observed.package_id && Number.isSafeInteger(observed.capacity) && observed.capacity>0 && observed.print_weight_oz>0,'PACKING_RULE_UNAVAILABLE');
    usedPackages.add(observed.package_id);
    const {disabled_reason,...base}=observed;
    return {...base,id:`test-${row.service}-${row.size.replaceAll('.','_')}-${row.paper}`,
      label:`TEST ONLY ${row.service} ${row.size} ${row.paper}`,enabled:true,paper:row.paper,
      provenance:provenance(observed,'Existing size-level physical observations assigned to exact paper selector for engineering tests only; not merchant paper-specific packing approval')};
  });
  const packages=source.packages.filter(p=>usedPackages.has(p.id)).map(observed=>{
    const {disabled_reason,...base}=observed;
    return {...base,label:'TEST ONLY '+observed.label,enabled:true,
      provenance:provenance(observed,'Existing package observations retained without promotion of evidence status')};
  });
  need(packages.length===usedPackages.size,'PACKING_PACKAGE_UNAVAILABLE');
  const labs=mapping.labs.map(l=>{
    const readback=locations.find(row=>row.lab===l.lab && row.location_id===l.location_id);
    return {id:l.lab,label:'TEST ONLY '+l.input,enabled:true,
      provenance:{source:'Authenticated staging Location readback '+mapping.location_readback.captured_at,
        evidence:readback.evidence+'; staging TEST address and routing identity only; not verified merchant carrier origin',sha256:digest(mapping.location_readback)},
      location_id:'gid://shopify/Location/'+l.location_id,origin:structuredClone(readback.origin),origin_status:'staging_address_only'};
  });
  const config={schema_version:source.schema_version,store:source.store,packages,rules,labs,policies:structuredClone(source.policies)};
  need(config.policies.every(p=>p.enabled===false),'ENGINEERING_POLICY');
  const catalog=prepared.catalog;
  // These hashes are review output, not authority. Admission requires adding the
  // final exact pair to configuration/engineering.mjs's source registry.
  return freeze({config,catalog,formValue:prepared.formValue,selections:prepared.selections,
    review:{admitted:false,config_sha256:digest(config),catalog_sha256:digest(catalog),mapping_sha256:digest(mapping),packing_source_sha256:PACKING_SOURCE,
      rows:catalog.rows.length,selectors:rules.length,checkout_ready:false,shipping_enabled:false}});
}
