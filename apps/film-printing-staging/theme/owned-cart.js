import {createResourceSession} from './resource-session.js';
// Explicit nonvisual consumer: nothing runs on load, no stored cart capability,
// session bearer, global owner, recovery, timer, form or checkout activation.
export function createOwnedCart(options){
 const session=createResourceSession(options);
 const locate=async()=>{
  // Reuse the existing exact native locator; no Ajax-token reconstruction.
  const result=await globalThis.BFLPrintCartLocator?.locate();
  if(typeof result?.cart_id!=='string')throw Error('CART_LOCATOR_UNAVAILABLE');return result.cart_id;
 };
 return Object.freeze({issue:session.issue,renew:session.renew,revoke:session.revoke,
  async bind(){return session.ownedCart('bind',await locate());},
  async status(){return session.ownedCart('status',await locate());},
 });
}
