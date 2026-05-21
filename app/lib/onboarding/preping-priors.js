'use strict';
// HYPHA · Cold-start synthetic priors (S83 PREPING + S86 SimPersona, v1.0)
//
// Day-1 trough mitigation. Brand-new users have ! events history → !
// personalization signal → onboarding feels generic. PREPING (arXiv 2605.13880)
// pre-populates proposer-validator memory with hand-authored synthetic
// trajectories per archetype so Day-1 dispatch + lesson-0 framing already lean
// toward a plausible playbook.
//
// 4 user-cohort archetypes (distinct namespace from pedagogy-archetype which
// classifies lesson-content not learners):
//   engineer-mid       — 3-7 yr IC, ships features, time-boxed learning
//   engineer-senior    — 7+ yr staff/principal/founder-engineer, mentors, depth
//   pm                 — product manager, learns to talk-with-engineers
//   researcher         — academic / industrial researcher, paper-first
//
// Each archetype carries 20 hand-authored trajectories. Trajectories are
// PRIORS (synthetic prepares), ! predictions. Real events.jsonl supersedes
// once the user accumulates ≥5 lessons (see cohort-refiner.js).
//
// Surface contract:
//   ARCHETYPES                              → readonly array of 4 ids
//   getStarterPlaybook(archetype)           → { trajectories[], suggested_lesson_0, suggested_concepts[] }
//   listTrajectories(archetype)             → trajectories[] (shallow clone)
//   isKnownArchetype(id)                    → boolean
//
// Surgical scope (Lens 9): this file owns ONLY the priors data + read API.
// Classification rules live in persona-classifier.js. Refinement lives in
// cohort-refiner.js. ! cross-import.

const ARCHETYPES = Object.freeze([
  'engineer-mid',
  'engineer-senior',
  'pm',
  'researcher',
]);

// ---------------------------------------------------------------------------
// engineer-mid — 3-7yr IC. Time-boxed. Wants "ship this week" pragma.
// ---------------------------------------------------------------------------
const ENGINEER_MID_TRAJECTORIES = [
  { goal: 'transformer 数学吃透到能复述 attention 矩阵推导', expected_next_lessons: ['attention as soft kv-lookup', 'qkv projection geometry', 'multi-head as basis ensemble'], expected_concepts: ['softmax', 'dot-product', 'projection', 'gradient flow'], expected_questions: ['为什么 scale by sqrt(d_k)?', 'multi-head 真的学到不同子空间吗?'] },
  { goal: '能独立 debug 一个 prod LLM agent 的工具调用循环', expected_next_lessons: ['ReAct loop primitives', 'tool-call protocol JSON shape', 'observation truncation strategies'], expected_concepts: ['function calling', 'context window', 'tool schema', 'streaming'], expected_questions: ['工具返回 stale 数据怎么传染 agent?', '为什么 GPT-4 会死循环 retry?'] },
  { goal: '把当前后端从 Express 迁到 Fastify, 知道每个差异', expected_next_lessons: ['hooks vs middleware', 'schema-first validation', 'plugin encapsulation'], expected_concepts: ['lifecycle hooks', 'AJV', 'plugin scope', 'serializer'], expected_questions: ['onRequest 和 preHandler 实际什么时候跑?', 'schema 复用怎么共享?'] },
  { goal: '能给 junior 讲清 React 18 concurrent rendering 在解什么问题', expected_next_lessons: ['render phase vs commit', 'interruptible work', 'suspense as data primitive'], expected_concepts: ['scheduling', 'priority', 'transition', 'lane model'], expected_questions: ['startTransition 实际能省什么?', 'Suspense 跟 useEffect 顺序冲突吗?'] },
  { goal: 'PostgreSQL 索引 + 查询计划读懂, ! 只是 EXPLAIN ANALYZE 翻译', expected_next_lessons: ['B-tree internals', 'cost model assumptions', 'index-only scan conditions'], expected_concepts: ['selectivity', 'page', 'visibility map', 'planner stats'], expected_questions: ['为什么 PG 选 seq scan 而 ! 我的索引?', 'partial index 什么时候真正帮上忙?'] },
  { goal: 'Kubernetes 网络模型从 pod-to-pod 一路讲到 ingress', expected_next_lessons: ['CNI primitives', 'kube-proxy modes', 'service mesh sidecar pattern'], expected_concepts: ['veth pair', 'iptables', 'envoy', 'mTLS'], expected_questions: ['NodePort 和 LoadBalancer 网络路径区别?', 'iptables 规则在 1000 service 时性能?'] },
  { goal: '把 OAuth 2.1 + PKCE 流程吃透到能写白板', expected_next_lessons: ['auth code grant', 'PKCE challenge derivation', 'refresh rotation'], expected_concepts: ['client_id', 'code_verifier', 'token_endpoint', 'audience'], expected_questions: ['为什么 implicit flow 被废弃?', 'mobile app 怎么安全存 refresh token?'] },
  { goal: 'Rust ownership 直觉到能改 collegue 的 borrow-check 错误', expected_next_lessons: ['ownership rules', 'borrow regions (NLL)', 'lifetime elision'], expected_concepts: ['Copy vs Move', 'mutable reference', 'lifetime annotation', 'Drop'], expected_questions: ['为什么 `&mut self` 在一个 method 里只能 once?', 'Rc<RefCell<>> 什么时候算 anti-pattern?'] },
  { goal: 'WebSocket 真实 prod 部署 (心跳 + 重连 + 横扩)', expected_next_lessons: ['ping/pong frames', 'sticky session vs pub-sub fanout', 'redis stream backplane'], expected_concepts: ['heartbeat', 'backpressure', 'redis pubsub', 'load balancer L7'], expected_questions: ['nginx WebSocket 升级头怎么配?', '客户端突然掉线服务器多久察觉?'] },
  { goal: 'Docker 镜像层 + buildkit 缓存机制讲清', expected_next_lessons: ['layer graph', 'COPY cache invalidation', 'multi-stage targets'], expected_concepts: ['snapshot', 'mount type=cache', 'BUILDKIT_INLINE_CACHE', 'OCI manifest'], expected_questions: ['为什么 npm install 总 cache miss?', 'buildkit 跨机器 cache 怎么共享?'] },
  { goal: 'TypeScript 高级类型 (mapped + conditional) 看懂 zod 源码', expected_next_lessons: ['generic constraints', 'infer keyword', 'distributive conditional'], expected_concepts: ['keyof', 'mapped type', 'template literal', 'variance'], expected_questions: ['`infer` 在 conditional 里到底捕获什么?', '为什么 `T extends any ? ...` 会拆 union?'] },
  { goal: 'gRPC vs REST tradeoff 能跟 PM 一句话讲明', expected_next_lessons: ['protobuf wire format', 'streaming modes', 'gateway pattern'], expected_concepts: ['HTTP/2', 'codegen', 'reflection', 'deadline'], expected_questions: ['gRPC 在浏览器为什么要 gateway?', 'protobuf 字段重命名向后兼容吗?'] },
  { goal: 'Go context 包真正用对 (cancellation + value)', expected_next_lessons: ['context propagation', 'WithCancel vs WithTimeout', 'goroutine leak detection'], expected_concepts: ['done channel', 'context.Value', 'select', 'errgroup'], expected_questions: ['context.Value 为什么社区劝退?', 'cancel 没 defer 会泄漏吗?'] },
  { goal: 'CI/CD 加速: 把现在 12 分钟的 pipeline 砍到 4 分钟', expected_next_lessons: ['build cache layers', 'test parallelization', 'critical path analysis'], expected_concepts: ['DAG', 'caching key', 'shard', 'flaky test isolation'], expected_questions: ['哪段 critical path 最厚?', 'self-hosted runner 真值得吗?'] },
  { goal: 'GraphQL N+1 问题 + DataLoader 模式吃透', expected_next_lessons: ['resolver execution model', 'batch-then-cache', 'persisted queries'], expected_concepts: ['resolver tree', 'batch fn', 'cache key', 'query complexity'], expected_questions: ['DataLoader 跟 Redis cache 关系?', 'subscription 怎么避免 N+1?'] },
  { goal: 'Webpack vs Vite 真实差异 (! 只是 esbuild 快)', expected_next_lessons: ['bundling vs native ESM', 'HMR mechanics', 'tree-shaking edges'], expected_concepts: ['dependency graph', 'pre-bundle', 'side-effect flag', 'code splitting'], expected_questions: ['Vite prod build 用 rollup 为什么?', 'HMR 状态丢失怎么处理?'] },
  { goal: 'Redis 数据结构 (sorted set / stream) 实战场景', expected_next_lessons: ['ZADD use cases', 'XADD streams', 'consumer group semantics'], expected_concepts: ['skiplist', 'time-series', 'consumer group', 'PEL'], expected_questions: ['sorted set 比 sorted query 何时更好?', 'stream 比 list 优势?'] },
  { goal: '能写一个 toy compiler (lexer + parser + bytecode)', expected_next_lessons: ['tokenization patterns', 'recursive descent', 'stack-based VM'], expected_concepts: ['regex/DFA', 'AST', 'opcodes', 'symbol table'], expected_questions: ['为什么 parser combinator 简单但慢?', 'JIT 跟解释器界线在哪?'] },
  { goal: 'CSS 现代布局 (grid + container query) 跟 ! 上同事', expected_next_lessons: ['grid track sizing', 'subgrid', 'container queries'], expected_concepts: ['fr unit', 'auto-fit vs auto-fill', 'cqi/cqb', 'logical properties'], expected_questions: ['grid auto-flow dense 什么时候用?', 'container query 替代 media query 边界?'] },
  { goal: 'OAuth + JWT 自己写一遍 ! 用第三方', expected_next_lessons: ['HS256 vs RS256', 'token rotation', 'revocation strategies'], expected_concepts: ['claim', 'kid', 'jti', 'replay attack'], expected_questions: ['JWT 撤销真的不可能吗?', 'refresh token 该多长?'] },
];

// ---------------------------------------------------------------------------
// engineer-senior — 7+yr. Wants depth, history, second-order tradeoffs.
// ---------------------------------------------------------------------------
const ENGINEER_SENIOR_TRAJECTORIES = [
  { goal: '把 distributed consensus (Raft + Paxos + Viewstamped) 从历史顺序串起', expected_next_lessons: ['why Paxos was opaque', 'Raft leader election proof', 'VSR vs Raft differences'], expected_concepts: ['quorum', 'log replication', 'view change', 'commit invariant'], expected_questions: ['Lamport 跟 Liskov 的争议本质是什么?', 'multi-Paxos 实际工程为什么少见?'] },
  { goal: '能给团队讲清 CAP/PACELC 之外的现代一致性谱系', expected_next_lessons: ['linearizability vs sequential', 'snapshot isolation gaps', 'causal+'], expected_concepts: ['real-time order', 'CRDT', 'session guarantee', 'staleness bound'], expected_questions: ['serializable 真的够吗?', 'CockroachDB 选 serializable 代价?'] },
  { goal: '量子计算到能跟物理博士讨论 Shor 算法直觉', expected_next_lessons: ['qubit superposition', 'entanglement intuition', 'quantum Fourier transform'], expected_concepts: ['Bloch sphere', 'Hadamard', 'phase kickback', 'period finding'], expected_questions: ['Grover 加速来自哪个数学结构?', '为什么 BB84 安全 ! 靠加密?'] },
  { goal: '能从 first principles 推导 Bitcoin 的 51% 攻击成本曲线', expected_next_lessons: ['PoW economics', 'longest-chain rule', 'selfish mining'], expected_concepts: ['nonce', 'difficulty adjustment', 'fork', 'rational miner'], expected_questions: ['为什么 51% 攻击实际从未发生过?', 'PoS 经济学跟 PoW 第一性差异?'] },
  { goal: '编程语言类型系统从 Hindley-Milner 到 dependent types', expected_next_lessons: ['HM unification', 'rank-N polymorphism', 'GADTs', 'dependent types'], expected_concepts: ['unification', 'principal type', 'type witness', 'Curry-Howard'], expected_questions: ['为什么 Haskell ! 加 dependent types?', 'Idris/Lean 实际工程使用面?'] },
  { goal: '理解 LLM scaling laws 的数学根 + 政治后果', expected_next_lessons: ['Chinchilla compute-optimal', 'emergent abilities critique', 'data scarcity wall'], expected_concepts: ['compute budget', 'data efficiency', 'loss curve', 'parameter-token ratio'], expected_questions: ['Chinchilla 之后哪些 scaling law 失效?', 'emergent abilities 是 metric artifact 还是真现象?'] },
  { goal: '现代 GC (ZGC + Shenandoah + Generational ZGC) 设计取舍', expected_next_lessons: ['concurrent compaction', 'load barriers', 'colored pointers'], expected_concepts: ['tri-color invariant', 'read barrier', 'safepoint', 'pause time'], expected_questions: ['为什么 G1 被 ZGC 取代?', 'Go GC 为什么不分代?'] },
  { goal: '能 design review 一个 multi-region active-active 系统', expected_next_lessons: ['multi-master replication', 'conflict resolution', 'split-brain'], expected_concepts: ['vector clock', 'last-writer-wins', 'CRDT', 'quorum write'], expected_questions: ['active-active 失败案例的 root cause 类型?', 'CRDT 在哪些 schema 不适用?'] },
  { goal: 'Memory consistency models (TSO / RC11 / weak) 写出 litmus test', expected_next_lessons: ['SC vs TSO', 'release-acquire semantics', 'fence cost'], expected_concepts: ['happens-before', 'data race', 'fence', 'atomic'], expected_questions: ['ARM 比 x86 弱在哪?', 'C++ memory_order_relaxed 实际安全场景?'] },
  { goal: '能讲清 OS 内核的 page table 进化 (4 → 5 levels)', expected_next_lessons: ['virtual memory basics', 'huge pages tradeoff', 'TLB pressure'], expected_concepts: ['page walk', 'PCID', 'ASID', 'CR3'], expected_questions: ['5-level paging 实际省了什么?', 'transparent huge pages 何时反而慢?'] },
  { goal: '编译器优化 (SSA + alias analysis) 到能改 LLVM pass', expected_next_lessons: ['SSA construction', 'pointer analysis', 'loop optimizations'], expected_concepts: ['phi node', 'use-def chain', 'dominator tree', 'aliasing'], expected_questions: ['为什么 SSA 让 alias 简单?', 'Steensgaard 跟 Andersen 实际差距?'] },
  { goal: '从 statistical mechanics 视角理解 deep learning 泛化', expected_next_lessons: ['flat minima hypothesis', 'NTK regime', 'feature learning regime'], expected_concepts: ['loss landscape', 'phase transition', 'double descent', 'implicit bias'], expected_questions: ['double descent 是 SGD 工件还是真现象?', 'NTK 为什么 ! 解释真模型?'] },
  { goal: 'Cassandra/ScyllaDB 内部 (LSM + bloom + tombstone) 操作直觉', expected_next_lessons: ['LSM compaction strategies', 'tombstone GC grace', 'wide partition pitfalls'], expected_concepts: ['SSTable', 'memtable', 'bloom filter', 'compaction throughput'], expected_questions: ['size-tiered vs leveled 何时选哪个?', 'tombstone overload 怎么提前看见?'] },
  { goal: '能 mentor junior 走完一个 8 周 staff promo prep', expected_next_lessons: ['scope vs impact', 'cross-team narrative', 'principal-level signals'], expected_concepts: ['scope expansion', 'sponsorship', 'org leverage', 'tech vision doc'], expected_questions: ['code 之外 staff 必备啥?', '怎么从 senior 到 staff 跳跃 ! 卡住?'] },
  { goal: 'Networking deep dive: BGP + Anycast + DDoS 防护', expected_next_lessons: ['BGP origin/policy', 'anycast routing', 'scrubbing center pattern'], expected_concepts: ['AS path', 'route reflector', 'anycast', 'rate limit'], expected_questions: ['Cloudflare 怎么 sub-second 切换 anycast?', 'BGP hijack 怎么实时发现?'] },
  { goal: 'Database query optimizer 从 cost model 到 join reorder 算法', expected_next_lessons: ['selectivity estimation', 'dynamic programming join order', 'cardinality estimation'], expected_concepts: ['histogram', 'NDV', 'plan space', 'bushy plan'], expected_questions: ['为什么 cardinality estimation 永远难?', 'learned cost model 现状?'] },
  { goal: '能从 information theory 推导为什么 transformer 比 RNN 强', expected_next_lessons: ['sequence modeling capacity', 'attention as routing', 'expressiveness vs trainability'], expected_concepts: ['mutual information', 'gradient path length', 'positional encoding', 'inductive bias'], expected_questions: ['attention 真的解了 long-range 吗?', 'RNN 在哪些 task 仍胜?'] },
  { goal: '能写一篇有 first-principles 论点的 tech vision doc', expected_next_lessons: ['vision doc anatomy', 'evidence vs assertion', 'inverting frames'], expected_concepts: ['principle', 'hypothesis', 'objection map', 'counterfactual'], expected_questions: ['vision doc 跟 RFC 真区别?', 'staff+ 文档为什么很多 vague?'] },
  { goal: '储能 / 电网 / 大模型电力问题数量级算清', expected_next_lessons: ['W/H2 economics', 'grid frequency', 'data center PUE'], expected_concepts: ['LCOE', 'PUE', 'grid balancing', 'inertia'], expected_questions: ['训练 GPT-N 实际多少 MWh?', '为什么核电厂 ! 救 AI 数据中心?'] },
  { goal: '能从 Bell labs / Xerox PARC 历史推 ! 来的 systems thinking', expected_next_lessons: ['Unix philosophy origins', 'PARC integration vision', 'history-aware design'], expected_concepts: ['composability', 'orthogonality', 'integration vs orthogonality', 'systems thinking'], expected_questions: ['为什么 worse-is-better 赢了?', 'PARC vision 哪些今天才补上?'] },
];

// ---------------------------------------------------------------------------
// pm — product manager. Talks-with-engineers. 概念清 + 取舍 + ! 数学.
// ---------------------------------------------------------------------------
const PM_TRAJECTORIES = [
  { goal: '能跟 ML 团队讨论 LLM 选型 (闭源 vs 开源) ! 看 PPT', expected_next_lessons: ['闭源 vs 开源 cost 模型', '推理 latency 跟 UX 关系', '微调 vs RAG 选择'], expected_concepts: ['token cost', 'latency budget', 'context window', 'fine-tune ROI'], expected_questions: ['闭源模型涨价我怎么对冲?', '微调真的提升用户感知吗?'] },
  { goal: '能读懂 A/B 测试结果 ! 被工程师糊弄', expected_next_lessons: ['统计显著性直觉', '样本量计算', 'novelty effect'], expected_concepts: ['p-value', 'effect size', 'power', 'CUPED'], expected_questions: ['p<0.05 真的够吗?', '为什么 winner 上线后掉?'] },
  { goal: '理解 OAuth 流程能跟用户讲 "为什么要授权"', expected_next_lessons: ['OAuth 用户视角', 'consent screen 设计', 'token revoke UX'], expected_concepts: ['scope', 'consent', 'access', 'revoke'], expected_questions: ['为什么有的 app 要这么多权限?', '撤回授权用户实际怎么操作?'] },
  { goal: '能 brief engineer 一个搜索功能 ! 是 "做个搜索"', expected_next_lessons: ['搜索 ! 是字符串匹配', 'relevance vs recall', 'autocomplete 取舍'], expected_concepts: ['recall', 'precision', 'inverted index', 'click-through-rate'], expected_questions: ['为什么搜不到我刚发的内容?', 'autocomplete 跟搜索结果谁先?'] },
  { goal: '理解 mobile 性能预算 ! 让 dev 一个字解释', expected_next_lessons: ['启动时间分解', 'frame budget', 'battery 影响'], expected_concepts: ['cold start', '60fps', 'main thread', 'TTI'], expected_questions: ['启动慢用户真的不能忍吗?', '为什么 iOS 用户感觉更快?'] },
  { goal: '能讨论 data privacy / GDPR 后果 ! 只懂 "要 cookie banner"', expected_next_lessons: ['GDPR 数据流图', '同意 vs 合法基础', '删除权实操'], expected_concepts: ['controller', 'processor', 'lawful basis', 'DSAR'], expected_questions: ['什么数据真的算 PII?', '美国 CCPA 跟 GDPR 实操差异?'] },
  { goal: '能跟 designer 讨论无障碍 (a11y) 而 ! 加 "可访问性需求" 一行', expected_next_lessons: ['屏幕阅读器现实', 'WCAG 等级直觉', 'keyboard navigation'], expected_concepts: ['ARIA', 'contrast ratio', 'focus order', 'screen reader'], expected_questions: ['a11y 真的有几个用户?', 'AA vs AAA 实际选哪个?'] },
  { goal: 'API rate limiting 概念清到能写 spec', expected_next_lessons: ['rate limit 用户体验', 'token bucket vs leaky bucket', '429 vs 503'], expected_concepts: ['quota', 'burst', 'sliding window', 'backoff'], expected_questions: ['用户被限速怎么提示 ! 让他骂?', '免费 vs 付费 quota 怎么定?'] },
  { goal: '懂 SaaS pricing model 设计 (per-seat / usage / hybrid)', expected_next_lessons: ['定价模式分类', 'land-and-expand 数学', '价格锚定心理'], expected_concepts: ['ACV', 'NRR', 'price elasticity', 'land-and-expand'], expected_questions: ['per-seat 跟 usage-based 何时切换?', '免费 tier 真的引流吗?'] },
  { goal: '理解 onboarding funnel 漏斗设计 + activation', expected_next_lessons: ['activation 定义', 'aha moment 识别', 'onboarding 长度取舍'], expected_concepts: ['activation', 'aha moment', 'time-to-value', 'drop-off'], expected_questions: ['onboarding 越短越好吗?', 'tutorial vs do-it-live 选哪?'] },
  { goal: '能看 SQL 查询计划 ! 直接给工程师', expected_next_lessons: ['EXPLAIN 入门', 'index 概念', 'slow query 识别'], expected_concepts: ['index', 'seq scan', 'join', 'cost'], expected_questions: ['查询慢真的是 DB 锅吗?', '加索引一定快吗?'] },
  { goal: '懂 vector database / embedding 基础概念', expected_next_lessons: ['embedding 是什么', 'similarity 直觉', '何时 ! 用 vector DB'], expected_concepts: ['embedding', 'cosine similarity', 'kNN', 'recall@k'], expected_questions: ['vector DB 跟普通 DB 啥时候并存?', 'RAG 真的能省 fine-tune 吗?'] },
  { goal: '能写一份 ML feature 的 PRD ! 让 ML PM 笑场', expected_next_lessons: ['ML feature ! ! deterministic', 'metric 定义', '失败模式预案'], expected_concepts: ['training data', 'drift', 'shadow mode', 'fallback'], expected_questions: ['ML feature 该承诺什么 SLA?', '模型挂了怎么 graceful degrade?'] },
  { goal: '理解 push notification 经济学 + dark pattern 边界', expected_next_lessons: ['notification permission funnel', 'cadence design', 'dark pattern 红线'], expected_concepts: ['opt-in rate', 'CTR decay', 'frequency cap', 'retention'], expected_questions: ['什么 push 用户欢迎 ? 什么招黑?', 'notification 多了反伤 retention 吗?'] },
  { goal: '懂 system design interview 概念能审 engineer 候选', expected_next_lessons: ['load balancer 角色', 'cache 层级', 'sharding 直觉'], expected_concepts: ['load balancer', 'cache', 'shard', 'CDN'], expected_questions: ['面 senior 看哪些信号?', 'system design 能力跟实际 ship 能力差多远?'] },
  { goal: '能 brief 一个 mobile -> web 跨端 feature roadmap', expected_next_lessons: ['平台差异 ! 美学', 'native vs web vs hybrid', 'feature flag 跨端协调'], expected_concepts: ['platform feature parity', 'react native', 'webview', 'feature flag'], expected_questions: ['为什么 iOS 一个 feature web 干不了?', 'PWA 真的能替代 native 吗?'] },
  { goal: '看懂内部 BI dashboard ! 被 metric 牵着走', expected_next_lessons: ['DAU vs MAU 取舍', '北极星指标设计', 'metric goodhart'], expected_concepts: ['north star', 'leading indicator', 'cohort', 'retention'], expected_questions: ['DAU 跌但 retention 升怎么解读?', '北极星 metric 错了多久才发现?'] },
  { goal: '理解 incident response 流程 + blameless postmortem', expected_next_lessons: ['SEV 等级', 'IC 角色', 'postmortem 写法'], expected_concepts: ['SEV', 'incident commander', 'RCA', 'action item'], expected_questions: ['PM 在 incident 干啥? 离场或留场?', '为什么 blameless 实际很难做到?'] },
  { goal: '懂 API contract / versioning 战略 ! 跟 platform team 吵', expected_next_lessons: ['breaking change 定义', 'deprecation 节奏', 'backward-compat 边界'], expected_concepts: ['SemVer', 'breaking change', 'deprecation period', 'feature flag'], expected_questions: ['多久通知 deprecation 合理?', 'major bump 真的需要 PR 配套吗?'] },
  { goal: '能聊 AI 安全 + alignment ! 只会念新闻标题', expected_next_lessons: ['alignment 是什么问题', 'RLHF 限制', 'AI safety 公司角色'], expected_concepts: ['alignment', 'RLHF', 'red team', 'eval'], expected_questions: ['AI safety 跟 product safety 真重叠吗?', 'PM 在 AI safety 能做什么具体事?'] },
];

// ---------------------------------------------------------------------------
// researcher — academic / industrial. Paper-first. Reproducibility.
// ---------------------------------------------------------------------------
const RESEARCHER_TRAJECTORIES = [
  { goal: '能复现 Chinchilla 论文的 compute-optimal scaling 曲线', expected_next_lessons: ['Chinchilla 实验设计', 'compute-optimal 推导', 'follow-up 反驳'], expected_concepts: ['IsoFLOP', 'loss surface', 'parameter-token ratio', 'compute budget'], expected_questions: ['Chinchilla 跟 Kaplan 真冲突点?', 'Llama 3 数据 ratio 为什么超 Chinchilla?'] },
  { goal: '理解 diffusion model 数学 (SDE + score matching) 到能读 Yang Song', expected_next_lessons: ['score matching 起源', 'reverse SDE', 'classifier-free guidance'], expected_concepts: ['score function', 'Fokker-Planck', 'time embedding', 'noise schedule'], expected_questions: ['DDPM 跟 score-based 哪个 framing 更深?', 'flow matching 真简化吗?'] },
  { goal: '能在自己 domain 设计一个能发顶会的 ablation 实验', expected_next_lessons: ['ablation 设计原则', 'baseline 选择', 'statistical reporting'], expected_concepts: ['ablation', 'baseline', 'confidence interval', 'seed variance'], expected_questions: ['多少 seed 才足以排 noise?', 'ablation 跟 sensitivity analysis 边界?'] },
  { goal: 'RLHF / DPO / PPO 算法链能讲清并 reproduce', expected_next_lessons: ['PPO 在 NLP 设定', 'DPO 推导', 'reward model 失败模式'], expected_concepts: ['policy gradient', 'KL penalty', 'preference', 'reward hacking'], expected_questions: ['DPO 真的免 reward model 吗?', 'PPO clip ratio 1.2 vs 1.5 实验差?'] },
  { goal: '能读懂 mech interp papers (induction heads + SAE)', expected_next_lessons: ['induction head 论证', 'feature visualization', 'sparse autoencoder'], expected_concepts: ['attention head', 'feature direction', 'superposition', 'monosemanticity'], expected_questions: ['SAE 真的找到了语义 feature 吗?', 'mech interp 跟传统 explainability 区别?'] },
  { goal: 'Causal inference (do-calculus + IV + DiD) 能写 paper section', expected_next_lessons: ['Pearl do-calculus', 'instrumental variable', 'difference-in-differences'], expected_concepts: ['backdoor', 'frontdoor', 'IV', 'parallel trends'], expected_questions: ['为什么 RCT 不够? 何时用 IV?', 'DiD 跟 synthetic control 边界?'] },
  { goal: 'Graph neural network (GNN) message passing 推导清', expected_next_lessons: ['message passing 框架', 'WL test 等价', 'over-smoothing'], expected_concepts: ['aggregation', 'WL test', 'over-smoothing', 'expressiveness'], expected_questions: ['GNN 真比 transformer 更适合 graph 吗?', 'over-smoothing 如何度量?'] },
  { goal: '能 reproduce 一篇 robotics 论文从 sim2real gap 角度', expected_next_lessons: ['sim2real 来源分类', 'domain randomization', 'evaluation pitfalls'], expected_concepts: ['domain gap', 'randomization', 'transfer', 'real-world eval'], expected_questions: ['sim2real success 真的还是 cherry-pick?', 'robotics paper 复现率为什么低?'] },
  { goal: 'Bayesian deep learning (VI + MCMC + dropout) 工程化用', expected_next_lessons: ['variational inference', 'MC dropout', 'calibration'], expected_concepts: ['ELBO', 'posterior', 'ensemble', 'calibration'], expected_questions: ['MC dropout 真 Bayesian 吗?', 'ensemble vs BNN 实操差?'] },
  { goal: '能跟 NLP 大佬讨论 emergent abilities critique', expected_next_lessons: ['emergent abilities 原 claim', 'metric criticism', 'log-linear vs threshold'], expected_concepts: ['emergence', 'continuous metric', 'log-scale', 'threshold artifact'], expected_questions: ['Schaeffer paper 真证伪 emergence 吗?', 'log-linear 跟 threshold 真的不能共存?'] },
  { goal: '理解 information bottleneck + DL generalization 理论', expected_next_lessons: ['IB framework', 'Tishby critique', 'modern generalization theory'], expected_concepts: ['mutual information', 'compression phase', 'rate-distortion', 'PAC-Bayes'], expected_questions: ['IB 真解释 generalization 吗?', '为什么 Tishby 实验后续 ! 复现?'] },
  { goal: '能 referee 一篇 NeurIPS submission 给可执行 feedback', expected_next_lessons: ['评审标准', '建设性 critique', '边界审查'], expected_concepts: ['novelty', 'soundness', 'reproducibility', 'significance'], expected_questions: ['reject 但 confidence 5 该写什么?', 'novelty 跟 incremental 边界?'] },
  { goal: '能从 statistical physics 视角看 deep learning loss landscape', expected_next_lessons: ['spin glass 类比', 'mode connectivity', 'flat vs sharp minima'], expected_concepts: ['energy landscape', 'mode connectivity', 'Hessian', 'sharpness'], expected_questions: ['mode connectivity 跟 ensemble 关系?', 'sharpness 跟 generalization 真因果?'] },
  { goal: '能从头实现一个 transformer + 训练到能写 paper', expected_next_lessons: ['minGPT 起点', 'optimization recipe', 'eval harness'], expected_concepts: ['attention', 'AdamW', 'mixed precision', 'eval'], expected_questions: ['训 1B 模型最大坑?', '复现 GPT-2 实际要多久?'] },
  { goal: '理解 multi-modal model 架构 (CLIP / Flamingo / Gemini)', expected_next_lessons: ['CLIP contrastive', 'Flamingo cross-attention', 'native multi-modal'], expected_concepts: ['contrastive', 'cross-attention', 'fusion', 'modality gap'], expected_questions: ['为什么 CLIP 之后才有 multi-modal 突破?', 'native 跟 fusion 真差距?'] },
  { goal: '能写一篇 systems-for-ML paper (! 只是 ML)', expected_next_lessons: ['systems paper 范式', 'profiling 工具', 'optimization claim'], expected_concepts: ['profiling', 'kernel fusion', 'memory bandwidth', 'throughput'], expected_questions: ['systems-for-ML 顶会偏好?', 'kernel-level optim 跟 algorithmic 哪个 ROI 高?'] },
  { goal: '理解 federated learning 隐私 + 实操限制', expected_next_lessons: ['FedAvg 算法', 'differential privacy', 'systems challenge'], expected_concepts: ['gradient sharing', 'DP budget', 'stragglers', 'heterogeneity'], expected_questions: ['FL 在工业为什么少落地?', 'DP 跟 accuracy 真没法兼?'] },
  { goal: '能给 reading group 讲 best paper 跟其他 paper 接续', expected_next_lessons: ['paper 互相引用脉络', 'reading group 节奏', 'follow-up 识别'], expected_concepts: ['citation graph', 'follow-up', 'methodology contrast', 'reading list'], expected_questions: ['一篇 paper 看多深合适?', '不同领域 paper 跨读怎么挑?'] },
  { goal: '能从 first principles 推 attention 复杂度 + flash-attn 优化', expected_next_lessons: ['O(n²) bottleneck', 'flash-attn 想法', 'ring attention 演化'], expected_concepts: ['memory hierarchy', 'tiling', 'recomputation', 'IO complexity'], expected_questions: ['flash-attn 真的免新 cuda kernel 吗?', 'ring attention 在长 context 真省吗?'] },
  { goal: '能给 PhD 学弟设计一个 6 月可发表 sub-topic', expected_next_lessons: ['research taste', 'sub-topic scoping', 'failure modes'], expected_concepts: ['research direction', 'feasibility', 'novelty', 'mentor signal'], expected_questions: ['PhD 第一年最该避什么坑?', '怎么判断 sub-topic 还没被做烂?'] },
];

const TRAJECTORY_TABLE = Object.freeze({
  'engineer-mid':    Object.freeze(ENGINEER_MID_TRAJECTORIES.map(Object.freeze)),
  'engineer-senior': Object.freeze(ENGINEER_SENIOR_TRAJECTORIES.map(Object.freeze)),
  'pm':              Object.freeze(PM_TRAJECTORIES.map(Object.freeze)),
  'researcher':      Object.freeze(RESEARCHER_TRAJECTORIES.map(Object.freeze)),
});

// Per-archetype lesson-0 framing — written manuscript register, no hype.
const LESSON_0_BY_ARCHETYPE = Object.freeze({
  'engineer-mid':    '从你最近一次本可以跑通但卡 4 小时的 bug 切入。先抓概念骨架,后补术语。每节带一个能在 IDE 验证的 1-line 实验。',
  'engineer-senior': '从历史顺序进入: 这门技术 / 概念是为了 fix 哪个上一代失败而生的。优先 second-order tradeoff, 默认你已会 textbook 一层。',
  'pm':              '从你 PRD 里最常被工程师反问的术语切入。每节末有一个 "下次跟工程师说这句" 的可移交摘要,! 公式 ! 代码。',
  'researcher':      '从一篇 anchor paper 出发,带 critique + reproducibility 视角。每节末必给一个 follow-up reading + 一个未解 open question。',
});

// Per-archetype seed concept tags — feeds initial classification graph.
const STARTER_CONCEPTS_BY_ARCHETYPE = Object.freeze({
  'engineer-mid':    Object.freeze(['debugging', 'pragmatism', 'shipping', 'time-box', 'incident', 'rollback']),
  'engineer-senior': Object.freeze(['systems-thinking', 'history', 'tradeoff', 'mentorship', 'vision', 'first-principles']),
  'pm':              Object.freeze(['user-value', 'tradeoff-vocabulary', 'metric-literacy', 'engineering-empathy', 'roadmap']),
  'researcher':      Object.freeze(['hypothesis', 'reproducibility', 'literature', 'ablation', 'theory-empirics']),
});

function isKnownArchetype(id) {
  return ARCHETYPES.indexOf(id) !== -1;
}

/**
 * getStarterPlaybook — Day-1 personalized starter bundle.
 * Returns trajectories + lesson-0 framing string + seed concepts. ! mutates
 * underlying data — caller owns post-processing.
 */
function getStarterPlaybook(archetype) {
  if (!isKnownArchetype(archetype)) {
    return null;
  }
  return {
    archetype,
    trajectories: TRAJECTORY_TABLE[archetype].slice(),
    suggested_lesson_0: LESSON_0_BY_ARCHETYPE[archetype],
    suggested_concepts: STARTER_CONCEPTS_BY_ARCHETYPE[archetype].slice(),
  };
}

function listTrajectories(archetype) {
  if (!isKnownArchetype(archetype)) return [];
  return TRAJECTORY_TABLE[archetype].slice();
}

module.exports = {
  ARCHETYPES,
  getStarterPlaybook,
  listTrajectories,
  isKnownArchetype,
};
