// V0.5 E0 PIVOT — Dev tool: pre-validate candidate codes for llm-systems items.
//
// For each item, runs reference_code through exec-cell.runCell to capture the
// GROUND-TRUTH stdout hash. Then runs each candidate.code, computes
//   predicted_pass = (exit_code===0) AND (sha256(stdout) === reference_hash)
// and compares against author-declared expected_pass.
//
// Output: per-line OK/BAD lines + final SUMMARY. Exits 0 only if all 60 (20*3)
// candidates' expected_pass agree with the auto-judge's predicted_pass under
// the reference hash. This is the gate for refactor-then-seed.
//
// Run: node app/scripts/_dev_validate_candidates.js

'use strict';

const { runCell } = require('../lib/evaluator/verification-channels/exec-cell');

// Triples mirror the candidate set that will be authored into
// seed-llm-systems-golden.js. Codes are intentionally crafted so that c1 uses
// distinct identifiers / style from the reference, c2 is wrong by formula, and
// c3 uses the right vocabulary but produces wrong output (cargo-cult).
const ITEMS = [
  { id: 'llm-systems-001',
    ref: 'const B=2,T=8,H=4,D=64; const out=[B,T,H,D]; console.log(JSON.stringify(out));',
    cands: [
      ['c1', true,  'const dims={batch:2,seq:8,heads:4,head_dim:64}; const shape=[dims.batch,dims.seq,dims.heads,dims.head_dim]; console.log(JSON.stringify(shape));'],
      ['c2', false, 'const B=2,T=8,H=4,D=64; const out=[B,H,T,D]; console.log(JSON.stringify(out));'],
      ['c3', false, 'const B=2,T=8,H=4,D=64; const dims={B,T,H,D}; const shape=Object.values(dims).reverse(); console.log(JSON.stringify(shape));'],
    ],
  },
  { id: 'llm-systems-002',
    ref: 'const seq=2048,heads=32,dim=128,bytes=2,layers=32; const total=2*seq*heads*dim*bytes*layers; console.log(total);',
    cands: [
      ['c1', true,  'const cfg={seq_len:2048,n_heads:32,head_dim:128,dtype_bytes:2,n_layers:32}; const kv_factor=2; let total=kv_factor; for (const k of ["seq_len","n_heads","head_dim","dtype_bytes","n_layers"]) total*=cfg[k]; console.log(total);'],
      ['c2', false, 'const seq_len=2048,n_heads=32,head_dim=128,dtype_bytes=2,n_layers=32; const total=seq_len*n_heads*head_dim*dtype_bytes*n_layers; console.log(total);'],
      ['c3', false, 'const seq_len=2048,n_heads=32,head_dim=128,dtype_bytes=2,n_layers=32; const kv_factor=2; const total=seq_len*n_heads*head_dim*dtype_bytes*n_layers*n_layers; console.log(total);'],
    ],
  },
  { id: 'llm-systems-003',
    ref: 'const pos=10,dim_idx=4,D=64,base=10000; const angle=pos/Math.pow(base,(2*dim_idx)/D); console.log(angle.toFixed(6));',
    cands: [
      ['c1', true,  'const position=10,i=4,head_dim=64,theta_base=10000; const theta=position*Math.pow(theta_base,-(2*i/head_dim)); console.log(theta.toFixed(6));'],
      ['c2', false, 'const pos=10,dim_idx=4,D=64,base=10000; const angle=pos/Math.pow(base,dim_idx/D); console.log(angle.toFixed(6));'],
      ['c3', false, 'const pos=10,dim_idx=4,D=64,base=10000; const angle=pos*Math.pow(base,(2*dim_idx)/D); console.log(angle.toFixed(6));'],
    ],
  },
  { id: 'llm-systems-004',
    ref: 'const x=[1,2,3,4]; const mean=x.reduce((a,b)=>a+b,0)/x.length; const v=x.reduce((a,b)=>a+(b-mean)*(b-mean),0)/x.length; const std=Math.sqrt(v); const ln=x.map(xi=>((xi-mean)/std).toFixed(4)); console.log(JSON.stringify(ln));',
    cands: [
      ['c1', true,  'const features=[1,2,3,4]; const N=features.length; const mu=features.reduce((s,v)=>s+v,0)/N; const variance=features.reduce((s,v)=>s+(v-mu)**2,0)/N; const sigma=Math.sqrt(variance); const out=features.map(v=>((v-mu)/sigma).toFixed(4)); console.log(JSON.stringify(out));'],
      ['c2', false, 'const x=[1,2,3,4]; const mean=x.reduce((a,b)=>a+b)/x.length; const v=x.reduce((a,b)=>a+(b-mean)**2,0)/(x.length-1); const std=Math.sqrt(v); console.log(JSON.stringify(x.map(xi=>((xi-mean)/std).toFixed(4))));'],
      ['c3', false, 'const x=[1,2,3,4]; const mean=x.reduce((a,b)=>a+b)/x.length; const mad=x.reduce((a,b)=>a+Math.abs(b-mean),0)/x.length; const sigma=Math.sqrt(mad); console.log(JSON.stringify(x.map(xi=>((xi-mean)/sigma).toFixed(4))));'],
    ],
  },
  { id: 'llm-systems-005',
    ref: 'let s=12345; const rand=()=>{s=(1103515245*s+12345)%2147483648;return s/2147483648;}; const p=0.3; const n=20; let sum=0; for(let i=0;i<n;i++){sum+=(rand()<p?0:1);} console.log(sum);',
    cands: [
      ['c1', true,  'let state=12345; function next(){state=(1103515245*state+12345)&0x7FFFFFFF;return state/2147483648;} let kept=0,i=0; while(i++<20){ if(next()>=0.3) kept++; } console.log(kept);'],
      ['c2', false, 'let s=12345; const r=()=>{s=(1103515245*s+12345)%2147483648;return s/2147483648;}; let sum=0; for(let i=0;i<20;i++){sum+=(r()>=0.3?0:1);} console.log(sum);'],
      ['c3', false, 'let s=12345; const multiplier=1103515245,increment=12345,modulus=4294967296; const r=()=>{s=(multiplier*s+increment)%modulus;return s/modulus;}; let sum=0; for(let i=0;i<20;i++){sum+=(r()<0.3?0:1);} console.log(sum);'],
    ],
  },
  { id: 'llm-systems-006',
    ref: 'const losses=[2.1,1.8,2.3,1.9,2.0]; const mean=losses.reduce((a,b)=>a+b,0)/losses.length; const ppl=Math.exp(mean); console.log(ppl.toFixed(4));',
    cands: [
      ['c1', true,  'const ce_loss=[2.1,1.8,2.3,1.9,2.0]; const avg_loss=ce_loss.reduce((acc,x)=>acc+x,0)/ce_loss.length; const perplexity=Math.E**avg_loss; console.log(perplexity.toFixed(4));'],
      ['c2', false, 'const losses=[2.1,1.8,2.3,1.9,2.0]; const sum=losses.reduce((a,b)=>a+b,0); const ppl=Math.exp(sum); console.log(ppl.toFixed(4));'],
      ['c3', false, 'const losses=[2.1,1.8,2.3,1.9,2.0]; const log_losses=losses.map(l=>Math.log(l)); const mean_log=log_losses.reduce((a,b)=>a+b,0)/log_losses.length; const perplexity=Math.exp(mean_log); console.log(perplexity.toFixed(4));'],
    ],
  },
  { id: 'llm-systems-007',
    ref: "const text='the quick brown fox jumps over the lazy dog'; const tokens=text.split(/\\s+/); const bytes=text.length; const avg=bytes/tokens.length; console.log(avg.toFixed(4));",
    cands: [
      ['c1', true,  "const sentence='the quick brown fox jumps over the lazy dog'; const tok_count=sentence.split(' ').length; const utf8_bytes=Buffer.byteLength(sentence,'utf8'); const bpt=utf8_bytes/tok_count; console.log(bpt.toFixed(4));"],
      ['c2', false, "const text='the quick brown fox jumps over the lazy dog'; const tokens=text.split(/\\s+/); const ratio=tokens.length/text.length; console.log(ratio.toFixed(4));"],
      ['c3', false, "const text='the quick brown fox jumps over the lazy dog'; const tokens=text.split(/\\s+/); const utf8_bytes=tokens.join('').length; const avg=utf8_bytes/tokens.length; console.log(avg.toFixed(4));"],
    ],
  },
  { id: 'llm-systems-008',
    ref: 'const step=2000,warmup=1000,total=10000,peak=3e-4; let lr; if(step<warmup){lr=peak*step/warmup;}else{const prog=(step-warmup)/(total-warmup);lr=peak*0.5*(1+Math.cos(Math.PI*prog));} console.log(lr.toFixed(6));',
    cands: [
      ['c1', true,  'const s=2000,w=1000,T=10000,peak_lr=3e-4; const lr = (s<w) ? peak_lr*(s/w) : peak_lr*0.5*(1+Math.cos(Math.PI*((s-w)/(T-w)))); console.log(lr.toFixed(6));'],
      ['c2', false, 'const step=2000,warmup=1000,total=10000,peak=3e-4; const prog=step/(total-warmup); const lr=peak*0.5*(1+Math.cos(Math.PI*prog)); console.log(lr.toFixed(6));'],
      ['c3', false, 'const step=2000,warmup=1000,total=10000,peak=3e-4; let lr; if(step<warmup){lr=peak*step/warmup;}else{const prog=(step-warmup)/(total-warmup);lr=peak*0.5*(1+Math.sin(Math.PI*prog));} console.log(lr.toFixed(6));'],
    ],
  },
  { id: 'llm-systems-009',
    ref: 'const layers=32,k=4; const full=layers; const ckpt=layers/k+k; const ratio=ckpt/full; console.log(ratio.toFixed(4));',
    cands: [
      ['c1', true,  'const L=32,segment=4; const full_cache=L; const ckpt_cache=L/segment+segment; console.log((ckpt_cache/full_cache).toFixed(4));'],
      ['c2', false, 'const layers=32,k=4; const ratio=(layers/k)/layers; console.log(ratio.toFixed(4));'],
      ['c3', false, 'const layers=32,k=4; const n_checkpoints=k; const recompute_per_segment=layers/k; const ckpt=recompute_per_segment+n_checkpoints*2; const ratio=ckpt/layers; console.log(ratio.toFixed(4));'],
    ],
  },
  { id: 'llm-systems-010',
    ref: 'const logits=[1.2,3.4,0.5,2.8,3.1]; let mx=-Infinity,arg=-1; for(let i=0;i<logits.length;i++){if(logits[i]>mx){mx=logits[i];arg=i;}} console.log(arg);',
    cands: [
      ['c1', true,  'const z=[1.2,3.4,0.5,2.8,3.1]; const idx=z.reduce((best,v,i,arr)=>v>arr[best]?i:best,0); console.log(idx);'],
      ['c2', false, 'const logits=[1.2,3.4,0.5,2.8,3.1]; console.log(logits.indexOf(Math.min(...logits)));'],
      ['c3', false, 'const logits=[1.2,3.4,0.5,2.8,3.1]; const greedy_temp_zero_argmax = (() => { const sorted=[...logits].sort((a,b)=>b-a); return logits.indexOf(sorted[1]); })(); console.log(greedy_temp_zero_argmax);'],
    ],
  },
  { id: 'llm-systems-011',
    ref: 'const scores=[2.0,1.0,3.0,0.5]; const dk=64; const scaled=scores.map(s=>s/Math.sqrt(dk)); const mx=Math.max(...scaled); const exps=scaled.map(s=>Math.exp(s-mx)); const sum=exps.reduce((a,b)=>a+b,0); const probs=exps.map(e=>(e/sum).toFixed(4)); console.log(JSON.stringify(probs));',
    cands: [
      ['c1', true,  'function softmax(v){ const m=Math.max(...v); const e=v.map(x=>Math.exp(x-m)); const s=e.reduce((a,b)=>a+b,0); return e.map(x=>x/s); } const qk=[2.0,1.0,3.0,0.5]; const dk=64; const p=softmax(qk.map(x=>x/Math.sqrt(dk))).map(x=>x.toFixed(4)); console.log(JSON.stringify(p));'],
      ['c2', false, 'const scores=[2.0,1.0,3.0,0.5]; const mx=Math.max(...scores); const exps=scores.map(s=>Math.exp(s-mx)); const sum=exps.reduce((a,b)=>a+b,0); console.log(JSON.stringify(exps.map(e=>(e/sum).toFixed(4))));'],
      ['c3', false, 'const scores=[2.0,1.0,3.0,0.5]; const d_k=64; const scaled=scores.map(s=>s/d_k); const mx=Math.max(...scaled); const exps=scaled.map(s=>Math.exp(s-mx)); const sum=exps.reduce((a,b)=>a+b,0); console.log(JSON.stringify(exps.map(e=>(e/sum).toFixed(4))));'],
    ],
  },
  { id: 'llm-systems-012',
    ref: 'const cache_size=8,n_writes=23; const last_idx=(n_writes-1)%cache_size; console.log(last_idx);',
    cands: [
      ['c1', true,  'function ringPos(N, writes){ return (writes - 1) % N; } console.log(ringPos(8, 23));'],
      ['c2', false, 'const cache_size=8,n_writes=23; console.log(n_writes%cache_size);'],
      ['c3', false, 'const cache_size=8,n_writes=23; const one_based=((n_writes-1)%cache_size)+1; console.log(one_based);'],
    ],
  },
  { id: 'llm-systems-013',
    ref: 'const max_abs=2.5; const scale=max_abs/127.0; const values=[0.5,-1.2,2.5,-2.5,0.0]; const q=values.map(v=>Math.round(v/scale)); console.log(JSON.stringify(q));',
    cands: [
      ['c1', true,  'const absmax=2.5; const sf=absmax/127; const v=[0.5,-1.2,2.5,-2.5,0.0]; const clamp=x=>Math.max(-127,Math.min(127,x)); const q=v.map(x=>clamp(Math.round(x/sf))); console.log(JSON.stringify(q));'],
      ['c2', false, 'const max_abs=2.5; const scale=max_abs/127.0; const values=[0.5,-1.2,2.5,-2.5,0.0]; const q=values.map(v=>Math.trunc(v*scale)); console.log(JSON.stringify(q));'],
      ['c3', false, 'const max_abs=2.5; const scale=max_abs/128.0; const values=[0.5,-1.2,2.5,-2.5,0.0]; const clamp=x=>Math.max(-127,Math.min(127,x)); const q=values.map(v=>clamp(Math.round(v/scale))); console.log(JSON.stringify(q));'],
    ],
  },
  { id: 'llm-systems-014',
    ref: 'const base=512,rank=8; const lora=2*base*rank; const full=base*base; const ratio=lora/full; console.log(ratio.toFixed(6));',
    cands: [
      ['c1', true,  'const d=512,r=8; const adapter_params=2*d*r; const dense_params=d**2; console.log((adapter_params/dense_params).toFixed(6));'],
      ['c2', false, 'const base=512,rank=8; const lora=base*rank; const full=base*base; console.log((lora/full).toFixed(6));'],
      ['c3', false, 'const base=512,rank=8; const down_proj=base*rank; const up_proj=base*rank; const lora=down_proj+up_proj; const full=base+base; console.log((lora/full).toFixed(6));'],
    ],
  },
  { id: 'llm-systems-015',
    ref: 'const chosen=-1.2,rejected=-2.0; const diff=chosen-rejected; const p=1/(1+Math.exp(-diff)); console.log(p.toFixed(6));',
    cands: [
      ['c1', true,  'function sigmoid(x){return 1/(1+Math.exp(-x));} const lp_chosen=-1.2,lp_rejected=-2.0; const p_pref=sigmoid(lp_chosen-lp_rejected); console.log(p_pref.toFixed(6));'],
      ['c2', false, 'const chosen=-1.2,rejected=-2.0; const p=1/(1+Math.exp(-(rejected-chosen))); console.log(p.toFixed(6));'],
      ['c3', false, 'const chosen=-1.2,rejected=-2.0; const sigmoid=x=>1/(1+Math.exp(-x)); const p=1-sigmoid(chosen+rejected); console.log(p.toFixed(6));'],
    ],
  },
  { id: 'llm-systems-016',
    ref: 'const logits=[1.2,0.5,2.1,0.3]; const k=2; const idx=logits.map((v,i)=>({v,i})).sort((a,b)=>b.v-a.v).slice(0,k).map(o=>o.i); console.log(JSON.stringify(idx));',
    cands: [
      ['c1', true,  'const gate=[1.2,0.5,2.1,0.3]; const top_k=2; const ranked=[...gate.keys()].sort((a,b)=>gate[b]-gate[a]).slice(0,top_k); console.log(JSON.stringify(ranked));'],
      ['c2', false, 'const logits=[1.2,0.5,2.1,0.3]; const idx=logits.map((v,i)=>({v,i})).sort((a,b)=>a.v-b.v).slice(0,2).map(o=>o.i); console.log(JSON.stringify(idx));'],
      ['c3', false, 'const gate_logits=[1.2,0.5,2.1,0.3]; const top_k=2; const top_scores=gate_logits.slice().sort((a,b)=>b-a).slice(0,top_k); console.log(JSON.stringify(top_scores));'],
    ],
  },
  { id: 'llm-systems-017',
    ref: 'const dlp=-1.5,tlp=-0.7,u=0.4; const ratio=Math.exp(tlp-dlp); const accept=u<Math.min(1,ratio); console.log(accept);',
    cands: [
      ['c1', true,  'const draft_logp=-1.5,target_logp=-0.7,uniform=0.4; const accept_ratio=Math.min(1.0, Math.exp(target_logp - draft_logp)); console.log(uniform < accept_ratio);'],
      ['c2', false, 'const dlp=-1.5,tlp=-0.7,u=0.4; const reject_prob=1-Math.min(1,Math.exp(tlp-dlp)); console.log(u<reject_prob);'],
      ['c3', false, 'const dlp=-1.5,tlp=-0.7,u=0.4; const log_ratio=Math.min(0, tlp-dlp); console.log(u<log_ratio);'],
    ],
  },
  { id: 'llm-systems-018',
    ref: 'const pos=2,d=4,base=10000; const theta=pos/Math.pow(base,0/d); const c=Math.cos(theta),s=Math.sin(theta); const block=[c,-s,s,c].map(x=>x.toFixed(6)); console.log(JSON.stringify(block));',
    cands: [
      ['c1', true,  'const m=2; const theta_0=m; const cos_t=Math.cos(theta_0), sin_t=Math.sin(theta_0); const R=[[cos_t,-sin_t],[sin_t,cos_t]]; const flat=R.flat().map(x=>x.toFixed(6)); console.log(JSON.stringify(flat));'],
      ['c2', false, 'const pos=2,d=4,base=10000; const theta=pos/Math.pow(base,0/d); const c=Math.cos(theta),s=Math.sin(theta); console.log(JSON.stringify([c,s,-s,c].map(x=>x.toFixed(6))));'],
      ['c3', false, 'const pos=2,d=4,base=10000; const theta_rad_or_deg=pos/Math.pow(base,0/d); const t=theta_rad_or_deg*Math.PI/180; const c=Math.cos(t),s=Math.sin(t); console.log(JSON.stringify([c,-s,s,c].map(x=>x.toFixed(6))));'],
    ],
  },
  { id: 'llm-systems-019',
    ref: 'const seq=1024,dim=64,blk=256; const vanilla=4*seq*seq*dim; const flash=(seq*dim+dim*blk)*(seq/blk); const ratio=flash/vanilla; console.log(ratio.toFixed(6));',
    cands: [
      ['c1', true,  'const N=1024,d=64,B=256; const hbm_vanilla=4*N*N*d; const tiles=N/B; const hbm_flash=(N*d+d*B)*tiles; console.log((hbm_flash/hbm_vanilla).toFixed(6));'],
      ['c2', false, 'const seq=1024,dim=64,blk=256; const vanilla=seq*seq*dim; const flash=(seq*dim+dim*blk)*(seq/blk); console.log((flash/vanilla).toFixed(6));'],
      ['c3', false, 'const seq_len=1024,head_dim=64,block_size=256; const HBM_vanilla=4*seq_len*seq_len*head_dim; const tiles=seq_len/block_size; const HBM_flash=(seq_len*head_dim)+(head_dim*block_size)+tiles; const ratio=HBM_flash/HBM_vanilla; console.log(ratio.toFixed(6));'],
    ],
  },
  { id: 'llm-systems-020',
    ref: 'const C=6e21; const N=Math.pow(C/6,0.5); console.log(N.toExponential(4));',
    cands: [
      ['c1', true,  'const compute=6e21; const flops_per_param_token=6; const N_opt=Math.sqrt(compute/flops_per_param_token); console.log(N_opt.toExponential(4));'],
      ['c2', false, 'const C=6e21; const N=Math.sqrt(C); console.log(N.toExponential(4));'],
      ['c3', false, 'const C=6e21; const flops_per_param_token=6; const N_opt=Math.pow(C/flops_per_param_token, 1/3); console.log(N_opt.toExponential(4));'],
    ],
  },
];

async function main() {
  const fails = [];
  let total = 0;
  let ok_count = 0;
  for (const it of ITEMS) {
    const refResult = await runCell(it.ref, { timeoutMs: 5000 });
    if (!refResult.pass) {
      console.error(`[FAIL-REF] ${it.id} reference_code exec failed: ${refResult.stderr_excerpt}`);
      fails.push({ id: it.id, kind: 'reference-failed' });
      continue;
    }
    const refHash = refResult.stdout_hash;
    console.log(`\n${it.id} REF hash=${refHash.slice(0, 16)}...`);
    for (const [cid, expected, code] of it.cands) {
      total++;
      const r = await runCell(code, { timeoutMs: 5000 });
      const predicted = r.pass && r.stdout_hash === refHash;
      const consistent = predicted === expected;
      const tag = consistent ? '[OK]' : '[BAD]';
      console.log(`  ${tag} ${cid} expected=${expected} predicted=${predicted} hash=${r.stdout_hash.slice(0, 16)} exit=${r.exit_code} stderr=${(r.stderr_excerpt || '').slice(0, 60)}`);
      if (consistent) ok_count++;
      else fails.push({ id: it.id, cid, expected, predicted, stderr: (r.stderr_excerpt || '').slice(0, 200) });
    }
  }
  console.log(`\n=== SUMMARY === total=${total} ok=${ok_count} bad=${fails.length}`);
  if (fails.length === 0) {
    console.log('ALL CONSISTENT — safe to refactor seeder.');
  } else {
    console.log('INCONSISTENT CANDIDATES:');
    for (const f of fails) console.log('  ', JSON.stringify(f));
    process.exit(2);
  }
}

main().catch(err => { console.error(err); process.exit(3); });
