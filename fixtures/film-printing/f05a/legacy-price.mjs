// Offline adapter around the ACTUAL captured merchant functions. No copied pricing
// formula. This tiny DOM double covers selected fixed-size groups only; it is not
// an upload/browser/authentication simulation or proof of Shopify rendering.
import vm from 'node:vm';
export function legacyHarness(script,source,selection,{files=1,copies=1}={}) {
  const part=(start,end)=>{const a=script.indexOf(start),b=script.indexOf(end,a);if(a<0||b<a)throw Error('Source markers changed');return script.slice(a,b);};
  const radios=[];
  const radio=(name,value,option={},checked=false)=>{
    const unavailable=new Set(),label={classList:{add:x=>unavailable.add(x),remove:x=>unavailable.delete(x)},querySelector:()=>null};
    const r={name,value,checked,disabled:false,unavailable,tagName:'INPUT',closest:()=>label,dataset:{price:option.price??0,basePrice:option.price??0,
      showIf:JSON.stringify(option.show_if??null),priceOverrides:JSON.stringify(option.price_overrides??null),defaultIf:JSON.stringify(option.default_if??null),
      ...(option.default?{defaultStatic:'true',defaultOption:'true'}:{})}};
    radios.push(r);return r;
  };
  radio('service',selection.service,{},true);radio('location',selection.lab,{},true);
  radio('properties[Turnaround]',selection.options.Turnaround,{},true);
  for(const group of ['Sizes','Paper','Borders'])for(const o of source[selection.service][group]?.options??[]) {
    radio(group.toLowerCase(),o.label,o,o.label===(group==='Sizes'?selection.size:group==='Paper'?selection.paper:selection.options.Borders));
  }
  const form={querySelectorAll:s=>s==='[data-show-if]'?[]:s==='input[type="radio"]:checked'?radios.filter(r=>r.checked):radios,
    querySelector:()=>radios.find(r=>r.name==='properties[Turnaround]'&&r.checked)};
  const scope={form,total:0,basePrice:0,syncCustomSizePrice:()=>{},getQuantity:()=>copies,getUploadedFilesCount:()=>files,
    totalDisplay:{},bottomTotalDisplay:{},formatMoney:x=>x,setErrorMessage:()=>{},renderSummary:()=>{},updateOrderSummaryVisibility:()=>{},
    clearErrorsOnHidden:()=>{},applyDefaultsInContainer:()=>{}};
  vm.createContext(scope);
  vm.runInContext(part('  const normKey =','  // --- Handle service change')+part('  function calculateTotal()','  // --- Conditions')+part('  function applyConditions()','  // React to any radio change'),scope);
  const recalculate=()=>{vm.runInContext('applyConditions()',scope);return {perImage:scope.total,unitCents:Math.round(scope.total*files*100),total:scope.totalDisplay.textContent};};
  return {radios,recalculate,price:recalculate()};
}
