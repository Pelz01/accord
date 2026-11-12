import { Worker } from 'near-workspaces';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { prepareRuntime } from './runtime.mjs';
import { baseEncode } from '../node_modules/near-api-js/lib/index.js';

await prepareRuntime();
const worker = await Worker.init();
const usdc = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const wasm = await readFile(fileURLToPath(new URL('../.data/wasm/vault.wasm', import.meta.url)));
const tokenWasm = await readFile(fileURLToPath(new URL('../.data/wasm/token.wasm', import.meta.url)));
const gas = {gas: '150000000000000'};
const approval = {...gas, attachedDeposit:'1'};
const proof = {at:new Date().toISOString(),environment:'disposable-near-sandbox',networkDomain:'mainnet',
  tokenFixture:'Synthetic NEP-141 fixture installed only inside the sandbox at the pinned USDC address; not Circle production code.',
  wasmSha256:createHash('sha256').update(wasm).digest('hex'),checks:[],transactions:[],completed:false};
const pass = name => {proof.checks.push({name,status:'PASS'});console.log('PASS '+name);};
async function call(actor,target,method,args,opts=gas,fail=false){
  const tgas={create_automatic_order:50,storage_deposit:30,ft_transfer_call:70,accept_order:25,confirm_delivery:25,confirm_invoice:25,request_payment:80,top_up_order_storage:25,claim_native_excess:40,propose_close:25,accept_close:80};
  const r=await actor.callRaw(target,method,args,{...opts,gas:String((tgas[method]??150)*1e12)});
  proof.transactions.push({method,hash:r.transactionReceipt.hash,succeeded:r.succeeded,gas:String((tgas[method]??150)*1e12),gasBurnt:r.totalGasBurned?.toString()});
  if(fail)assert(r.failed||r.receiptFailures.length>0,method+' must fail');
  else {assert(r.succeeded,method+': '+JSON.stringify(r.status));assert.equal(r.receiptFailures.length,0,method);}
  return r;
}
try {
  const root=worker.rootAccount,buyer=await root.createSubAccount('buyer'),supplier=await root.createSubAccount('supplier'),operator=await root.createSubAccount('operator');
  // Sandbox state patching is required to place a synthetic token at the immutable
  // mainnet token address. No production endpoint or key is used by this script.
  await worker.provider.patchStateRecords({records:[
    {Account:{account_id:usdc,account:{amount:'100000000000000000000000000',locked:'0',code_hash:baseEncode(createHash('sha256').update(tokenWasm).digest()),storage_usage:tokenWasm.length+256,version:'V1'}}},
    {Contract:{account_id:usdc,code:tokenWasm.toString('base64')}},
  ]});
  await call(root,usdc,'new',{owner_id:buyer.accountId,total_supply:'1000000'});
  const vault=await root.devDeploy(wasm);
  await call(vault,vault,'new',{token:usdc,network:'mainnet'});
  assert.equal((await vault.view('get_config',{})).initial_storage_allowance,'100000000000000000000000');
  for(const account_id of [vault.accountId,supplier.accountId])
    await call(buyer,usdc,'storage_deposit',{account_id,registration_only:true},{...gas,attachedDeposit:'1250000000000000000000'});
  const terms={supplier:supplier.accountId,receiver:buyer.accountId,operator:operator.accountId,payout:supplier.accountId,line_id:'cartons',description:'Controlled purchasing check',unit:'carton',ordered:'2',unit_price:'10000',expires_at:'18446744073709551615'};
  await call(buyer,vault,'create_automatic_order',{order_id:'MAINNET-DOMAIN',terms},{...gas,attachedDeposit:'100000000000000000000000'});
  let order=await vault.view('get_order',{order_id:'MAINNET-DOMAIN'});
  const credit=()=>vault.view('get_native_deposit',{order_id:order.id});
  assert.equal((await credit()).incremental,true);
  await call(supplier,vault,'accept_order',{order_id:order.id,terms_hash:order.terms_hash},approval);
  await call(buyer,usdc,'ft_transfer_call',{receiver_id:vault.accountId,amount:'20000',msg:order.id},approval);
  await call(buyer,vault,'confirm_delivery',{order_id:order.id,sequence:'1',cumulative_quantity:'1',receipt_hash:'a'.repeat(64)},approval);
  const invoice={order_id:order.id,terms_version:1,terms_hash:order.terms_hash,document_hash:'b'.repeat(64),reference:'ACC-MAINNET-01',line_id:'cartons',quantity:'1',token:usdc,amount:'10000'};
  await call(supplier,vault,'confirm_invoice',{order_id:order.id,invoice},approval);
  const request={order_id:order.id,request_id:'mainnet-domain-payment',quantity:'1',audit_hash:invoice.document_hash,invoice};
  await call(operator,vault,'request_payment',request);
  const balance=async id=>JSON.parse(Buffer.from((await worker.provider.viewCall(usdc,'ft_balance_of',{account_id:id})).result).toString());
  assert.equal(await balance(supplier.accountId),'10000');
  assert.equal(await balance(vault.accountId),'10000');
  order=await vault.view('get_order',{order_id:order.id});
  assert.equal(order.paid,'1');assert.equal(order.pending,'0');
  await call(operator,vault,'request_payment',request,gas,true);
  pass('Pinned mainnet domain settles a 0.01 six-decimal payment at fixed price and recipient; replay cannot pay twice.');
  await call(buyer,vault,'top_up_order_storage',{order_id:order.id},{...gas,attachedDeposit:'25000000000000000000000'});
  assert.equal((await credit()).claimable,'25000000000000000000000');
  await call(buyer,vault,'claim_native_excess',{order_id:order.id},approval);
  assert.equal((await credit()).deposit.pending,'0');
  pass('A mainnet-domain 0.1 NEAR starting reserve accepts an owner top-up and returns only genuine open-order excess.');
  await call(buyer,vault,'propose_close',{order_id:order.id},approval);
  const proposal=(await vault.view('get_recovery',{order_id:order.id})).proposal;
  await call(supplier,vault,'accept_close',{order_id:order.id,proposal_hash:proposal.hash},approval);
  assert.equal((await vault.view('get_recovery',{order_id:order.id})).phase,'Closed');
  assert.equal(await balance(vault.accountId),'0');
  assert.equal(await balance(buyer.accountId),'990000');
  const before=await credit();
  await call(buyer,vault,'claim_native_excess',{order_id:order.id},approval);
  const final=await credit();
  assert.equal(final.claimable,'0');assert.equal(final.deposit.pending,'0');
  assert.equal(final.deposit.claim_status,'Settled');
  assert.equal(BigInt(final.deposit.refunded)+BigInt(final.retained_required)+BigInt(final.deposit.call_deposits_spent),BigInt(final.deposit.deposited));
  proof.final={order:await vault.view('get_order',{order_id:order.id}),credit:final,claimAfterClosure:before.claimable};
  pass('Mutual closure returns the unused 0.01 token amount separately from native allowance; retained records stay backed.');
  await call(buyer,vault,'create_automatic_order',{order_id:'GROWTH',terms},{...gas,attachedDeposit:'100000000000000000000000'});
  const growth=await vault.view('get_order',{order_id:'GROWTH'});
  await call(supplier,vault,'accept_order',{order_id:growth.id,terms_hash:growth.terms_hash},approval);
  await call(buyer,usdc,'ft_transfer_call',{receiver_id:vault.accountId,amount:'20000',msg:growth.id},approval);
  let blocked=false;
  for(let n=0;n<32;n++){
    const i={...invoice,order_id:growth.id,terms_hash:growth.terms_hash,reference:`STORAGE-${n}`};
    const r=await supplier.callRaw(vault,'confirm_invoice',{order_id:growth.id,invoice:i},approval);
    if(r.failed||r.receiptFailures.length){
      assert(JSON.stringify(r.status).includes('Top up this order'));
      blocked=true;
      await call(buyer,vault,'top_up_order_storage',{order_id:growth.id},{...gas,attachedDeposit:'100000000000000000000000'});
      await call(supplier,vault,'confirm_invoice',{order_id:growth.id,invoice:i},approval);
      break;
    }
  }
  assert(blocked,'Incremental budget must stop growth before exhausting platform credit');
  assert.deepEqual(await credit(),final);
  pass('Record growth reverts when its own small budget is exhausted; an explicit owner top-up permits it without touching another order.');
  proof.completed=true;
} finally {
  await writeFile(fileURLToPath(new URL('../.data/mainnet-sandbox-evidence.json',import.meta.url)),JSON.stringify(proof,null,2)+'\n');
  await worker.tearDown();
}
