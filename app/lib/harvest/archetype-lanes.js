// archetype-lanes.js — Knowledge Source System §5 lane priority config.
//
// Maps each course archetype to its preferred source kit. Used by the harvest
// path to bias retrieval toward register-appropriate sources before falling
// back to the generic channel mix (arxiv / github / hn / web / wikipedia /
// openalex / youtube / sep / yclibrary / courseware / openreview / pwc /
// hf-papers / pinned-domains in app/agent.js).
//
// This module is config-only. It does NOT mutate source-extractor.js internals
// and does NOT change the live harvest() control flow. agent.js can read the
// lane (via getPrioritySourcesFor) and re-rank or prepend channels — that
// integration is intentionally deferred (see "INTEGRATION NOTE" below).
// Today's contract: expose the lanes, allow other layers (UI / picker /
// future Layer 0 in harvest) to consult them.
//
// intentional-placeholder: per-topic resolver URLs in TECH-PROC /
// LANG-ACQ / DECL-MASS / MINDSET lanes are marked '...' or 'topic-specific'
// in url_template because resolving e.g. an "official-docs" URL requires
// topic-aware logic (Python topic → docs.python.org; React topic →
// react.dev). That resolver is a follow-up wiring step in agent.js or a
// dedicated source-resolver module — not part of this lane-config layer.
//
// All exports are frozen — lanes are read-only configuration, not mutable
// state. Per coding-style.md immutability rule.

'use strict';

const ARCHETYPE_LANES = Object.freeze({
  'HUMANITIES': Object.freeze({
    label: '人文 (文学/哲学/历史)',
    register_hint:
      'manuscript / 学者引用风格 / 不堆 5xx 论文 metadata, 重视原文 + 顶级评论',
    priority_sources: Object.freeze([
      Object.freeze({
        id: 'project-gutenberg',
        url_template: 'https://www.gutenberg.org/ebooks/search/?query={topic}',
        notes: '经典原文 (PD)',
      }),
      Object.freeze({
        id: 'nobel-lectures',
        url_template:
          'https://www.nobelprize.org/prizes/lists/all-nobel-prizes-in-literature/',
        notes: '诺贝尔文学奖颁奖词 + lectures',
      }),
      Object.freeze({
        id: 'tolkien-estate',
        url_template: 'https://www.tolkienestate.com/',
        notes: '官方 Tolkien archive',
      }),
      Object.freeze({
        id: 'oxford-academic-literature',
        url_template: 'https://academic.oup.com/literary-imagination',
        notes: '文学批评顶刊',
      }),
      Object.freeze({
        id: 'paris-review-interviews',
        url_template: 'https://www.theparisreview.org/interviews/',
        notes: 'Writers at Work 访谈系列',
      }),
      Object.freeze({
        id: 'lrb-nybr',
        url_template:
          'https://www.lrb.co.uk/ + https://www.nybooks.com/',
        notes: '英美顶级书评',
      }),
      Object.freeze({
        id: 'jstor-humanities',
        url_template: 'https://www.jstor.org/subject/literature',
        notes: '学术论文',
      }),
    ]),
    forbidden_sources: Object.freeze([
      'hackernews',
      'arxiv-cs',
      'github-trending',
    ]),
  }),

  'TECH-CONCEPT': Object.freeze({
    label: '技术概念',
    register_hint:
      'frontier 论文 + 顶尖 lab blog + 概念深度推演; 不堆 stackoverflow snippet',
    priority_sources: Object.freeze([
      Object.freeze({
        id: 'arxiv',
        url_template: 'https://arxiv.org/abs/',
        notes: 'arXiv pre-print (cs/stat/math)',
      }),
      Object.freeze({
        id: 'anthropic-research',
        url_template: 'https://www.anthropic.com/research',
        notes: 'Anthropic 顶级 lab 研究',
      }),
      Object.freeze({
        id: 'openai-research',
        url_template: 'https://openai.com/research/',
        notes: 'OpenAI Research blog',
      }),
      Object.freeze({
        id: 'deepmind-research',
        url_template: 'https://deepmind.google/research/publications/',
        notes: 'DeepMind / Google AI publications',
      }),
      Object.freeze({
        id: 'distill',
        url_template: 'https://distill.pub/',
        notes: 'Distill (interactive concept articles)',
      }),
      Object.freeze({
        id: 'simon-willison',
        url_template: 'https://simonwillison.net/',
        notes: 'Simon Willison frontier digest',
      }),
      Object.freeze({
        id: 'latent-space',
        url_template: 'https://www.latent.space/',
        notes: 'Latent Space podcast + write-ups',
      }),
    ]),
    forbidden_sources: Object.freeze([
      'reddit-shitposts',
      'twitter-rage',
    ]),
  }),

  'TECH-PROC': Object.freeze({
    label: '技术过程',
    register_hint:
      '官方 doc + cookbook + 高 star 仓 + working example; 不抓概念论文',
    priority_sources: Object.freeze([
      Object.freeze({
        // intentional-placeholder: per-topic resolver — official doc URL
        // depends on topic (Python→docs.python.org, React→react.dev). Lane
        // config layer cannot synthesize without topic-aware resolver.
        id: 'official-docs',
        url_template: '... (per topic)',
        notes: '官方文档 (per-topic resolver)',
      }),
      Object.freeze({
        id: 'github-stars-1k',
        url_template: 'https://github.com/search?q={topic}+stars%3A%3E1000',
        notes: 'GitHub 高 star 仓',
      }),
      Object.freeze({
        id: 'stackoverflow',
        url_template:
          'https://stackoverflow.com/search?q={topic}',
        notes: 'StackOverflow Q&A',
      }),
      Object.freeze({
        // intentional-placeholder: 'topic-specific' marker — resolver picks
        // the right cookbook (OpenAI/Anthropic/HF) based on topic vertical.
        id: 'cookbook-tutorials',
        url_template: 'topic-specific',
        notes: 'OpenAI/Anthropic/HF cookbook + 官方 tutorial 集合',
      }),
    ]),
    forbidden_sources: Object.freeze([]),
  }),

  'LANG-ACQ': Object.freeze({
    label: '语言习得',
    register_hint:
      'native input + 真实对话 transcript + 大型语料库; 不抓语法书规则堆',
    priority_sources: Object.freeze([
      Object.freeze({
        // intentional-placeholder: native podcast URL depends on target
        // language (Spanish→Radio Ambulante; Japanese→NHK Easy News). Lane
        // config can't resolve without language param.
        id: 'native-podcasts',
        url_template: 'topic-language native podcasts',
        notes: '母语 podcast (含 transcript)',
      }),
      Object.freeze({
        // intentional-placeholder: transcript source picked at runtime per
        // language (English→TED; Mandarin→央视; Spanish→RNE).
        id: 'verbatim-transcripts',
        url_template: '...',
        notes: '逐字 transcript (TED / NPR / 央视 等)',
      }),
      Object.freeze({
        id: 'corpora',
        url_template: 'COCA / BNC / 国家语料库',
        notes: '大型语言语料库',
      }),
    ]),
    forbidden_sources: Object.freeze([]),
  }),

  'DECL-MASS': Object.freeze({
    label: '陈述性大量',
    register_hint:
      '官方教材 + 真题 + 题库; 不抓 frontier 论文 (考纲外)',
    priority_sources: Object.freeze([
      Object.freeze({
        // intentional-placeholder: textbook URL depends on exam (考研→
        // 高教社; SAT→CollegeBoard). Resolver picks per exam at runtime.
        id: 'official-textbooks',
        url_template: '...',
        notes: '官方指定教材',
      }),
      Object.freeze({
        // intentional-placeholder: past-exam archive depends on exam type
        // (考研→中国研究生招生信息网; AP→CollegeBoard).
        id: 'past-exams',
        url_template: '...',
        notes: '历年真题',
      }),
      Object.freeze({
        // intentional-placeholder: practice-bank URL per exam (考研→肖秀荣;
        // CFA→Schweser).
        id: 'practice-bank',
        url_template: '...',
        notes: '权威题库 (含解析)',
      }),
    ]),
    forbidden_sources: Object.freeze([]),
  }),

  'MINDSET': Object.freeze({
    label: '心智模式',
    register_hint:
      '十年级 talk + rationalist archive + Munger/Buffett 级 corpus; 不抓 hype thread',
    priority_sources: Object.freeze([
      Object.freeze({
        // intentional-placeholder: Munger talks live across multiple
        // archives (Berkshire AGM transcripts / Poor Charlie's Almanack
        // excerpts / Caltech 1986 commencement). Resolver picks per
        // sub-topic (investing / mental models / decision-making).
        id: 'munger-decade-talks',
        url_template: '...',
        notes: 'Charlie Munger 十年级演讲合集',
      }),
      Object.freeze({
        id: 'rationalist-archive',
        url_template: 'https://www.lesswrong.com/',
        notes: 'LessWrong / rationalist sequences',
      }),
      Object.freeze({
        id: 'farnam-street',
        url_template: 'https://fs.blog/',
        notes: 'Farnam Street mental models',
      }),
    ]),
    forbidden_sources: Object.freeze([]),
  }),
});

// Substitute {topic} placeholder in url_template. URL-encodes the topic to
// keep query strings safe (spaces / unicode / punctuation). Templates without
// the placeholder are returned verbatim (resolver handles per-topic logic
// at the call site).
function _renderTemplate(template, topic) {
  if (typeof template !== 'string') return '';
  if (typeof topic !== 'string' || topic.length === 0) return template;
  if (!template.includes('{topic}')) return template;
  let encoded = topic;
  try {
    encoded = encodeURIComponent(topic);
  } catch (_) {
    encoded = topic;
  }
  return template.split('{topic}').join(encoded);
}

/**
 * Get the lane config for an archetype.
 * @param {string} archetype — e.g. 'HUMANITIES' / 'TECH-CONCEPT'.
 * @returns {object|null} frozen lane config or null when unknown.
 */
function getLaneConfig(archetype) {
  if (typeof archetype !== 'string') return null;
  const lane = ARCHETYPE_LANES[archetype];
  return lane || null;
}

/**
 * Get the priority source list for an archetype, with {topic} rendered into
 * each url_template. Returns [] when archetype is unknown so the caller can
 * fall through to the generic harvest mix without a null-check branch.
 * @param {string} archetype
 * @param {string} topic
 * @returns {Array<{id: string, url: string, notes: string}>}
 */
function getPrioritySourcesFor(archetype, topic) {
  const lane = getLaneConfig(archetype);
  if (!lane) return [];
  const t = typeof topic === 'string' ? topic : '';
  return lane.priority_sources.map((src) =>
    Object.freeze({
      id: src.id,
      url: _renderTemplate(src.url_template, t),
      notes: src.notes || '',
    })
  );
}

/**
 * Get the forbidden source ids for an archetype. Returns [] when unknown.
 * @param {string} archetype
 * @returns {Array<string>}
 */
function getForbiddenFor(archetype) {
  const lane = getLaneConfig(archetype);
  if (!lane) return [];
  return Array.from(lane.forbidden_sources);
}

/**
 * List all known archetype ids — useful for picker UI + validation.
 * @returns {Array<string>}
 */
function listArchetypes() {
  return Object.keys(ARCHETYPE_LANES);
}

// INTEGRATION NOTE (agent.js:harvest, line ~1813).
// ────────────────────────────────────────────────────────────────────────
// intentional-placeholder: harvest() wiring is deliberately deferred per
// task brief ("不真改 harvest()") — this module ships the lane config
// layer only; agent.js integration is a follow-up patch.
//
// agent.js:harvest(topic, settings, onProgress, archetype) currently picks a
// channel route via CHANNEL_ROUTES[archetype]. To wire archetype-lane
// priority sources WITHOUT touching source-extractor.js internals, the
// integration plan is:
//
//   1. Inside harvest(), AFTER channel dispatch, fold the lane's
//      priority_sources into the rank step as a high-weight signal class
//      (e.g. boost results whose source URL host matches a lane id's host
//      whitelist). Lane forbidden_sources demote / drop matches.
//
//   2. Alternative: at top of harvest(), if archetype lane defines a
//      priority_sources kit, pre-seed liveItems with synthesized stubs
//      pointing at the lane URLs (already encoded above); the existing
//      ranking step then orders them ahead of generic channels.
//
//   3. UI picker (TabContent.jsx HyphaEvolutionWelcome) can render
//      getPrioritySourcesFor(archetype, topic) as a "source kit" preview so
//      the user sees which canonical sources will be biased toward.
//
// Today's task ships the config layer only. Wiring is a follow-up patch
// once harvest re-rank surface stabilises.
// ────────────────────────────────────────────────────────────────────────

module.exports = Object.freeze({
  ARCHETYPE_LANES,
  getLaneConfig,
  getPrioritySourcesFor,
  getForbiddenFor,
  listArchetypes,
});
