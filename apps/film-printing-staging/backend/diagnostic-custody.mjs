import {need} from './config.mjs';
import {uuid} from '../uploads/ledger.mjs';
// Bounded engineering uploads. This is private external-result custody,
// not membership or authority: normal upload_intents/jobs remain in the same DB.
// The old upload_custody purpose/one-send reservation is never opened or reset.
// append must synchronously fsync the private operator journal BEFORE each send.
export function createDiagnosticCustody({store,append,history=[],maxUploads=3}){
 const rows=new Map(),owners=new Set();
 for(const e of history.filter(e=>e.event==='fixture_custody'))rows.set(e.row.intent,e.row);
 const write=row=>{append({event:'fixture_custody',row});rows.set(row.intent,Object.freeze({...row}));};
 const read=id=>{const row=rows.get(id);need(row,'DIAGNOSTIC_CUSTODY_SCOPE');return row;};
 const fail=id=>store.uploadLedger.invalidate(store.uploadLedger.read(id),'failed');
 const service={
  admitOwner(ticket){store.checkoutOwner.member(ticket);owners.add(ticket.owner);},
  start(id,binding){
   const intent=store.uploadLedger.read(id);
   need(owners.has(intent.owner)&&!rows.has(id)&&rows.size<maxUploads&&intent.state==='sending'&&intent.binding===binding,'DIAGNOSTIC_CUSTODY_LIMIT');
   write({intent:id,owner:intent.owner,binding,asset:null,state:'sending'});
  },
  known(id,binding,asset){const row=read(id);need(row.state==='sending'&&row.binding===binding&&uuid(asset),'DIAGNOSTIC_CUSTODY_SCOPE');write({...row,asset,state:'known'});},
  failed(id){fail(id);const row=rows.get(id);if(row)write({...row,state:row.asset?'queued':'upload-unknown'});},
  queue(){for(const row of rows.values())if(row.state==='known'){
   const i=store.uploadLedger.read(row.intent);if(['failed','removed'].includes(i.state)||store.lifecycle.retired('owner',row.owner))write({...row,state:'queued'});
  }},
  recover(){for(const row of rows.values())if(['sending','deleting'].includes(row.state)){write({...row,state:row.state==='sending'?'upload-unknown':'delete-unknown'});fail(row.intent);}service.queue();},
  pending(){service.queue();return [...rows.values()].filter(r=>r.state==='queued');},
  beginDelete(id){const row=read(id);need(row.state==='queued'&&row.asset,'DIAGNOSTIC_CUSTODY_SCOPE');write({...row,state:'deleting'});return row;},
  finishDelete(id,confirmed){const row=read(id);need(row.state==='deleting','DIAGNOSTIC_CUSTODY_SCOPE');write({...row,state:confirmed?'deleted':'delete-unknown'});},
  counts(){const counts={};for(const row of rows.values())counts[row.state]=(counts[row.state]??0)+1;return counts;},
 };
 return Object.freeze(service);
}
