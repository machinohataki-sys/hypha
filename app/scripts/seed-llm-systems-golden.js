// V0.5 E0 D11 — llm-systems golden item seeder (verification_channel = 'code')
//
// Mirror of seed-philosophy-golden.js for the executable verification channel.
// Each item carries an `exec_cell` that the evaluator runs in a child node
// process; pass = exit_code 0 AND sha256(stdout) == expected_stdout_hash.
// Per app/lib/evaluator/verification-channels/exec-cell.js, the hash is
// computed over the FULL stdout bytes (including trailing newline from
// console.log); we therefore commit hashes of the raw stdout to keep
// assertCell deterministic.
//
// Schema:
//   {
//     id, topic: 'llm-systems', lifecycle, source_anchor,
//     verification_channel: 'code', schema_version: '0.5.D11',
//     prompt_text,        // shown to learner
//     exec_cell: { language, code, expected_stdout_hash, timeout_ms },
//     candidate_responses,// author-rated cross-check (mirrors philosophy schema)
//     k_threshold,        // 1 — binary code-runs
//     sealed_at, sealed_algorithm, sealed_normalization, notes,
//   }
//
// Run:
//   node app/scripts/seed-llm-systems-golden.js                   # create new only
//   node app/scripts/seed-llm-systems-golden.js --force-reseal    # regenerate all
//   node app/scripts/seed-llm-systems-golden.js --check-drift     # warn if existing != current
//
// Created 2026-05-10 on v0.5-substrate (Phase 1 D11-D14 Group beta).

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sealed = require('../lib/evaluator/verification-channels/sealed-rubric');
const execCell = require('../lib/evaluator/verification-channels/exec-cell');

const TARGET_DIR = path.join(__dirname, '..', '..', 'vault', '.evaluator', 'golden', 'llm-systems');
const TOPIC = 'llm-systems';
// V0.5 E0 PIVOT (2026-05-11): candidate schema upgraded from {id,text,features_hit_truth}
// to {id,text,code,expected_pass,features_hit_truth}. features_hit_truth retained for
// backward compat; not consumed by the new exec-channel auto-judge (run-eval-exec-channel.js).
const SCHEMA_VERSION = '0.5.D20-pivot';
const DEFAULT_TIMEOUT_MS = 5000;

function _sha256(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

// Each item's exec_cell.code is held to a contract:
//   - prints exactly the bytes whose sha256 equals expected_stdout_hash
//   - deterministic (no Date.now / Math.random / network)
//   - completes well under timeout_ms
//   - uses standard Node global (no npm deps)
//
// Hashes below were computed by running each `code` in `node -e` and sha256-ing
// the resulting raw stdout. Authors rerunning with --force-reseal that mutate
// `code` MUST also recompute and replace expected_stdout_hash, or assertCell
// will fail. _itemFingerprint guards against silent drift across reseals.

const ITEMS = [
  {
    id: 'llm-systems-001',
    source_anchor: 'Vaswani et al. 2017 "Attention Is All You Need" §3.2.1; Karpathy nanoGPT/model.py CausalSelfAttention',
    prompt_text: 'For multi-head attention with batch B=2, sequence T=8, heads H=4, head dim D=64, give the shape [B, T, H, D] as a JSON array printed on stdout.',
    exec_cell: {
      language: 'node',
      code: 'const B=2,T=8,H=4,D=64; const out=[B,T,H,D]; console.log(JSON.stringify(out));',
      expected_stdout_hash: '68438c68f27d218c1c7485113fa055637204bced5ed417d0188a00dbf392b2e6',
      timeout_ms: DEFAULT_TIMEOUT_MS,
    },
    k_threshold: 1,
    candidate_responses: [
      { id: 'c1', expected_pass: true,
        text: 'CORRECT: builds the [B,T,H,D] shape via a dims object with explicit named keys (batch/seq/heads/head_dim) and prints JSON.',
        code: 'const dims={batch:2,seq:8,heads:4,head_dim:64}; const shape=[dims.batch,dims.seq,dims.heads,dims.head_dim]; console.log(JSON.stringify(shape));',
        features_hit_truth: ['exec_pass'] },
      { id: 'c2', expected_pass: false,
        text: 'WRONG: emits the heads-major [B,H,T,D] order — drops the canonical [B,T,H,D] convention.',
        code: 'const B=2,T=8,H=4,D=64; const out=[B,H,T,D]; console.log(JSON.stringify(out));',
        features_hit_truth: [] },
      { id: 'c3', expected_pass: false,
        text: 'CARGO-CULT: names B,T,H,D, builds a dims object, calls JSON.stringify, but reverses the value order.',
        code: 'const B=2,T=8,H=4,D=64; const dims={B,T,H,D}; const shape=Object.values(dims).reverse(); console.log(JSON.stringify(shape));',
        features_hit_truth: [] },
    ],
  },
  {
    id: 'llm-systems-002',
    source_anchor: 'Pope et al. 2022 "Efficiently Scaling Transformer Inference" §2.2 KV cache; Shoeybi et al. 2019 Megatron-LM §3',
    prompt_text: 'KV cache total bytes: seq_len=2048, n_heads=32, head_dim=128, dtype_bytes=2 (fp16), n_layers=32. Compute total bytes = 2 * seq_len * n_heads * head_dim * dtype_bytes * n_layers (factor 2 = K and V) and print the integer.',
    exec_cell: {
      language: 'node',
      code: 'const seq=2048,heads=32,dim=128,bytes=2,layers=32; const total=2*seq*heads*dim*bytes*layers; console.log(total);',
      expected_stdout_hash: '6ca8d2dfdb2484b3436a085985b597b617554bd1051e8677dc140f778ea66592',
      timeout_ms: DEFAULT_TIMEOUT_MS,
    },
    k_threshold: 1,
    candidate_responses: [
      { id: 'c1', expected_pass: true,
        text: 'CORRECT: parameterised cfg object + explicit kv_factor=2 multiplier; computes the same product as the reference.',
        code: 'const cfg={seq_len:2048,n_heads:32,head_dim:128,dtype_bytes:2,n_layers:32}; const kv_factor=2; let total=kv_factor; for (const k of ["seq_len","n_heads","head_dim","dtype_bytes","n_layers"]) total*=cfg[k]; console.log(total);',
        features_hit_truth: ['exec_pass'] },
      { id: 'c2', expected_pass: false,
        text: 'WRONG: drops the factor-of-2 that accounts for both K and V tensors — undercount by exactly half.',
        code: 'const seq_len=2048,n_heads=32,head_dim=128,dtype_bytes=2,n_layers=32; const total=seq_len*n_heads*head_dim*dtype_bytes*n_layers; console.log(total);',
        features_hit_truth: [] },
      { id: 'c3', expected_pass: false,
        text: 'CARGO-CULT: declares seq_len/n_heads/head_dim/dtype_bytes/n_layers AND a kv_factor variable, but mistakenly applies the factor by squaring n_layers.',
        code: 'const seq_len=2048,n_heads=32,head_dim=128,dtype_bytes=2,n_layers=32; const kv_factor=2; const total=seq_len*n_heads*head_dim*dtype_bytes*n_layers*n_layers; console.log(total);',
        features_hit_truth: [] },
    ],
  },
  {
    id: 'llm-systems-003',
    source_anchor: 'Su et al. 2023 "RoFormer: Enhanced Transformer with Rotary Position Embedding" §2.2; arXiv:2104.09864',
    prompt_text: 'Rotary position embedding angle theta = pos / base^(2*dim_idx/D) for pos=10, dim_idx=4, D=64, base=10000. Print theta to 6 decimal places.',
    exec_cell: {
      language: 'node',
      code: 'const pos=10,dim_idx=4,D=64,base=10000; const angle=pos/Math.pow(base,(2*dim_idx)/D); console.log(angle.toFixed(6));',
      expected_stdout_hash: '10d3504e6765c424e1e6014c89c785f0d829c36ecaa4ec2be5659bd2f94342a1',
      timeout_ms: DEFAULT_TIMEOUT_MS,
    },
    k_threshold: 1,
    candidate_responses: [
      { id: 'c1', expected_pass: true,
        text: 'CORRECT: rewrites the same angle formula with negative-exponent power form (pos * base^(-2i/D)).',
        code: 'const position=10,i=4,head_dim=64,theta_base=10000; const theta=position*Math.pow(theta_base,-(2*i/head_dim)); console.log(theta.toFixed(6));',
        features_hit_truth: ['exec_pass'] },
      { id: 'c2', expected_pass: false,
        text: 'WRONG: drops the factor of 2 in the exponent, doubling the implicit frequency band.',
        code: 'const pos=10,dim_idx=4,D=64,base=10000; const angle=pos/Math.pow(base,dim_idx/D); console.log(angle.toFixed(6));',
        features_hit_truth: [] },
      { id: 'c3', expected_pass: false,
        text: 'CARGO-CULT: keeps all the right identifiers (pos, dim_idx, D, base, Math.pow, 2*dim_idx/D) but multiplies instead of dividing by the base.',
        code: 'const pos=10,dim_idx=4,D=64,base=10000; const angle=pos*Math.pow(base,(2*dim_idx)/D); console.log(angle.toFixed(6));',
        features_hit_truth: [] },
    ],
  },
  {
    id: 'llm-systems-004',
    source_anchor: 'Ba, Kiros, Hinton 2016 "Layer Normalization" §3; Ioffe Szegedy 2015 "Batch Normalization" §2 (contrast)',
    prompt_text: 'Apply layer normalization to feature vector [1, 2, 3, 4]: subtract mean, divide by population stddev (N divisor), 4-decimal precision. Print the result as a JSON array of 4-decimal strings.',
    exec_cell: {
      language: 'node',
      code: 'const x=[1,2,3,4]; const mean=x.reduce((a,b)=>a+b,0)/x.length; const v=x.reduce((a,b)=>a+(b-mean)*(b-mean),0)/x.length; const std=Math.sqrt(v); const ln=x.map(xi=>((xi-mean)/std).toFixed(4)); console.log(JSON.stringify(ln));',
      expected_stdout_hash: 'dd237a74b1aeff0c25536deb4b876a716fe6647c4794061f217a368feef99810',
      timeout_ms: DEFAULT_TIMEOUT_MS,
    },
    k_threshold: 1,
    candidate_responses: [
      { id: 'c1', expected_pass: true,
        text: 'CORRECT: single-pass mean + population-variance reduction, alternate identifiers (mu, sigma).',
        code: 'const features=[1,2,3,4]; const N=features.length; const mu=features.reduce((s,v)=>s+v,0)/N; const variance=features.reduce((s,v)=>s+(v-mu)**2,0)/N; const sigma=Math.sqrt(variance); const out=features.map(v=>((v-mu)/sigma).toFixed(4)); console.log(JSON.stringify(out));',
        features_hit_truth: ['exec_pass'] },
      { id: 'c2', expected_pass: false,
        text: 'WRONG: uses Bessel-corrected sample variance (divisor N-1) instead of population variance (divisor N).',
        code: 'const x=[1,2,3,4]; const mean=x.reduce((a,b)=>a+b)/x.length; const v=x.reduce((a,b)=>a+(b-mean)**2,0)/(x.length-1); const std=Math.sqrt(v); console.log(JSON.stringify(x.map(xi=>((xi-mean)/std).toFixed(4))));',
        features_hit_truth: [] },
      { id: 'c3', expected_pass: false,
        text: 'CARGO-CULT: uses mean / sigma / Math.sqrt vocabulary, but replaces variance with mean-absolute-deviation under the same sqrt.',
        code: 'const x=[1,2,3,4]; const mean=x.reduce((a,b)=>a+b)/x.length; const mad=x.reduce((a,b)=>a+Math.abs(b-mean),0)/x.length; const sigma=Math.sqrt(mad); console.log(JSON.stringify(x.map(xi=>((xi-mean)/sigma).toFixed(4))));',
        features_hit_truth: [] },
    ],
  },
  {
    id: 'llm-systems-005',
    source_anchor: 'Srivastava et al. 2014 "Dropout" §4; PyTorch torch.nn.functional.dropout reference',
    prompt_text: 'Generate a deterministic dropout mask using LCG seed=12345 (multiplier=1103515245, increment=12345, modulus=2^31), p=0.3 dropout rate, n=20 elements. Mask convention: r<p means dropped (0), r>=p means kept (1). Print the integer sum of the mask.',
    exec_cell: {
      language: 'node',
      code: 'let s=12345; const rand=()=>{s=(1103515245*s+12345)%2147483648;return s/2147483648;}; const p=0.3; const n=20; let sum=0; for(let i=0;i<n;i++){sum+=(rand()<p?0:1);} console.log(sum);',
      expected_stdout_hash: 'e6c21e8d260fe71882debdb339d2402a2ca7648529bc2303f48649bce0380017',
      timeout_ms: DEFAULT_TIMEOUT_MS,
    },
    k_threshold: 1,
    candidate_responses: [
      { id: 'c1', expected_pass: true,
        text: 'CORRECT: same LCG via bitwise mod-2^31 mask + while loop counting keeps.',
        code: 'let state=12345; function next(){state=(1103515245*state+12345)&0x7FFFFFFF;return state/2147483648;} let kept=0,i=0; while(i++<20){ if(next()>=0.3) kept++; } console.log(kept);',
        features_hit_truth: ['exec_pass'] },
      { id: 'c2', expected_pass: false,
        text: 'WRONG: inverts the dropout convention (treats r>=p as dropped instead of kept).',
        code: 'let s=12345; const r=()=>{s=(1103515245*s+12345)%2147483648;return s/2147483648;}; let sum=0; for(let i=0;i<20;i++){sum+=(r()>=0.3?0:1);} console.log(sum);',
        features_hit_truth: [] },
      { id: 'c3', expected_pass: false,
        text: 'CARGO-CULT: LCG vocabulary (multiplier / increment / modulus) and right loop, but uses 2^32 modulus (unsigned) instead of 2^31 (signed) — the classic stdlib lcg signedness slip.',
        code: 'let s=12345; const multiplier=1103515245,increment=12345,modulus=4294967296; const r=()=>{s=(multiplier*s+increment)%modulus;return s/modulus;}; let sum=0; for(let i=0;i<20;i++){sum+=(r()<0.3?0:1);} console.log(sum);',
        features_hit_truth: [] },
    ],
  },
  {
    id: 'llm-systems-006',
    source_anchor: 'Jelinek et al. 1977 "Perplexity — a measure of difficulty of speech recognition tasks"; Brown et al. 1992 "An Estimate of an Upper Bound for the Entropy of English"',
    prompt_text: 'Given per-token cross-entropy losses [2.1, 1.8, 2.3, 1.9, 2.0] (natural log base), compute perplexity = exp(mean(losses)). Print to 4 decimal places.',
    exec_cell: {
      language: 'node',
      code: 'const losses=[2.1,1.8,2.3,1.9,2.0]; const mean=losses.reduce((a,b)=>a+b,0)/losses.length; const ppl=Math.exp(mean); console.log(ppl.toFixed(4));',
      expected_stdout_hash: 'd8a871ebf33b52a40fdf6eb2a5309378a11e6af7a0bf2aa4ceba3b93bc1e1c0b',
      timeout_ms: DEFAULT_TIMEOUT_MS,
    },
    k_threshold: 1,
    candidate_responses: [
      { id: 'c1', expected_pass: true,
        text: 'CORRECT: Math.E**mean phrasing instead of Math.exp(mean); same identifier names refactored.',
        code: 'const ce_loss=[2.1,1.8,2.3,1.9,2.0]; const avg_loss=ce_loss.reduce((acc,x)=>acc+x,0)/ce_loss.length; const perplexity=Math.E**avg_loss; console.log(perplexity.toFixed(4));',
        features_hit_truth: ['exec_pass'] },
      { id: 'c2', expected_pass: false,
        text: 'WRONG: takes Math.exp of the SUM of losses rather than the MEAN — common bug when porting from log-prob land.',
        code: 'const losses=[2.1,1.8,2.3,1.9,2.0]; const sum=losses.reduce((a,b)=>a+b,0); const ppl=Math.exp(sum); console.log(ppl.toFixed(4));',
        features_hit_truth: [] },
      { id: 'c3', expected_pass: false,
        text: 'CARGO-CULT: keeps perplexity / Math.exp / mean vocabulary, but computes exp of the mean of the LOG of the losses (treats losses as raw probabilities by mistake).',
        code: 'const losses=[2.1,1.8,2.3,1.9,2.0]; const log_losses=losses.map(l=>Math.log(l)); const mean_log=log_losses.reduce((a,b)=>a+b,0)/log_losses.length; const perplexity=Math.exp(mean_log); console.log(perplexity.toFixed(4));',
        features_hit_truth: [] },
    ],
  },
  {
    id: 'llm-systems-007',
    source_anchor: 'Sennrich Haddow Birch 2016 "Neural Machine Translation of Rare Words with Subword Units" §3 BPE; Touvron et al. 2023 LLaMA §2 tokenizer',
    prompt_text: 'For the simple whitespace-split tokenizer applied to "the quick brown fox jumps over the lazy dog", compute average bytes per token = utf8_byte_length / token_count. Print to 4 decimal places.',
    exec_cell: {
      language: 'node',
      code: "const text='the quick brown fox jumps over the lazy dog'; const tokens=text.split(/\\s+/); const bytes=text.length; const avg=bytes/tokens.length; console.log(avg.toFixed(4));",
      expected_stdout_hash: '90435147b1c9a185cb9f71cf5ba1d34fcec2bbf8465a22c072fa3549c2e46241',
      timeout_ms: DEFAULT_TIMEOUT_MS,
    },
    k_threshold: 1,
    candidate_responses: [
      { id: 'c1', expected_pass: true,
        text: 'CORRECT: uses Buffer.byteLength UTF-8 byte counter and literal-space split — same numerator/denominator.',
        code: "const sentence='the quick brown fox jumps over the lazy dog'; const tok_count=sentence.split(' ').length; const utf8_bytes=Buffer.byteLength(sentence,'utf8'); const bpt=utf8_bytes/tok_count; console.log(bpt.toFixed(4));",
        features_hit_truth: ['exec_pass'] },
      { id: 'c2', expected_pass: false,
        text: 'WRONG: inverts the ratio (tokens-per-byte instead of bytes-per-token).',
        code: "const text='the quick brown fox jumps over the lazy dog'; const tokens=text.split(/\\s+/); const ratio=tokens.length/text.length; console.log(ratio.toFixed(4));",
        features_hit_truth: [] },
      { id: 'c3', expected_pass: false,
        text: 'CARGO-CULT: uses tokens / utf8_bytes vocabulary, but counts byte length of tokens.join("") which drops the 8 separator chars.',
        code: "const text='the quick brown fox jumps over the lazy dog'; const tokens=text.split(/\\s+/); const utf8_bytes=tokens.join('').length; const avg=utf8_bytes/tokens.length; console.log(avg.toFixed(4));",
        features_hit_truth: [] },
    ],
  },
  {
    id: 'llm-systems-008',
    source_anchor: 'Loshchilov Hutter 2017 "SGDR: Stochastic Gradient Descent with Warm Restarts"; Vaswani et al. 2017 §5.3 (linear warmup)',
    prompt_text: 'Linear warmup + cosine decay learning rate schedule: step=2000, warmup_steps=1000, total_steps=10000, peak_lr=3e-4. During warmup (step < warmup_steps): lr = peak_lr * step / warmup_steps. After warmup: lr = peak_lr * 0.5 * (1 + cos(pi * (step - warmup) / (total - warmup))). Print lr to 6 decimal places.',
    exec_cell: {
      language: 'node',
      code: 'const step=2000,warmup=1000,total=10000,peak=3e-4; let lr; if(step<warmup){lr=peak*step/warmup;}else{const prog=(step-warmup)/(total-warmup);lr=peak*0.5*(1+Math.cos(Math.PI*prog));} console.log(lr.toFixed(6));',
      expected_stdout_hash: '777520ae0a7834615e2a3d3a39e684cfa33e262c053d5d0b3f909eb33c1d4f9f',
      timeout_ms: DEFAULT_TIMEOUT_MS,
    },
    k_threshold: 1,
    candidate_responses: [
      { id: 'c1', expected_pass: true,
        text: 'CORRECT: same schedule expressed as ternary; alternate identifiers (s/w/T/peak_lr).',
        code: 'const s=2000,w=1000,T=10000,peak_lr=3e-4; const lr = (s<w) ? peak_lr*(s/w) : peak_lr*0.5*(1+Math.cos(Math.PI*((s-w)/(T-w)))); console.log(lr.toFixed(6));',
        features_hit_truth: ['exec_pass'] },
      { id: 'c2', expected_pass: false,
        text: 'WRONG: progress numerator forgets the (step-warmup) shift, also skips the warmup branch — answer is off.',
        code: 'const step=2000,warmup=1000,total=10000,peak=3e-4; const prog=step/(total-warmup); const lr=peak*0.5*(1+Math.cos(Math.PI*prog)); console.log(lr.toFixed(6));',
        features_hit_truth: [] },
      { id: 'c3', expected_pass: false,
        text: 'CARGO-CULT: warmup branch + cosine branch + Math.PI + peak vocabulary, but uses Math.sin (phase shift) instead of Math.cos in the decay term.',
        code: 'const step=2000,warmup=1000,total=10000,peak=3e-4; let lr; if(step<warmup){lr=peak*step/warmup;}else{const prog=(step-warmup)/(total-warmup);lr=peak*0.5*(1+Math.sin(Math.PI*prog));} console.log(lr.toFixed(6));',
        features_hit_truth: [] },
    ],
  },
  {
    id: 'llm-systems-009',
    source_anchor: 'Chen et al. 2016 "Training Deep Nets with Sublinear Memory Cost" §3 (gradient checkpointing); Korthikanti et al. 2022 "Reducing Activation Recomputation"',
    prompt_text: 'Gradient checkpointing memory ratio: with L=32 transformer layers and checkpoint-every-k segments where k=4, full activation cache is L units; checkpoint cache is (L/k) checkpoints + k recomputed activations within the active segment. Print ratio = (L/k + k) / L to 4 decimal places.',
    exec_cell: {
      language: 'node',
      code: 'const layers=32,k=4; const full=layers; const ckpt=layers/k+k; const ratio=ckpt/full; console.log(ratio.toFixed(4));',
      expected_stdout_hash: '306a6a534582ac20db8fbb77bb601c871d4630aaed5e5beaaa592e5d86358427',
      timeout_ms: DEFAULT_TIMEOUT_MS,
    },
    k_threshold: 1,
    candidate_responses: [
      { id: 'c1', expected_pass: true,
        text: 'CORRECT: explicit full_cache and ckpt_cache named intermediates, same formula.',
        code: 'const L=32,segment=4; const full_cache=L; const ckpt_cache=L/segment+segment; console.log((ckpt_cache/full_cache).toFixed(4));',
        features_hit_truth: ['exec_pass'] },
      { id: 'c2', expected_pass: false,
        text: 'WRONG: drops the +k recomputation term — counts only the saved checkpoints.',
        code: 'const layers=32,k=4; const ratio=(layers/k)/layers; console.log(ratio.toFixed(4));',
        features_hit_truth: [] },
      { id: 'c3', expected_pass: false,
        text: 'CARGO-CULT: layers / k / n_checkpoints / recompute_per_segment / ratio vocabulary, but inflates the numerator by doubling the checkpoint contribution.',
        code: 'const layers=32,k=4; const n_checkpoints=k; const recompute_per_segment=layers/k; const ckpt=recompute_per_segment+n_checkpoints*2; const ratio=ckpt/layers; console.log(ratio.toFixed(4));',
        features_hit_truth: [] },
    ],
  },
  {
    id: 'llm-systems-010',
    source_anchor: 'Holtzman et al. 2020 "The Curious Case of Neural Text Degeneration" §2 (temperature & argmax); Karpathy nanoGPT/sample.py',
    prompt_text: 'Temperature sampling at temp=0 collapses to argmax. Given logits [1.2, 3.4, 0.5, 2.8, 3.1], print the argmax index (0-based).',
    exec_cell: {
      language: 'node',
      code: 'const logits=[1.2,3.4,0.5,2.8,3.1]; let mx=-Infinity,arg=-1; for(let i=0;i<logits.length;i++){if(logits[i]>mx){mx=logits[i];arg=i;}} console.log(arg);',
      expected_stdout_hash: '4355a46b19d348dc2f57c046f8ef63d4538ebb936000f3c9ee954a27460dd865',
      timeout_ms: DEFAULT_TIMEOUT_MS,
    },
    k_threshold: 1,
    candidate_responses: [
      { id: 'c1', expected_pass: true,
        text: 'CORRECT: reduce-based argmax tracking the best index seen so far.',
        code: 'const z=[1.2,3.4,0.5,2.8,3.1]; const idx=z.reduce((best,v,i,arr)=>v>arr[best]?i:best,0); console.log(idx);',
        features_hit_truth: ['exec_pass'] },
      { id: 'c2', expected_pass: false,
        text: 'WRONG: returns argmin instead of argmax.',
        code: 'const logits=[1.2,3.4,0.5,2.8,3.1]; console.log(logits.indexOf(Math.min(...logits)));',
        features_hit_truth: [] },
      { id: 'c3', expected_pass: false,
        text: 'CARGO-CULT: greedy_temp_zero_argmax variable name + descending sort, but returns the index of the SECOND-largest (the second sampling token).',
        code: 'const logits=[1.2,3.4,0.5,2.8,3.1]; const greedy_temp_zero_argmax = (() => { const sorted=[...logits].sort((a,b)=>b-a); return logits.indexOf(sorted[1]); })(); console.log(greedy_temp_zero_argmax);',
        features_hit_truth: [] },
    ],
  },
  // ---- D15-D18 Group delta extension: items 011-020 (10 more code-cell items)
  // Each hash was computed by running `code` through `node -e` on this branch
  // and sha256-ing the raw stdout (including trailing newline). See plan file
  // C:\Users\32043\.claude\plans\fluffy-hugging-swan.md Phase 2 D15-D18.
  {
    id: 'llm-systems-011',
    source_anchor: 'Vaswani et al. 2017 "Attention Is All You Need" §3.2.1 (scaled dot-product attention); Karpathy nanoGPT/model.py CausalSelfAttention',
    prompt_text: 'Scaled dot-product softmax: given QK^T row scores [2.0, 1.0, 3.0, 0.5] and head_dim d_k=64, compute softmax(scores / sqrt(d_k)) over the row using the numerically stable max-subtraction trick. Print the 4-decimal probability vector as a JSON array.',
    exec_cell: {
      language: 'node',
      code: 'const scores=[2.0,1.0,3.0,0.5]; const dk=64; const scaled=scores.map(s=>s/Math.sqrt(dk)); const mx=Math.max(...scaled); const exps=scaled.map(s=>Math.exp(s-mx)); const sum=exps.reduce((a,b)=>a+b,0); const probs=exps.map(e=>(e/sum).toFixed(4)); console.log(JSON.stringify(probs));',
      expected_stdout_hash: '052851cd6cc55a8e28ef9b7c1b9c8c173b33bca5540c31e63a8bbd4d380f9c37',
      timeout_ms: DEFAULT_TIMEOUT_MS,
    },
    k_threshold: 1,
    candidate_responses: [
      { id: 'c1', expected_pass: true,
        text: 'CORRECT: extracts softmax to a helper function; scaled by sqrt(d_k); same numerically-stable max-subtraction.',
        code: 'function softmax(v){ const m=Math.max(...v); const e=v.map(x=>Math.exp(x-m)); const s=e.reduce((a,b)=>a+b,0); return e.map(x=>x/s); } const qk=[2.0,1.0,3.0,0.5]; const dk=64; const p=softmax(qk.map(x=>x/Math.sqrt(dk))).map(x=>x.toFixed(4)); console.log(JSON.stringify(p));',
        features_hit_truth: ['exec_pass'] },
      { id: 'c2', expected_pass: false,
        text: 'WRONG: drops the scale-by-sqrt(d_k) step entirely (treats raw scores as the input to softmax).',
        code: 'const scores=[2.0,1.0,3.0,0.5]; const mx=Math.max(...scores); const exps=scores.map(s=>Math.exp(s-mx)); const sum=exps.reduce((a,b)=>a+b,0); console.log(JSON.stringify(exps.map(e=>(e/sum).toFixed(4))));',
        features_hit_truth: [] },
      { id: 'c3', expected_pass: false,
        text: 'CARGO-CULT: softmax / max-subtract / Math.exp / d_k naming all present, but divides by d_k itself instead of sqrt(d_k).',
        code: 'const scores=[2.0,1.0,3.0,0.5]; const d_k=64; const scaled=scores.map(s=>s/d_k); const mx=Math.max(...scaled); const exps=scaled.map(s=>Math.exp(s-mx)); const sum=exps.reduce((a,b)=>a+b,0); console.log(JSON.stringify(exps.map(e=>(e/sum).toFixed(4))));',
        features_hit_truth: [] },
    ],
  },
  {
    id: 'llm-systems-012',
    source_anchor: 'Pope et al. 2022 "Efficiently Scaling Transformer Inference" §2.2 (KV cache); vLLM PagedAttention block layout (Kwon et al. 2023)',
    prompt_text: 'Ring-buffer KV cache write index: for cache_size=8 and n_writes=23, the write index of the LAST write (0-based) is (n_writes - 1) mod cache_size. Print the integer.',
    exec_cell: {
      language: 'node',
      code: 'const cache_size=8,n_writes=23; const last_idx=(n_writes-1)%cache_size; console.log(last_idx);',
      expected_stdout_hash: '06e9d52c1720fca412803e3b07c4b228ff113e303f4c7ab94665319d832bbfb7',
      timeout_ms: DEFAULT_TIMEOUT_MS,
    },
    k_threshold: 1,
    candidate_responses: [
      { id: 'c1', expected_pass: true,
        text: 'CORRECT: wraps the formula in a ringPos function for reuse — same modular arithmetic.',
        code: 'function ringPos(N, writes){ return (writes - 1) % N; } console.log(ringPos(8, 23));',
        features_hit_truth: ['exec_pass'] },
      { id: 'c2', expected_pass: false,
        text: 'WRONG: drops the -1 step (counts inclusive-of-current-write into the index slot).',
        code: 'const cache_size=8,n_writes=23; console.log(n_writes%cache_size);',
        features_hit_truth: [] },
      { id: 'c3', expected_pass: false,
        text: 'CARGO-CULT: cache_size / n_writes / modulo, but converts to 1-based indexing at the end.',
        code: 'const cache_size=8,n_writes=23; const one_based=((n_writes-1)%cache_size)+1; console.log(one_based);',
        features_hit_truth: [] },
    ],
  },
  {
    id: 'llm-systems-013',
    source_anchor: 'Jacob et al. 2018 "Quantization and Training of Neural Networks for Efficient Integer-Arithmetic-Only Inference" §3.1; Dettmers et al. 2022 LLM.int8() §2',
    prompt_text: 'Symmetric per-tensor int8 quantization: scale = max_abs / 127.0; q = round(x / scale) clamped to [-127, 127]. Given max_abs=2.5 and values [0.5, -1.2, 2.5, -2.5, 0.0], print the quantized integers as a JSON array.',
    exec_cell: {
      language: 'node',
      code: 'const max_abs=2.5; const scale=max_abs/127.0; const values=[0.5,-1.2,2.5,-2.5,0.0]; const q=values.map(v=>Math.round(v/scale)); console.log(JSON.stringify(q));',
      expected_stdout_hash: '8c3be2796e2003d4d2201aced8dc0aa0fe08e95251a41ebb631467b78dac3e09',
      timeout_ms: DEFAULT_TIMEOUT_MS,
    },
    k_threshold: 1,
    candidate_responses: [
      { id: 'c1', expected_pass: true,
        text: 'CORRECT: adds explicit clamp(-127, 127) wrapper around Math.round — boundary cases hit the clamp identically.',
        code: 'const absmax=2.5; const sf=absmax/127; const v=[0.5,-1.2,2.5,-2.5,0.0]; const clamp=x=>Math.max(-127,Math.min(127,x)); const q=v.map(x=>clamp(Math.round(x/sf))); console.log(JSON.stringify(q));',
        features_hit_truth: ['exec_pass'] },
      { id: 'c2', expected_pass: false,
        text: 'WRONG: multiplies by scale (instead of dividing) AND uses Math.trunc (instead of round) — compound bug.',
        code: 'const max_abs=2.5; const scale=max_abs/127.0; const values=[0.5,-1.2,2.5,-2.5,0.0]; const q=values.map(v=>Math.trunc(v*scale)); console.log(JSON.stringify(q));',
        features_hit_truth: [] },
      { id: 'c3', expected_pass: false,
        text: 'CARGO-CULT: scale, clamp[-127,127], Math.round all present — but uses divisor 128 (unsigned-byte width) instead of 127 (signed int8 max).',
        code: 'const max_abs=2.5; const scale=max_abs/128.0; const values=[0.5,-1.2,2.5,-2.5,0.0]; const clamp=x=>Math.max(-127,Math.min(127,x)); const q=values.map(v=>clamp(Math.round(v/scale))); console.log(JSON.stringify(q));',
        features_hit_truth: [] },
    ],
  },
  {
    id: 'llm-systems-014',
    source_anchor: 'Hu et al. 2021 "LoRA: Low-Rank Adaptation of Large Language Models" §4.1; arXiv:2106.09685',
    prompt_text: 'LoRA parameter savings vs full dense: for a square base layer with base_dim=512 and rank=8, LoRA adds 2 * base_dim * rank parameters (the down- and up-projection); the full dense weight has base_dim * base_dim parameters. Print the ratio LoRA/full to 6 decimal places.',
    exec_cell: {
      language: 'node',
      code: 'const base=512,rank=8; const lora=2*base*rank; const full=base*base; const ratio=lora/full; console.log(ratio.toFixed(6));',
      expected_stdout_hash: 'c39dcd513ced7ef7e803029ad17fd8bb49bebd0f58a9754716859b08a02f51f3',
      timeout_ms: DEFAULT_TIMEOUT_MS,
    },
    k_threshold: 1,
    candidate_responses: [
      { id: 'c1', expected_pass: true,
        text: 'CORRECT: adapter_params + dense_params variables, ** operator for the square.',
        code: 'const d=512,r=8; const adapter_params=2*d*r; const dense_params=d**2; console.log((adapter_params/dense_params).toFixed(6));',
        features_hit_truth: ['exec_pass'] },
      { id: 'c2', expected_pass: false,
        text: 'WRONG: drops the factor of 2 (counts only one projection out of the two).',
        code: 'const base=512,rank=8; const lora=base*rank; const full=base*base; console.log((lora/full).toFixed(6));',
        features_hit_truth: [] },
      { id: 'c3', expected_pass: false,
        text: 'CARGO-CULT: down_proj / up_proj / rank vocabulary, but mistakes the dense baseline as (base + base) instead of base*base.',
        code: 'const base=512,rank=8; const down_proj=base*rank; const up_proj=base*rank; const lora=down_proj+up_proj; const full=base+base; console.log((lora/full).toFixed(6));',
        features_hit_truth: [] },
    ],
  },
  {
    id: 'llm-systems-015',
    source_anchor: 'Christiano et al. 2017 "Deep RL from Human Preferences" §2 (Bradley-Terry); Ouyang et al. 2022 "Training language models to follow instructions with human feedback" (InstructGPT) §3.4',
    prompt_text: 'Bradley-Terry preference probability for RLHF reward modeling: given chosen_logp = -1.2 and rejected_logp = -2.0, compute P(chosen > rejected) = sigmoid(chosen_logp - rejected_logp). Print to 6 decimal places.',
    exec_cell: {
      language: 'node',
      code: 'const chosen=-1.2,rejected=-2.0; const diff=chosen-rejected; const p=1/(1+Math.exp(-diff)); console.log(p.toFixed(6));',
      expected_stdout_hash: '9daf35229fa4dd9f0cf77699ad782c3a2df349644d89c08f827a3ae4379af0b2',
      timeout_ms: DEFAULT_TIMEOUT_MS,
    },
    k_threshold: 1,
    candidate_responses: [
      { id: 'c1', expected_pass: true,
        text: 'CORRECT: defines a sigmoid helper, applies to (chosen_logp - rejected_logp).',
        code: 'function sigmoid(x){return 1/(1+Math.exp(-x));} const lp_chosen=-1.2,lp_rejected=-2.0; const p_pref=sigmoid(lp_chosen-lp_rejected); console.log(p_pref.toFixed(6));',
        features_hit_truth: ['exec_pass'] },
      { id: 'c2', expected_pass: false,
        text: 'WRONG: flips the difference sign (rejected - chosen) — returns the complementary probability.',
        code: 'const chosen=-1.2,rejected=-2.0; const p=1/(1+Math.exp(-(rejected-chosen))); console.log(p.toFixed(6));',
        features_hit_truth: [] },
      { id: 'c3', expected_pass: false,
        text: 'CARGO-CULT: sigmoid + chosen/rejected logp + Math.exp present, but combines via 1 - sigmoid(chosen+rejected) — uses sum instead of difference.',
        code: 'const chosen=-1.2,rejected=-2.0; const sigmoid=x=>1/(1+Math.exp(-x)); const p=1-sigmoid(chosen+rejected); console.log(p.toFixed(6));',
        features_hit_truth: [] },
    ],
  },
  {
    id: 'llm-systems-016',
    source_anchor: 'Shazeer et al. 2017 "Outrageously Large Neural Networks: The Sparsely-Gated Mixture-of-Experts Layer" §3; Fedus Zoph Shazeer 2022 "Switch Transformer" §2.2',
    prompt_text: 'Mixture-of-experts top-k gating: given gate_logits = [1.2, 0.5, 2.1, 0.3] and top_k = 2, return the top-2 expert indices sorted by score descending (largest first). Print as a JSON array.',
    exec_cell: {
      language: 'node',
      code: 'const logits=[1.2,0.5,2.1,0.3]; const k=2; const idx=logits.map((v,i)=>({v,i})).sort((a,b)=>b.v-a.v).slice(0,k).map(o=>o.i); console.log(JSON.stringify(idx));',
      expected_stdout_hash: '292ab8f540e50d4e8a98ba17360a8176a193a0af9a6b968ced26b449cc200e81',
      timeout_ms: DEFAULT_TIMEOUT_MS,
    },
    k_threshold: 1,
    candidate_responses: [
      { id: 'c1', expected_pass: true,
        text: 'CORRECT: uses Array.prototype.keys() + sort by gate[idx] descending, slice top_k.',
        code: 'const gate=[1.2,0.5,2.1,0.3]; const top_k=2; const ranked=[...gate.keys()].sort((a,b)=>gate[b]-gate[a]).slice(0,top_k); console.log(JSON.stringify(ranked));',
        features_hit_truth: ['exec_pass'] },
      { id: 'c2', expected_pass: false,
        text: 'WRONG: sorts ascending (bottom-k) instead of descending (top-k).',
        code: 'const logits=[1.2,0.5,2.1,0.3]; const idx=logits.map((v,i)=>({v,i})).sort((a,b)=>a.v-b.v).slice(0,2).map(o=>o.i); console.log(JSON.stringify(idx));',
        features_hit_truth: [] },
      { id: 'c3', expected_pass: false,
        text: 'CARGO-CULT: gate_logits / top_k / sort descending — but returns the top-k SCORES not their indices.',
        code: 'const gate_logits=[1.2,0.5,2.1,0.3]; const top_k=2; const top_scores=gate_logits.slice().sort((a,b)=>b-a).slice(0,top_k); console.log(JSON.stringify(top_scores));',
        features_hit_truth: [] },
    ],
  },
  {
    id: 'llm-systems-017',
    source_anchor: 'Leviathan Kalman Matias 2023 "Fast Inference from Transformers via Speculative Decoding" §3.2 (acceptance rule); Chen et al. 2023 "Accelerating Large Language Model Decoding with Speculative Sampling"',
    prompt_text: 'Speculative decoding acceptance per Leviathan rule: accept the draft token iff uniform_sample < min(1, exp(target_logp - draft_logp)). Given draft_logp = -1.5, target_logp = -0.7, uniform_sample = 0.4, print the boolean accept verdict.',
    exec_cell: {
      language: 'node',
      code: 'const dlp=-1.5,tlp=-0.7,u=0.4; const ratio=Math.exp(tlp-dlp); const accept=u<Math.min(1,ratio); console.log(accept);',
      expected_stdout_hash: 'a17fcf0a2f50e2d495e4f90ce263410edc183add6c62699a2facbccf60410f74',
      timeout_ms: DEFAULT_TIMEOUT_MS,
    },
    k_threshold: 1,
    candidate_responses: [
      { id: 'c1', expected_pass: true,
        text: 'CORRECT: same accept rule expressed with descriptive identifiers (draft_logp, target_logp, uniform).',
        code: 'const draft_logp=-1.5,target_logp=-0.7,uniform=0.4; const accept_ratio=Math.min(1.0, Math.exp(target_logp - draft_logp)); console.log(uniform < accept_ratio);',
        features_hit_truth: ['exec_pass'] },
      { id: 'c2', expected_pass: false,
        text: 'WRONG: computes reject probability (1 - min(1, exp(t-d))) and compares to u; reject path returns false here.',
        code: 'const dlp=-1.5,tlp=-0.7,u=0.4; const reject_prob=1-Math.min(1,Math.exp(tlp-dlp)); console.log(u<reject_prob);',
        features_hit_truth: [] },
      { id: 'c3', expected_pass: false,
        text: 'CARGO-CULT: speculative / accept / Math.min / exp(target-draft) all named; but compares u to log_ratio = min(0, tlp-dlp) instead of the linear ratio.',
        code: 'const dlp=-1.5,tlp=-0.7,u=0.4; const log_ratio=Math.min(0, tlp-dlp); console.log(u<log_ratio);',
        features_hit_truth: [] },
    ],
  },
  {
    id: 'llm-systems-018',
    source_anchor: 'Su et al. 2023 "RoFormer: Enhanced Transformer with Rotary Position Embedding" §2.2 (rotation matrix block form); arXiv:2104.09864 Equation 14',
    prompt_text: 'Rotary position embedding 2x2 rotation block for the first dim pair (dim_idx=0): given pos=2, d=4, base=10000, theta_0 = pos / base^(2*0/d) = 2, and the block is [[cos(theta_0), -sin(theta_0)], [sin(theta_0), cos(theta_0)]]. Print the four entries [m00, m01, m10, m11] each to 6 decimal places as a JSON array.',
    exec_cell: {
      language: 'node',
      code: 'const pos=2,d=4,base=10000; const theta=pos/Math.pow(base,0/d); const c=Math.cos(theta),s=Math.sin(theta); const block=[c,-s,s,c].map(x=>x.toFixed(6)); console.log(JSON.stringify(block));',
      expected_stdout_hash: '2c5af2a65ad84bdf0d995c84f18807417618831b3f63ef8e642f8e9ec99f02b7',
      timeout_ms: DEFAULT_TIMEOUT_MS,
    },
    k_threshold: 1,
    candidate_responses: [
      { id: 'c1', expected_pass: true,
        text: 'CORRECT: builds the 2x2 rotation matrix as nested array, flattens with .flat(), formats per entry.',
        code: 'const m=2; const theta_0=m; const cos_t=Math.cos(theta_0), sin_t=Math.sin(theta_0); const R=[[cos_t,-sin_t],[sin_t,cos_t]]; const flat=R.flat().map(x=>x.toFixed(6)); console.log(JSON.stringify(flat));',
        features_hit_truth: ['exec_pass'] },
      { id: 'c2', expected_pass: false,
        text: 'WRONG: transposes the rotation block (m01 and m10 swap signs).',
        code: 'const pos=2,d=4,base=10000; const theta=pos/Math.pow(base,0/d); const c=Math.cos(theta),s=Math.sin(theta); console.log(JSON.stringify([c,s,-s,c].map(x=>x.toFixed(6))));',
        features_hit_truth: [] },
      { id: 'c3', expected_pass: false,
        text: 'CARGO-CULT: theta_0 / Math.cos / Math.sin / base / pow vocabulary, but converts theta from degrees to radians via *PI/180 — wrong unit conversion.',
        code: 'const pos=2,d=4,base=10000; const theta_rad_or_deg=pos/Math.pow(base,0/d); const t=theta_rad_or_deg*Math.PI/180; const c=Math.cos(t),s=Math.sin(t); console.log(JSON.stringify([c,-s,s,c].map(x=>x.toFixed(6))));',
        features_hit_truth: [] },
    ],
  },
  {
    id: 'llm-systems-019',
    source_anchor: 'Dao et al. 2022 "FlashAttention: Fast and Memory-Efficient Exact Attention with IO-Awareness" §3.1 (HBM IO complexity); arXiv:2205.14135',
    prompt_text: 'FlashAttention HBM access ratio vs vanilla attention: vanilla reads/writes ~4 * seq_len^2 * head_dim HBM bytes. Tiled FlashAttention reads (seq_len * head_dim + head_dim * block_size) per outer tile across (seq_len / block_size) tiles. Given seq_len=1024, head_dim=64, block_size=256, print the ratio flash/vanilla to 6 decimal places.',
    exec_cell: {
      language: 'node',
      code: 'const seq=1024,dim=64,blk=256; const vanilla=4*seq*seq*dim; const flash=(seq*dim+dim*blk)*(seq/blk); const ratio=flash/vanilla; console.log(ratio.toFixed(6));',
      expected_stdout_hash: '0e4744b67dbe6f7ca923584f538a83be633ffdd3e1d0fc3177aca8b2267b6076',
      timeout_ms: DEFAULT_TIMEOUT_MS,
    },
    k_threshold: 1,
    candidate_responses: [
      { id: 'c1', expected_pass: true,
        text: 'CORRECT: alternate naming (N/d/B, hbm_vanilla, hbm_flash, tiles) — same arithmetic.',
        code: 'const N=1024,d=64,B=256; const hbm_vanilla=4*N*N*d; const tiles=N/B; const hbm_flash=(N*d+d*B)*tiles; console.log((hbm_flash/hbm_vanilla).toFixed(6));',
        features_hit_truth: ['exec_pass'] },
      { id: 'c2', expected_pass: false,
        text: 'WRONG: drops the 4x prefactor on vanilla HBM bytes; the ratio comes out 4x larger.',
        code: 'const seq=1024,dim=64,blk=256; const vanilla=seq*seq*dim; const flash=(seq*dim+dim*blk)*(seq/blk); console.log((flash/vanilla).toFixed(6));',
        features_hit_truth: [] },
      { id: 'c3', expected_pass: false,
        text: 'CARGO-CULT: seq_len / head_dim / block_size / HBM / tiles vocabulary, but builds HBM_flash by ADDING the per-tile parts and the tile count, not multiplying.',
        code: 'const seq_len=1024,head_dim=64,block_size=256; const HBM_vanilla=4*seq_len*seq_len*head_dim; const tiles=seq_len/block_size; const HBM_flash=(seq_len*head_dim)+(head_dim*block_size)+tiles; const ratio=HBM_flash/HBM_vanilla; console.log(ratio.toFixed(6));',
        features_hit_truth: [] },
    ],
  },
  {
    id: 'llm-systems-020',
    source_anchor: 'Hoffmann et al. 2022 "Training Compute-Optimal Large Language Models" (Chinchilla) §3 + Eq. 4; arXiv:2203.15556',
    prompt_text: 'Chinchilla compute-optimal model size: under the simplified relation N_opt = sqrt(C / 6), where C is total training compute in FLOPs and 6 is the FLOPs-per-parameter-token constant from Kaplan/Hoffmann. For C = 6e21 FLOPs, print N_opt as scientific notation to 4-decimal mantissa precision (e.g. via toExponential(4)).',
    exec_cell: {
      language: 'node',
      code: 'const C=6e21; const N=Math.pow(C/6,0.5); console.log(N.toExponential(4));',
      expected_stdout_hash: 'abcce34156ad0d77dbdf531a04b4f323efb44fa401fb3595272f236f09467af7',
      timeout_ms: DEFAULT_TIMEOUT_MS,
    },
    k_threshold: 1,
    candidate_responses: [
      { id: 'c1', expected_pass: true,
        text: 'CORRECT: names the FLOPs-per-param-token constant flops_per_param_token, uses Math.sqrt.',
        code: 'const compute=6e21; const flops_per_param_token=6; const N_opt=Math.sqrt(compute/flops_per_param_token); console.log(N_opt.toExponential(4));',
        features_hit_truth: ['exec_pass'] },
      { id: 'c2', expected_pass: false,
        text: 'WRONG: drops the divide-by-6 (the FLOPs/parameter/token constant) and sqrts the raw compute.',
        code: 'const C=6e21; const N=Math.sqrt(C); console.log(N.toExponential(4));',
        features_hit_truth: [] },
      { id: 'c3', expected_pass: false,
        text: 'CARGO-CULT: Chinchilla / flops_per_param_token / N_opt / Math.pow / toExponential present, but takes the CUBE root instead of the square root.',
        code: 'const C=6e21; const flops_per_param_token=6; const N_opt=Math.pow(C/flops_per_param_token, 1/3); console.log(N_opt.toExponential(4));',
        features_hit_truth: [] },
    ],
  },
];

function _sealItem(seed) {
  // Sanity: hash the literal prompt + code so drift detection picks up edits to
  // either (matching the philosophy seeder pattern of binding fingerprint to
  // semantic content, not just expected_stdout_hash).
  const promptHash = sealed.lockAnswerKey(seed.prompt_text || `${seed.id}-no-prompt`).sealed_hash;
  const codeHash = sealed.lockAnswerKey(seed.exec_cell.code).sealed_hash;
  return {
    id: seed.id,
    topic: TOPIC,
    lifecycle: 'draft',
    source_anchor: seed.source_anchor,
    prompt_text: seed.prompt_text,
    verification_channel: 'code',
    schema_version: SCHEMA_VERSION,
    exec_cell: {
      language: seed.exec_cell.language,
      code: seed.exec_cell.code,
      expected_stdout_hash: seed.exec_cell.expected_stdout_hash,
      timeout_ms: seed.exec_cell.timeout_ms || DEFAULT_TIMEOUT_MS,
    },
    k_threshold: seed.k_threshold,
    candidate_responses: seed.candidate_responses,
    sealed_at: new Date().toISOString(),
    sealed_algorithm: 'sha256',
    sealed_normalization: 'raw_stdout (no rstrip; matches exec-cell.js behavior)',
    prompt_hash: promptHash,
    code_hash: codeHash,
    notes: 'D20-pivot schema (exec-cell channel). Pass = (exit_code===0) AND sha256(stdout)===expected_stdout_hash. Each candidate_response carries {id, text (prose), code (executable JS), expected_pass (author-declared boolean), features_hit_truth (kept for backward compat; unused by exec-channel auto-judge)}. Rater sidecars not required for code channel — ground truth is candidate.expected_pass, predicted is exec-cell hash match. See app/scripts/run-eval-exec-channel.js.',
  };
}

// V0.5 E0 PIVOT (2026-05-11): seed-time validation. Every candidate's authored
// expected_pass MUST agree with the auto-judge's predicted_pass under the
// reference hash. Catches authoring drift (eg cargo-cult code that accidentally
// produces the right output) before the JSON ever lands on disk.
async function _preValidateCandidates(items) {
  const failures = [];
  for (const seed of items) {
    const refHash = seed.exec_cell.expected_stdout_hash;
    // Run the reference to assert the committed hash is still valid for this Node version.
    const refResult = await execCell.runCell(seed.exec_cell.code, { timeoutMs: seed.exec_cell.timeout_ms || DEFAULT_TIMEOUT_MS });
    if (!refResult.pass || refResult.stdout_hash !== refHash) {
      failures.push({
        id: seed.id,
        kind: 'reference-mismatch',
        expected: refHash,
        actual: refResult.stdout_hash,
        stderr: (refResult.stderr_excerpt || '').slice(0, 200),
      });
      continue;
    }
    for (const cand of seed.candidate_responses || []) {
      if (typeof cand.code !== 'string' || typeof cand.expected_pass !== 'boolean') {
        failures.push({ id: seed.id, candidate: cand.id, kind: 'schema-missing-code-or-expected_pass' });
        continue;
      }
      const r = await execCell.runCell(cand.code, { timeoutMs: seed.exec_cell.timeout_ms || DEFAULT_TIMEOUT_MS });
      const predicted = r.pass && r.stdout_hash === refHash;
      if (predicted !== cand.expected_pass) {
        failures.push({
          id: seed.id,
          candidate: cand.id,
          kind: 'expected_pass-mismatch',
          expected: cand.expected_pass,
          predicted,
          actual_hash: r.stdout_hash,
          stderr: (r.stderr_excerpt || '').slice(0, 200),
        });
      }
    }
  }
  return failures;
}

// Drift fingerprint binds each item to its prompt text, code text, AND the
// committed expected_stdout_hash. Any of the three changing without
// --force-reseal triggers a warning (and exit 1) so silent edits do not slip
// through. Mirrors the philosophy seeder's _itemFingerprint (claim_hash +
// phrasing_hashes), adapted to this channel's content.
function _itemFingerprint(item) {
  const parts = [];
  parts.push(item.prompt_hash || '');
  parts.push(item.code_hash || '');
  parts.push((item.exec_cell && item.exec_cell.expected_stdout_hash) || '');
  return parts.join('|');
}

async function main(argv) {
  argv = argv || process.argv;
  const forceReseal = argv.includes('--force-reseal');
  const checkDrift = argv.includes('--check-drift');
  const skipValidate = argv.includes('--skip-validate');

  if (!fs.existsSync(TARGET_DIR)) {
    fs.mkdirSync(TARGET_DIR, { recursive: true });
  }

  // Pre-seed validation: refuse to write any item if its reference or any
  // candidate disagrees with the auto-judge under the committed expected_stdout_hash.
  // --skip-validate exists only for the philosophy seeder rebase; do not use in production.
  if (!skipValidate && !checkDrift) {
    const validationFailures = await _preValidateCandidates(ITEMS);
    if (validationFailures.length > 0) {
      console.error(`[seed-llm-systems] FAIL: ${validationFailures.length} validation failure(s); NOT WRITING:`);
      for (const f of validationFailures) console.error('  ', JSON.stringify(f));
      process.exit(2);
    }
    console.log(`[seed-llm-systems] pre-seed validation OK: ${ITEMS.length} items x ${ITEMS.reduce((a, s) => a + (s.candidate_responses || []).length, 0)} candidates`);
  }

  let written = 0;
  let skipped = 0;
  let drifted = 0;

  for (const seed of ITEMS) {
    const filePath = path.join(TARGET_DIR, `${seed.id}.json`);
    const candidate = _sealItem(seed);
    const candidateFingerprint = _itemFingerprint(candidate);

    if (fs.existsSync(filePath)) {
      let existing = null;
      try { existing = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_e) { /* fall through to overwrite */ }

      const existingFingerprint = existing
        ? [existing.prompt_hash || '', existing.code_hash || '', (existing.exec_cell && existing.exec_cell.expected_stdout_hash) || ''].join('|')
        : null;

      const drift = existingFingerprint !== candidateFingerprint;

      if (checkDrift) {
        if (drift) {
          console.warn(`[seed-llm-systems] DRIFT: ${seed.id} prompt/code/expected hash changed since seal. existing=${(existingFingerprint || '').slice(0, 48)}... candidate=${candidateFingerprint.slice(0, 48)}...`);
          drifted++;
        }
        continue;
      }

      if (!forceReseal) {
        if (drift) {
          console.warn(`[seed-llm-systems] WARN: ${seed.id} drifted but --force-reseal not set; SKIPPING. Re-run with --force-reseal to update.`);
          drifted++;
        } else {
          skipped++;
        }
        continue;
      }
    }

    fs.writeFileSync(filePath, JSON.stringify(candidate, null, 2) + '\n', 'utf8');
    written++;
  }

  console.log(`[seed-llm-systems] wrote ${written} item(s), skipped ${skipped} unchanged, ${drifted} drifted`);
  console.log(`[seed-llm-systems] dir: ${TARGET_DIR}`);
  if (drifted > 0 && !forceReseal && !checkDrift) {
    console.warn(`[seed-llm-systems] ${drifted} item(s) drifted. Re-run with --force-reseal to apply changes.`);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(err => { console.error('[seed-llm-systems] fatal:', err); process.exit(3); });
}

module.exports = { ITEMS, main, _sealItem, _itemFingerprint, _preValidateCandidates, TOPIC, SCHEMA_VERSION };
