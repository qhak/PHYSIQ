import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const source = readFileSync(new URL('../worker/payments-api.mjs', import.meta.url), 'utf8');
const start = source.indexOf('function resolveTierFromStripeObject(');
const end = source.indexOf('function periodEndFromInvoice(', start);
const context = vm.createContext({});
vm.runInContext(source.slice(start, end), context);
const env = { STRIPE_PRICE_SCAN:'legacy-scan', STRIPE_PRICE_PRO:'legacy-pro', STRIPE_PRICE_LIFETIME:'legacy-lifetime' };
const cases = [
  ['price_1UMBJMP3OFdhFtZ4LmdZcAFU','scan'],
  ['price_1UMBRrP3OFdhFtZ4M66hMZ8L','pro'],
  ['price_1UMBUKP3OFdhFtZ4oWuGXk6M','pro'],
  ['legacy-scan','scan'],['legacy-pro','pro'],['legacy-lifetime','lifetime'],
  ['price_1TeJyPP3OFdhFtZ40e1UB74j','lifetime'],
  ['price_1TeJxkP3OFdhFtZ4pO5qOj4z','pro'],
  ['price_1TeJwLP3OFdhFtZ4XUORlDYt','scan'],
  ['price_1TeJnGP3OFdhFtZ4VQY4eYmQ','pro'],
  ['price_1TeJkvP3OFdhFtZ471TOe6Iq','scan'],
  ['price_1TeJhbP3OFdhFtZ4iPThguiP','scan'],
  ['price_1TdDEvP3OFdhFtZ401ZNnIfg','scan']
];
for (const [id,tier] of cases) {
  for (const object of [
    {object:'checkout.session',line_items:{data:[{price:{id}}]}},
    {object:'invoice',lines:{data:[{price:{id}}]}}
  ]) {
    const result=context.resolveTierFromStripeObject(object,env);
    assert.equal(result.ok,true); assert.equal(result.tier,tier);
  }
}
assert.equal(context.resolveTierFromStripeObject({price:{id:'unknown'}},env).ok,false);
assert.equal(context.resolveTierFromStripeObject({price:{id:cases[2][0]},metadata:{tier:'scan'}},env).ok,false);
assert.equal(context.resolveTierFromStripeObject({price:{id:'unknown'},metadata:{tier:'pro'}},env).ok,false);
console.log('PASS: new and legacy checkout/renewal mappings; unknown prices and conflicting metadata rejected.');
const records = new Map();
let invoice,subscription;
const lifecycle = vm.createContext({
  console, URL, Request, Response, TextEncoder, TextDecoder, crypto,
  fetch: async (url, options) => {
    assert.equal(options.headers['Stripe-Version'], '2024-06-20');
    if(String(url).includes('/v1/invoices/')) return Response.json(invoice);
    if(String(url).includes('/v1/subscriptions/')) return Response.json(subscription);
    if(String(url).includes('/v1/charges/')) return Response.json({id:'ch_test',customer:'cus_test',invoice:'in_test',refunded:true,amount:5999,amount_refunded:5999});
    throw new Error('Unexpected network request in isolated lifecycle test');
  }
});
vm.runInContext(source.replace('export default {','const testWorker = {'),lifecycle);
const testEnv={...env,STRIPE_SECRET_KEY:'isolated-test-only',ENTITLEMENTS:{
  get:async key=>records.get(key)||null, put:async(key,value)=>records.set(key,value)
}};
const email='annual-test@example.invalid';
records.set('customer:cus_test',email);
const periodEnd=Math.floor(Date.now()/1000)+365*86400;
subscription={id:'sub_test',customer:'cus_test',status:'active',current_period_end:periodEnd,cancel_at_period_end:false};
invoice={object:'invoice',id:'in_test',customer:'cus_test',subscription:'sub_test',lines:{data:[{price:{id:cases[2][0]},period:{end:periodEnd}}]}};
await lifecycle.onInvoicePaid(testEnv,{id:'in_test'});
let ent=JSON.parse(records.get('ent:'+email));
assert.equal(ent.tier,'pro'); assert.equal(ent.current_period_end,periodEnd);
await lifecycle.onSubscriptionUpdated(testEnv,{...subscription,cancel_at_period_end:true});
ent=JSON.parse(records.get('ent:'+email));
assert.equal(ent.status,'active'); assert.equal(ent.cancel_at_period_end,true);
await lifecycle.onSubscriptionDeleted(testEnv,subscription);
ent=JSON.parse(records.get('ent:'+email));
assert.notEqual(ent.status,'active');
console.log('PASS: annual invoice grants Pro through paid period; cancellation at period end retains access; subscription deletion revokes access.');
await lifecycle.onInvoicePaid(testEnv,{id:'in_test'});
const nextPeriodEnd=periodEnd+365*86400;
const basilSubscription={id:'sub_test',customer:'cus_test',status:'active',cancel_at_period_end:true,
  items:{data:[{price:{id:cases[2][0]},current_period_end:nextPeriodEnd},
    {price:{id:'unrelated'},current_period_end:nextPeriodEnd+1000}]}};
await lifecycle.onSubscriptionUpdated(testEnv,basilSubscription);
ent=JSON.parse(records.get('ent:'+email));
assert.equal(ent.current_period_end,nextPeriodEnd);
assert.equal(ent.cancel_at_period_end,true);
assert.equal(lifecycle.subscriptionPeriodEnd({items:{data:[{price:{id:'unknown'},current_period_end:nextPeriodEnd}]}},testEnv),null);
console.log('PASS: pinned Stripe retrieval version; Basil subscription periods use only configured Pro items.');
await lifecycle.onChargeRefunded(testEnv,{id:'ch_test',customer:'cus_test',refunded:true,amount:5999,amount_refunded:5999});
ent=JSON.parse(records.get('ent:'+email));
assert.notEqual(ent.status,'active');
assert.equal(ent.revoke_reason,'charge_refunded');
const rejectedWebhook=await lifecycle.handleWebhook(new Request('https://test.invalid/stripe/webhook',{method:'POST',body:'{}'}),testEnv);
assert.equal(rejectedWebhook.status,400);
console.log('PASS: Basil refund retrieves pinned charge/invoice and revokes matching Pro access; unsigned webhooks rejected.');
