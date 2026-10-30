import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {configuration} from '../../../fixtures/film-printing/f06p-composition/rig.mjs';
import {migrateCheckoutComposition,migratePreparedCart,openDatabase} from '../backend/storage.mjs';
import {preparePersistentStagingSources,createPersistentStagingScope} from '../configuration/engineering.mjs';
import {installStagingCartSchema,createStagingCartLedgers} from '../checkout/staging-cart.mjs';
import {STOREFRONT_ORIGIN} from '../backend/storefront-session.mjs';
import {STORE,APP,CLIENT} from '../configuration/schema.mjs';
import {SHOP,INSTALLATION} from '../backend/config.mjs';
const identity={shop:{id:SHOP,myshopifyDomain:STORE},currentAppInstallation:{id:INSTALLATION,app:{id:APP,apiKey:CLIENT}}};
function setup(t){
 const config=configuration(t);migrateCheckoutComposition(config);migratePreparedCart(config);const clock={time:1793332800000};
 const read=name=>JSON.parse(readFileSync(new URL('../../../fixtures/film-printing/full-product-lab-routing-20261030/'+name,import.meta.url)));
 const sourceScope=createPersistentStagingScope({...preparePersistentStagingSources({config:read('engineering-config-proposal.json'),catalog:read('engineering-catalog-proposal.json'),issuedAt:clock.time}),identity,now:()=>clock.time});
 let db;const h=openDatabase(config,{resourceSessions:true,checkoutOwner:true,preparedCart:true,persistentSourceScope:sourceScope,now:()=>clock.time,configureStore(store,d){db=d;installStagingCartSchema(db);Object.assign(store,createStagingCartLedgers({db,store,sourceScope,now:()=>clock.time}));}});config.localClosers.push(h.close);
 const {store}=h,s=store.resourceSessions,proof=()=>({id:randomBytes(32).toString('base64url'),observedAt:clock.time,customerId:null}),request=token=>({headers:{origin:STOREFRONT_ORIGIN,authorization:'Bearer '+token}});
 const issue=()=>{const receipt=s.issue(proof(),{ttlMs:86400000,sourceScope});return {receipt,ticket:s.authenticate(request(receipt.token))};};
 const bind=(who,id)=>{const a=store.checkoutCapability.reserve({ticket:who.ticket,cart_id:id,proofId:randomBytes(32).toString('base64url'),created:clock.time,sealed:'test-sealed-private-custody'});store.checkoutOwner.reserve(who.ticket,a);store.checkoutCapability.sending(a,'snapshot');store.checkoutOwner.complete(who.ticket,a);store.checkoutCapability.finish(a,'capability_only');const cart={id,owner:who.ticket.owner,binding_id:a,customer_id:null,complete:true,lines:[]};const marker=store.cartBinding.reserve(cart),epoch=store.cartBinding.sending(cart,marker);store.cartBinding.confirm(cart,marker,epoch);return {cart,marker};};
 return {config,clock,sourceScope,store,db,issue,bind,proof,request};
}
const id=n=>'gid://shopify/Cart/staging-client-'+n+'?key=synthetic-full-private-key-'+n;
test('two independent new carts bind without clearing or changing another cart epoch',t=>{
 const f=setup(t),a=f.issue(),b=f.issue(),epoch=f.store.lifecycle.state().epoch,first=f.bind(a,id('a')),second=f.bind(b,id('b'));
 assert.equal(f.store.lifecycle.state().epoch,epoch);assert.equal(f.store.lifecycle.state().pending,0);assert.deepEqual(f.store.cartBinding.observe(first.cart,first.marker),{marker:first.marker});assert.deepEqual(f.store.cartBinding.observe(second.cart,second.marker),{marker:second.marker});
 assert.throws(()=>f.store.cartBinding.observe({...first.cart,owner:b.ticket.owner},first.marker),/BINDING_OWNER_UNPROVEN/);
 assert.throws(()=>f.bind(f.issue(),id('a')),/CART_CAPABILITY_REPLAY/);
});
test('restart retains exact owner and binding with no new capability mutation',t=>{
 const f=setup(t),a=f.issue(),bound=f.bind(a,id('restart'));f.config.localClosers[0]();
 const h=openDatabase(f.config,{resourceSessions:true,checkoutOwner:true,preparedCart:true,persistentSourceScope:f.sourceScope,now:()=>f.clock.time,configureStore(store,db){Object.assign(store,createStagingCartLedgers({db,store,sourceScope:f.sourceScope,now:()=>f.clock.time}));}});f.config.localClosers.push(h.close);
 const ticket=h.store.resourceSessions.authenticate(f.request(a.receipt.token));assert.equal(h.store.checkoutOwner.bound(ticket).binding_id,bound.cart.binding_id);h.store.cartBinding.observe(bound.cart,bound.marker);
});
test('expired owner needs an explicit one-shot empty-cart replacement; original session stays immutable',t=>{
 const f=setup(t),a=f.issue(),bound=f.bind(a,id('replace')),s=f.store.resourceSessions,original={...s.assert(a.ticket)};
 assert.throws(()=>s.authenticateTerminal(f.request(a.receipt.token)),/RESOURCE_REJECTED/);f.clock.time+=86400000;
 const terminal=s.authenticateTerminal(f.request(a.receipt.token));assert.throws(()=>s.authenticate(f.request(a.receipt.token)),/RESOURCE_REJECTED/);
 assert.equal(f.store.replacements.reserve(terminal,bound.cart),bound.marker);assert.throws(()=>f.store.replacements.reserve(terminal,bound.cart),/STAGING_REPLACEMENT_SPENT/);
 assert.throws(()=>f.store.replacements.issue(terminal,f.proof()),/STAGING_REPLACEMENT_SPENT/);f.store.replacements.removed(terminal);
 const replacement=f.store.replacements.issue(terminal,f.proof()),next={receipt:replacement,ticket:s.authenticate(f.request(replacement.token))};assert.notEqual(next.ticket.owner,a.ticket.owner);assert.equal(replacement.expires_at,f.clock.time+86400000);
 assert.deepEqual({...f.db.prepare('SELECT * FROM resource_sessions WHERE owner=?').get(a.ticket.owner)},original);
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM staging_binding_history').get().n,1);
 assert.throws(()=>f.store.replacements.issue(terminal,f.proof()),/STAGING_REPLACEMENT_SPENT/);f.bind(next,id('replace'));
});
test('lost capability response cannot be replayed or adopted by another owner',t=>{
 const f=setup(t),a=f.issue(),c=f.store.checkoutCapability.reserve({ticket:a.ticket,cart_id:id('unknown'),proofId:randomBytes(32).toString('base64url'),created:f.clock.time,sealed:'sealed'});
 f.store.checkoutOwner.reserve(a.ticket,c);f.store.checkoutCapability.sending(c,'snapshot');f.store.checkoutCapability.finish(c,'unknown');assert.throws(()=>f.bind(f.issue(),id('unknown')),/CART_CAPABILITY_REPLAY/);
 f.clock.time+=86400000;const terminal=f.store.resourceSessions.authenticateTerminal(f.request(a.receipt.token));assert.throws(()=>f.store.replacements.original(terminal),/CART_OWNER_UNAVAILABLE/);
});
