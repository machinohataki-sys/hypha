// V0.5 E1 — basic-algorithms golden item seeder (verification_channel = 'code')
//
// Second exec-cell domain for the E1 trigger-replacement mutation-test work.
// Mirrors seed-llm-systems-golden.js exactly: schema, fingerprint, atomic
// writer, --force-reseal / --check-drift flags, and seed-time validation.
//
// Items are deliberately simple, deterministic, well-known algorithms (string
// reverse, sort, max, count, fib, binary-search, hashmap, two-sum, palindrome,
// digit-sum). Each item carries 3 candidate_responses authored by hand:
//   c1: CORRECT alternate implementation (expected_pass=true)
//   c2: WRONG buggy logic                (expected_pass=false)
//   c3: CARGO-CULT plausible vocabulary   (expected_pass=false)
//
// Run:
//   node app/scripts/seed-basic-algorithms-golden.js                # create new only
//   node app/scripts/seed-basic-algorithms-golden.js --force-reseal # regenerate all
//   node app/scripts/seed-basic-algorithms-golden.js --check-drift  # warn if existing != current
//
// Created 2026-05-11 on v0.5-substrate (V0.5 E1 second exec-cell domain).

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sealed = require('../lib/evaluator/verification-channels/sealed-rubric');
const execCell = require('../lib/evaluator/verification-channels/exec-cell');

const TARGET_DIR = path.join(__dirname, '..', '..', 'vault', '.evaluator', 'golden', 'basic-algorithms');
const TOPIC = 'basic-algorithms';
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
// the raw stdout (including trailing newline). Authors rerunning with
// --force-reseal that mutate `code` MUST recompute the hash; _preValidateCandidates
// guards by re-executing the reference at seed time.

const ITEMS = [
  {
    id: 'basic-algorithms-001',
    source_anchor: 'MDN String.prototype.split / Array.prototype.reverse / Array.prototype.join (developer.mozilla.org); CLRS §1.1 basic string operations',
    prompt_text: 'Reverse the string "hello" and print the result on stdout. Expected output: "olleh".',
    exec_cell: {
      language: 'node',
      code: 'const s="hello"; let r=""; for(let i=s.length-1;i>=0;i--){r+=s[i];} console.log(r);',
      expected_stdout_hash: 'b82485b383d706f0275c0c6ee8de62554458ec207cbf736b93c2c560ccc3a8fa',
      timeout_ms: DEFAULT_TIMEOUT_MS,
    },
    k_threshold: 1,
    candidate_responses: [
      { id: 'c1', expected_pass: true,
        text: 'CORRECT: idiomatic split-reverse-join pipeline producing the same reversed string.',
        code: 'const input="hello"; const out=input.split("").reverse().join(""); console.log(out);',
        features_hit_truth: ['exec_pass'] },
      { id: 'c2', expected_pass: false,
        text: 'WRONG: off-by-one — loop starts at i=s.length (one past the end) so the first concatenation reads s[s.length] = undefined.',
        code: 'const s="hello"; let r=""; for(let i=s.length;i>0;i--){r+=s[i];} console.log(r);',
        features_hit_truth: [] },
      { id: 'c3', expected_pass: false,
        text: 'CARGO-CULT: uses split/join vocabulary and a variable named "reversed", but never actually calls .reverse() so the original order survives.',
        code: 'const input="hello"; const chars=input.split(""); const reversed=chars; console.log(reversed.join(""));',
        features_hit_truth: [] },
    ],
  },
  {
    id: 'basic-algorithms-002',
    source_anchor: 'CLRS §2.1 insertion sort / §2.3 merge sort (general comparison-sort correctness); MDN Array.prototype.sort numeric comparator',
    prompt_text: 'Sort the array [3, 1, 4, 1, 5, 9, 2, 6] in ascending numeric order and print it as JSON. Expected output: "[1,1,2,3,4,5,6,9]".',
    exec_cell: {
      language: 'node',
      code: 'const a=[3,1,4,1,5,9,2,6]; a.sort((x,y)=>x-y); console.log(JSON.stringify(a));',
      expected_stdout_hash: 'b31b75771c282234588a38e9b4b2d4c1db40c0cde37a78dd61bf311a4026f053',
      timeout_ms: DEFAULT_TIMEOUT_MS,
    },
    k_threshold: 1,
    candidate_responses: [
      { id: 'c1', expected_pass: true,
        text: 'CORRECT: non-mutating spread-then-sort with the same (a,b)=>a-b comparator.',
        code: 'const arr=[3,1,4,1,5,9,2,6]; const sorted=[...arr].sort((a,b)=>a-b); console.log(JSON.stringify(sorted));',
        features_hit_truth: ['exec_pass'] },
      { id: 'c2', expected_pass: false,
        text: 'WRONG: single bubble-sort pass only swaps adjacent pairs once, leaving the array unsorted (a full bubble sort needs n-1 passes).',
        code: 'const a=[3,1,4,1,5,9,2,6]; for(let i=0;i<a.length-1;i++){if(a[i]>a[i+1]){const t=a[i]; a[i]=a[i+1]; a[i+1]=t;}} console.log(JSON.stringify(a));',
        features_hit_truth: [] },
      { id: 'c3', expected_pass: false,
        text: 'CARGO-CULT: uses sort with (a,b)=>... comparator and spread copy, but the comparator sign is flipped so the array sorts descending.',
        code: 'const arr=[3,1,4,1,5,9,2,6]; const sorted=[...arr].sort((a,b)=>b-a); console.log(JSON.stringify(sorted));',
        features_hit_truth: [] },
    ],
  },
  {
    id: 'basic-algorithms-003',
    source_anchor: 'CLRS §9.1 minimum and maximum (linear-time scan); MDN Math.max with spread operator',
    prompt_text: 'Find the maximum value in [4, 7, 2, 9, 1, 5] and print it. Expected output: "9".',
    exec_cell: {
      language: 'node',
      code: 'const a=[4,7,2,9,1,5]; let m=a[0]; for(let i=1;i<a.length;i++){if(a[i]>m)m=a[i];} console.log(m);',
      expected_stdout_hash: '2e6d31a5983a91251bfae5aefa1c0a19d8ba3cf601d0e8a706b4cfa9661a6b8a',
      timeout_ms: DEFAULT_TIMEOUT_MS,
    },
    k_threshold: 1,
    candidate_responses: [
      { id: 'c1', expected_pass: true,
        text: 'CORRECT: Math.max with spread — built-in equivalent of the linear scan.',
        code: 'const arr=[4,7,2,9,1,5]; console.log(Math.max(...arr));',
        features_hit_truth: ['exec_pass'] },
      { id: 'c2', expected_pass: false,
        text: 'WRONG: loop terminates at i<floor(length/2), only inspecting the first half — misses the 9 at index 3.',
        code: 'const a=[4,7,2,9,1,5]; let m=a[0]; for(let i=1;i<Math.floor(a.length/2);i++){if(a[i]>m)m=a[i];} console.log(m);',
        features_hit_truth: [] },
      { id: 'c3', expected_pass: false,
        text: 'CARGO-CULT: variable named "max", running scan structure intact, but the comparison is < instead of > so it tracks the minimum.',
        code: 'const arr=[4,7,2,9,1,5]; let max=arr[0]; for(let i=1;i<arr.length;i++){if(arr[i]<max)max=arr[i];} console.log(max);',
        features_hit_truth: [] },
    ],
  },
  {
    id: 'basic-algorithms-004',
    source_anchor: 'MDN String.prototype.split / for...of iteration; CLRS §32.1 naive substring counting',
    prompt_text: 'Count how many times the character "a" appears in the string "banana" and print the integer. Expected output: "3".',
    exec_cell: {
      language: 'node',
      code: 'const s="banana"; const ch="a"; let c=0; for(const x of s){if(x===ch)c++;} console.log(c);',
      expected_stdout_hash: '1121cfccd5913f0a63fec40a6ffd44ea64f9dc135c66634ba001d10bcf4302a2',
      timeout_ms: DEFAULT_TIMEOUT_MS,
    },
    k_threshold: 1,
    candidate_responses: [
      { id: 'c1', expected_pass: true,
        text: 'CORRECT: split-and-count idiom — text.split(target).length - 1 gives the same count.',
        code: 'const text="banana"; const target="a"; const count=text.split(target).length-1; console.log(count);',
        features_hit_truth: ['exec_pass'] },
      { id: 'c2', expected_pass: false,
        text: 'WRONG: loop bound is i<s.length-1, skipping the last character — misses the final "a" in "banana".',
        code: 'const s="banana"; const ch="a"; let c=0; for(let i=0;i<s.length-1;i++){if(s[i]===ch)c++;} console.log(c);',
        features_hit_truth: [] },
      { id: 'c3', expected_pass: false,
        text: 'CARGO-CULT: variable named "occurrences" but uses indexOf which returns the FIRST index, not the count.',
        code: 'const text="banana"; const target="a"; const occurrences=text.indexOf(target); console.log(occurrences);',
        features_hit_truth: [] },
    ],
  },
  {
    id: 'basic-algorithms-005',
    source_anchor: 'CLRS §30 (Fibonacci recurrence F(0)=0, F(1)=1, F(n)=F(n-1)+F(n-2)); standard textbook iterative DP form',
    prompt_text: 'Compute the 10th Fibonacci number with the convention F(0)=0, F(1)=1. Print F(10). Expected output: "55".',
    exec_cell: {
      language: 'node',
      code: 'function fib(n){if(n<2)return n; let a=0,b=1; for(let i=2;i<=n;i++){const t=a+b; a=b; b=t;} return b;} console.log(fib(10));',
      expected_stdout_hash: '4c82a221b575ce7fe118b2e8cdf0764bf4ef570a3017e80b6d3438af9095f376',
      timeout_ms: DEFAULT_TIMEOUT_MS,
    },
    k_threshold: 1,
    candidate_responses: [
      { id: 'c1', expected_pass: true,
        text: 'CORRECT: tree-recursive form with the same F(0)=0, F(1)=1 base case.',
        code: 'function fib(n){if(n<2)return n; return fib(n-1)+fib(n-2);} console.log(fib(10));',
        features_hit_truth: ['exec_pass'] },
      { id: 'c2', expected_pass: false,
        text: 'WRONG: shifts the base case so F(0)=1, F(1)=1 — every value is offset by one position, producing F(11)=89 in place of F(10)=55.',
        code: 'function fib(n){if(n<=1)return 1; let a=1,b=1; for(let i=2;i<=n;i++){const t=a+b; a=b; b=t;} return b;} console.log(fib(10));',
        features_hit_truth: [] },
      { id: 'c3', expected_pass: false,
        text: 'CARGO-CULT: prev/curr identifiers and accumulator-over-loop form, but never updates prev — curr=prev+curr just sums into itself.',
        code: 'function fibonacci(n){let prev=0,curr=1; for(let i=0;i<n;i++){curr=prev+curr;} return curr;} console.log(fibonacci(10));',
        features_hit_truth: [] },
    ],
  },
  {
    id: 'basic-algorithms-006',
    source_anchor: 'CLRS §2.3.2 binary search; Bentley "Programming Pearls" §4 (binary search variants); MDN Array index semantics',
    prompt_text: 'Binary-search for target 7 in the sorted array [1, 3, 5, 7, 9, 11] and print the 0-based index. Expected output: "3".',
    exec_cell: {
      language: 'node',
      code: 'function bs(a,t){let lo=0,hi=a.length-1; while(lo<=hi){const m=(lo+hi)>>1; if(a[m]===t)return m; if(a[m]<t)lo=m+1; else hi=m-1;} return -1;} console.log(bs([1,3,5,7,9,11],7));',
      expected_stdout_hash: '1121cfccd5913f0a63fec40a6ffd44ea64f9dc135c66634ba001d10bcf4302a2',
      timeout_ms: DEFAULT_TIMEOUT_MS,
    },
    k_threshold: 1,
    candidate_responses: [
      { id: 'c1', expected_pass: true,
        text: 'CORRECT: standard inclusive-range binary search using Math.floor and the [lo, hi] invariant.',
        code: 'function binarySearch(arr,target){let left=0,right=arr.length-1; while(left<=right){const mid=Math.floor((left+right)/2); if(arr[mid]===target)return mid; else if(arr[mid]<target)left=mid+1; else right=mid-1;} return -1;} console.log(binarySearch([1,3,5,7,9,11],7));',
        features_hit_truth: ['exec_pass'] },
      { id: 'c2', expected_pass: false,
        text: 'WRONG: loop guard is lo<hi (strict) on an inclusive-range search — terminates one step early when target sits at the boundary, returning -1.',
        code: 'function bs(a,t){let lo=0,hi=a.length-1; while(lo<hi){const m=(lo+hi)>>1; if(a[m]===t)return m; if(a[m]<t)lo=m+1; else hi=m-1;} return -1;} console.log(bs([1,3,5,7,9,11],7));',
        features_hit_truth: [] },
      { id: 'c3', expected_pass: false,
        text: 'CARGO-CULT: binary-search structure intact (lo/hi/mid/while), but on a hit returns arr[mid] (the VALUE, 7) instead of mid (the INDEX, 3).',
        code: 'function binarySearchIndex(arr,target){let left=0,right=arr.length-1; while(left<=right){const mid=Math.floor((left+right)/2); if(arr[mid]===target)return arr[mid]; if(arr[mid]<target)left=mid+1; else right=mid-1;} return -1;} console.log(binarySearchIndex([1,3,5,7,9,11],7));',
        features_hit_truth: [] },
    ],
  },
  {
    id: 'basic-algorithms-007',
    source_anchor: 'CLRS §11.1 direct-address tables / §11.2 hash tables; MDN Map.prototype.get/set; standard textbook hashmap chapter',
    prompt_text: 'Insert {a: 1, b: 2, c: 3} into a hashmap, then look up key "b" and print the value. Expected output: "2".',
    exec_cell: {
      language: 'node',
      code: 'const m=new Map(); m.set("a",1); m.set("b",2); m.set("c",3); console.log(m.get("b"));',
      expected_stdout_hash: '53c234e5e8472b6ac51c1ae1cab3fe06fad053beb8ebfd8977b010655bfdd3c3',
      timeout_ms: DEFAULT_TIMEOUT_MS,
    },
    k_threshold: 1,
    candidate_responses: [
      { id: 'c1', expected_pass: true,
        text: 'CORRECT: plain object as hashmap, bracket-notation lookup — same lookup result as Map.get("b").',
        code: 'const map={}; map.a=1; map.b=2; map.c=3; console.log(map["b"]);',
        features_hit_truth: ['exec_pass'] },
      { id: 'c2', expected_pass: false,
        text: 'WRONG: identical structure but looks up the wrong key ("a" instead of "b").',
        code: 'const m=new Map(); m.set("a",1); m.set("b",2); m.set("c",3); console.log(m.get("a"));',
        features_hit_truth: [] },
      { id: 'c3', expected_pass: false,
        text: 'CARGO-CULT: Map constructor, keys() spread, indexed access — but prints the KEY name "b" instead of the value 2.',
        code: 'const hashMap=new Map([["a",1],["b",2],["c",3]]); const keys=[...hashMap.keys()]; console.log(keys[1]);',
        features_hit_truth: [] },
    ],
  },
  {
    id: 'basic-algorithms-008',
    source_anchor: 'LeetCode #1 Two Sum (canonical formulation); CLRS §11.2 hashmap O(n) lookup pattern',
    prompt_text: 'Two-sum: find the pair of indices (i, j) with i<j such that nums[i] + nums[j] = target. For nums=[2, 7, 11, 15], target=9, print the index pair as JSON. Expected output: "[0,1]".',
    exec_cell: {
      language: 'node',
      code: 'function ts(n,t){const m=new Map(); for(let i=0;i<n.length;i++){const c=t-n[i]; if(m.has(c))return [m.get(c),i]; m.set(n[i],i);} return null;} console.log(JSON.stringify(ts([2,7,11,15],9)));',
      expected_stdout_hash: 'd028af93fee64c47d944eb3c6d46db80354f8ea89ad46e9c9d2c0f6d7964e76f',
      timeout_ms: DEFAULT_TIMEOUT_MS,
    },
    k_threshold: 1,
    candidate_responses: [
      { id: 'c1', expected_pass: true,
        text: 'CORRECT: brute-force double loop returning [i,j] with i<j — slower but equivalent on this input.',
        code: 'function twoSum(nums,target){for(let i=0;i<nums.length;i++){for(let j=i+1;j<nums.length;j++){if(nums[i]+nums[j]===target)return [i,j];}} return null;} console.log(JSON.stringify(twoSum([2,7,11,15],9)));',
        features_hit_truth: ['exec_pass'] },
      { id: 'c2', expected_pass: false,
        text: 'WRONG: hashmap pattern correct but returns [i, m.get(c)] — swaps the order so the earlier index appears second.',
        code: 'function ts(n,t){const m=new Map(); for(let i=0;i<n.length;i++){const c=t-n[i]; if(m.has(c))return [i,m.get(c)]; m.set(n[i],i);} return null;} console.log(JSON.stringify(ts([2,7,11,15],9)));',
        features_hit_truth: [] },
      { id: 'c3', expected_pass: false,
        text: 'CARGO-CULT: target / complement / includes vocabulary, but returns the matching VALUES [nums[i], complement] instead of the index pair.',
        code: 'function twoSumPair(nums,target){for(let i=0;i<nums.length;i++){const complement=target-nums[i]; if(nums.includes(complement))return [nums[i],complement];} return null;} console.log(JSON.stringify(twoSumPair([2,7,11,15],9)));',
        features_hit_truth: [] },
    ],
  },
  {
    id: 'basic-algorithms-009',
    source_anchor: 'CLRS §32 string matching (palindrome as classic two-pointer exercise); standard interview canon (LeetCode #125)',
    prompt_text: 'Determine whether the string "racecar" is a palindrome and print the boolean. Expected output: "true".',
    exec_cell: {
      language: 'node',
      code: 'const s="racecar"; let p=true; for(let i=0;i<Math.floor(s.length/2);i++){if(s[i]!==s[s.length-1-i]){p=false; break;}} console.log(p);',
      expected_stdout_hash: 'a17fcf0a2f50e2d495e4f90ce263410edc183add6c62699a2facbccf60410f74',
      timeout_ms: DEFAULT_TIMEOUT_MS,
    },
    k_threshold: 1,
    candidate_responses: [
      { id: 'c1', expected_pass: true,
        text: 'CORRECT: reverse-and-compare idiom — equivalent to the two-pointer scan.',
        code: 'const s="racecar"; console.log(s===s.split("").reverse().join(""));',
        features_hit_truth: ['exec_pass'] },
      { id: 'c2', expected_pass: false,
        text: 'WRONG: index arithmetic is s[s.length-i] instead of s[s.length-1-i] — the first iteration reads s[7] (undefined) and concludes not-palindrome.',
        code: 'const s="racecar"; let p=true; for(let i=0;i<s.length;i++){if(s[i]!==s[s.length-i]){p=false; break;}} console.log(p);',
        features_hit_truth: [] },
      { id: 'c3', expected_pass: false,
        text: 'CARGO-CULT: split / every / palindrome vocabulary, but the predicate compares adjacent characters (s[i] vs s[i+1]) rather than mirrored ends.',
        code: 'const s="racecar"; const isPalindrome=s.split("").every((ch,i)=>s[i]===s[i+1]||i===s.length-1); console.log(isPalindrome);',
        features_hit_truth: [] },
    ],
  },
  {
    id: 'basic-algorithms-010',
    source_anchor: 'CLRS §31.1 elementary number-theory operations (digit extraction via mod and floor-divide); standard recreational math textbook',
    prompt_text: 'Sum the decimal digits of 12345 and print the total. Expected output: "15".',
    exec_cell: {
      language: 'node',
      code: 'let n=12345; let s=0; while(n>0){s+=n%10; n=Math.floor(n/10);} console.log(s);',
      expected_stdout_hash: '238903180cc104ec2c5d8b3f20c5bc61b389ec0a967df8cc208cdc7cd454174f',
      timeout_ms: DEFAULT_TIMEOUT_MS,
    },
    k_threshold: 1,
    candidate_responses: [
      { id: 'c1', expected_pass: true,
        text: 'CORRECT: string conversion + reduce — different idiom, same sum.',
        code: 'const num=12345; const sum=String(num).split("").reduce((a,d)=>a+Number(d),0); console.log(sum);',
        features_hit_truth: ['exec_pass'] },
      { id: 'c2', expected_pass: false,
        text: 'WRONG: loop guard n>=10 (instead of n>0) exits with one digit remaining — drops the leading "1" of 12345.',
        code: 'let n=12345; let s=0; while(n>=10){s+=n%10; n=Math.floor(n/10);} console.log(s);',
        features_hit_truth: [] },
      { id: 'c3', expected_pass: false,
        text: 'CARGO-CULT: digits / String / split vocabulary, but returns the COUNT of digits (length) instead of summing them.',
        code: 'const num=12345; const digits=String(num).split(""); const total=digits.length; console.log(total);',
        features_hit_truth: [] },
    ],
  },
];

function _sealItem(seed) {
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
    notes: 'D20-pivot schema (exec-cell channel). Pass = (exit_code===0) AND sha256(stdout)===expected_stdout_hash. Each candidate_response carries {id, text (prose), code (executable JS), expected_pass (author-declared boolean), features_hit_truth (kept for backward compat; unused by exec-channel auto-judge)}. Second exec-cell domain seeded for V0.5 E1 mutation-test cross-domain validation.',
  };
}

async function _preValidateCandidates(items) {
  const failures = [];
  for (const seed of items) {
    const refHash = seed.exec_cell.expected_stdout_hash;
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

  if (!skipValidate && !checkDrift) {
    const validationFailures = await _preValidateCandidates(ITEMS);
    if (validationFailures.length > 0) {
      console.error(`[seed-basic-algorithms] FAIL: ${validationFailures.length} validation failure(s); NOT WRITING:`);
      for (const f of validationFailures) console.error('  ', JSON.stringify(f));
      process.exit(2);
    }
    console.log(`[seed-basic-algorithms] pre-seed validation OK: ${ITEMS.length} items x ${ITEMS.reduce((a, s) => a + (s.candidate_responses || []).length, 0)} candidates`);
  }

  let written = 0;
  let skipped = 0;
  let drifted = 0;

  for (const seed of ITEMS) {
    const filePath = path.join(TARGET_DIR, `${seed.id}.json`);
    const tmpPath = `${filePath}.tmp`;
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
          console.warn(`[seed-basic-algorithms] DRIFT: ${seed.id} prompt/code/expected hash changed since seal. existing=${(existingFingerprint || '').slice(0, 48)}... candidate=${candidateFingerprint.slice(0, 48)}...`);
          drifted++;
        }
        continue;
      }

      if (!forceReseal) {
        if (drift) {
          console.warn(`[seed-basic-algorithms] WARN: ${seed.id} drifted but --force-reseal not set; SKIPPING. Re-run with --force-reseal to update.`);
          drifted++;
        } else {
          skipped++;
        }
        continue;
      }
    }

    // atomic write: tmp then rename
    fs.writeFileSync(tmpPath, JSON.stringify(candidate, null, 2) + '\n', 'utf8');
    fs.renameSync(tmpPath, filePath);
    written++;
  }

  console.log(`[seed-basic-algorithms] wrote ${written} item(s), skipped ${skipped} unchanged, ${drifted} drifted`);
  console.log(`[seed-basic-algorithms] dir: ${TARGET_DIR}`);
  if (drifted > 0 && !forceReseal && !checkDrift) {
    console.warn(`[seed-basic-algorithms] ${drifted} item(s) drifted. Re-run with --force-reseal to apply changes.`);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(err => { console.error('[seed-basic-algorithms] fatal:', err); process.exit(3); });
}

module.exports = { ITEMS, main, _sealItem, _itemFingerprint, _preValidateCandidates, TOPIC, SCHEMA_VERSION };
