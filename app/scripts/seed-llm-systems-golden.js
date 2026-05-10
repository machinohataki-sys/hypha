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

const TARGET_DIR = path.join(__dirname, '..', '..', 'vault', '.evaluator', 'golden', 'llm-systems');
const TOPIC = 'llm-systems';
const SCHEMA_VERSION = '0.5.D11';
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
      { id: 'c1', text: 'const B=2,T=8,H=4,D=64; const out=[B,T,H,D]; console.log(JSON.stringify(out));', features_hit_truth: ['exec_pass'] },
      { id: 'c2', text: 'console.log([2, 8, 4, 64]);', features_hit_truth: [] },
      { id: 'c3', text: 'console.log("[2,8,4,64]");', features_hit_truth: ['exec_pass'] },
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
      { id: 'c1', text: 'const seq=2048,heads=32,dim=128,bytes=2,layers=32; const total=2*seq*heads*dim*bytes*layers; console.log(total);', features_hit_truth: ['exec_pass'] },
      { id: 'c2', text: 'console.log(seq*heads*dim*bytes*layers);', features_hit_truth: [] },
      { id: 'c3', text: 'console.log(1073741824);', features_hit_truth: ['exec_pass'] },
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
      { id: 'c1', text: 'const pos=10,dim_idx=4,D=64,base=10000; console.log((pos/Math.pow(base,(2*dim_idx)/D)).toFixed(6));', features_hit_truth: ['exec_pass'] },
      { id: 'c2', text: 'console.log(10/10000);', features_hit_truth: [] },
      { id: 'c3', text: 'console.log("3.162278");', features_hit_truth: ['exec_pass'] },
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
      { id: 'c1', text: 'const x=[1,2,3,4]; const m=x.reduce((a,b)=>a+b)/x.length; const s=Math.sqrt(x.reduce((a,b)=>a+(b-m)**2,0)/x.length); console.log(JSON.stringify(x.map(xi=>((xi-m)/s).toFixed(4))));', features_hit_truth: ['exec_pass'] },
      { id: 'c2', text: 'console.log([1,2,3,4]);', features_hit_truth: [] },
      { id: 'c3', text: 'console.log("[\\"-1.3416\\",\\"-0.4472\\",\\"0.4472\\",\\"1.3416\\"]");', features_hit_truth: ['exec_pass'] },
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
      { id: 'c1', text: 'let s=12345; const r=()=>{s=(1103515245*s+12345)%2147483648;return s/2147483648;}; let sum=0; for(let i=0;i<20;i++){sum+=(r()<0.3?0:1);} console.log(sum);', features_hit_truth: ['exec_pass'] },
      { id: 'c2', text: 'console.log(20);', features_hit_truth: [] },
      { id: 'c3', text: 'console.log(16);', features_hit_truth: ['exec_pass'] },
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
      { id: 'c1', text: 'const L=[2.1,1.8,2.3,1.9,2.0]; const m=L.reduce((a,b)=>a+b)/L.length; console.log(Math.exp(m).toFixed(4));', features_hit_truth: ['exec_pass'] },
      { id: 'c2', text: 'console.log(2.02);', features_hit_truth: [] },
      { id: 'c3', text: 'console.log("7.5383");', features_hit_truth: ['exec_pass'] },
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
      { id: 'c1', text: "const t='the quick brown fox jumps over the lazy dog'; console.log((t.length/t.split(/\\s+/).length).toFixed(4));", features_hit_truth: ['exec_pass'] },
      { id: 'c2', text: 'console.log(5);', features_hit_truth: [] },
      { id: 'c3', text: 'console.log("4.7778");', features_hit_truth: ['exec_pass'] },
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
      { id: 'c1', text: 'const step=2000,w=1000,T=10000,peak=3e-4; const prog=(step-w)/(T-w); const lr=peak*0.5*(1+Math.cos(Math.PI*prog)); console.log(lr.toFixed(6));', features_hit_truth: ['exec_pass'] },
      { id: 'c2', text: 'console.log(3e-4);', features_hit_truth: [] },
      { id: 'c3', text: 'console.log("0.000291");', features_hit_truth: ['exec_pass'] },
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
      { id: 'c1', text: 'const L=32,k=4; console.log(((L/k+k)/L).toFixed(4));', features_hit_truth: ['exec_pass'] },
      { id: 'c2', text: 'console.log(0.25);', features_hit_truth: [] },
      { id: 'c3', text: 'console.log("0.3750");', features_hit_truth: ['exec_pass'] },
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
      { id: 'c1', text: 'const L=[1.2,3.4,0.5,2.8,3.1]; console.log(L.indexOf(Math.max(...L)));', features_hit_truth: ['exec_pass'] },
      { id: 'c2', text: 'console.log(0);', features_hit_truth: [] },
      { id: 'c3', text: 'console.log(1);', features_hit_truth: ['exec_pass'] },
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
    notes: 'D11 schema (exec-cell channel). Pass = (exit_code===0) AND sha256(stdout)===expected_stdout_hash. Author-rated candidate features_hit_truth retained for cross-check parity with sealed-rubric items, though feature_substring is not the verifier here. Rater sidecars optional for code channel (objective).',
  };
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

function main(argv) {
  argv = argv || process.argv;
  const forceReseal = argv.includes('--force-reseal');
  const checkDrift = argv.includes('--check-drift');

  if (!fs.existsSync(TARGET_DIR)) {
    fs.mkdirSync(TARGET_DIR, { recursive: true });
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

if (require.main === module) main();

module.exports = { ITEMS, main, _sealItem, _itemFingerprint, TOPIC, SCHEMA_VERSION };
