// F02 finite staging probe. No visible controls. Remove after checkout proof.
(() => {
 if(location.hostname !== 'bellows-film-printing-staging.myshopify.com' || location.pathname !== '/products/f00-film-printing-test') return;
 const params=new URLSearchParams(location.search);
 const specs={"photo-4x6-three":{"_bfl_spec":"photo-4x6-three","_bfl_job_id":"f02-A","_bfl_spec_version":"f02-synthetic-v1","Service":"Photo Prints","Sizes":"4\" x 6\"","Location":"Miami","Files Uploaded":"3","Uploaded File 1":"https://example.invalid/f02/a.jpg","Uploaded File 2":"https://example.invalid/f02/b.jpg","Uploaded File 3":"https://example.invalid/f02/c.jpg","_custom_price_cents":"750","_fallback_price_cents":"750","Total Price":"$2.50"},"photo-8x10-three":{"_bfl_spec":"photo-8x10-three","_bfl_job_id":"f02-A","_bfl_spec_version":"f02-synthetic-v1","Service":"Photo Prints","Sizes":"8\" x 10\"","Location":"Miami","Files Uploaded":"3","Uploaded File 1":"https://example.invalid/f02/a.jpg","Uploaded File 2":"https://example.invalid/f02/b.jpg","Uploaded File 3":"https://example.invalid/f02/c.jpg","_custom_price_cents":"750","_fallback_price_cents":"750","Total Price":"$2.50"},"photo-4x6-one":{"_bfl_spec":"photo-4x6-one","_bfl_job_id":"f02-A","_bfl_spec_version":"f02-synthetic-v1","Service":"Photo Prints","Sizes":"4\" x 6\"","Location":"Miami","Files Uploaded":"1","Uploaded File 1":"https://example.invalid/f02/a.jpg","_custom_price_cents":"250","_fallback_price_cents":"250","Total Price":"$2.50"}};
 const spec=specs[params.get('f02_spec')];
 if(!spec) return;
 const job=params.get('f02_job') || 'f02-A';
 if(!/^f02-[a-zA-Z0-9-]{1,60}$/.test(job)) return;
 const form=document.querySelector('product-form form[action*="/cart/add"]');
 if(!form || form.querySelector('[name="id"]')?.value !== '67852705202287') return;
 const props={...spec,_bfl_job_id:job};
 if(params.get('f02_tamper')==='price') props._custom_price_cents='1';
 if(params.get('f02_tamper')==='files') props['Files Uploaded']='1';
 for(const [key,value] of Object.entries(props)) {
  const input=document.createElement('input'); input.type='hidden'; input.name='properties['+key+']'; input.value=value; form.append(input);
 }
 if(params.get('f02_action')==='edit') form.addEventListener('submit',async event=>{
  event.preventDefault(); event.stopImmediatePropagation();
  const cart=await fetch('/cart.js').then(r=>r.json());
  const line=cart.items.find(i=>String(i.variant_id)==='67852705202287' && i.properties?._bfl_job_id===job);
  if(!line) { console.error('[F02 probe] Job to edit was not found'); return; }
  const quantity=Number(new FormData(form).get('quantity'));
  const response=await fetch('/cart/change.js',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:line.key,quantity,properties:props})});
  const result=await response.json();
  console.info('[F02 edit]',JSON.stringify({status:response.status,item_count:result.item_count,total_price:result.total_price,items:result.items?.map(i=>({key:i.key,variant_id:i.variant_id,quantity:i.quantity,price:i.price,final_price:i.final_price,final_line_price:i.final_line_price,requires_shipping:i.requires_shipping,properties:i.properties}))}));
  if(response.ok) location.assign('/cart');
 },true);
 console.info('[F02 probe] Synthetic properties ready for existing Add to bag button', {spec:params.get('f02_spec'),job});
})();
