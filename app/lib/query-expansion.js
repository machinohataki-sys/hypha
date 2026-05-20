'use strict';

// HYPHA · Query expansion for library + community harvest (R-LIB v0.1, 2026-05-12).
//
// Topic → 3 query vectors before queryLibrary:
//   direct  — original topic + multilingual aliases
//   prereq  — earlier philosophers / concepts that ground the topic
//   related — contemporaries + critics + receivers
//
// v0.1 = hand-curated dictionary (~25 entries) covering Greek → 20c canon.
// Coverage is intentionally narrow but high-confidence — for entries not in
// the dict we fall back to single-keyword (direct = [topic]).
//
// v0.2 ladder = LLM expansion (gemini-flash, ~$0.001/course) to generalize
// to non-philosophy domains (math / CS / history / literature).
//
// The dict is a closed taxonomy of philosophy because that's the user's
// upload corpus (Copleston). Future domain packs ship their own dict alongside
// hypha-org/hypha-packs (R-LIB Day 3 community schema).

const PHILOSOPHY_DICT = {
  // ── Ancient ──────────────────────────────────────────────
  plato: {
    aliases: ['Plato', '柏拉图', 'Platon'],
    prereq: ['Socrates', '苏格拉底', 'Heraclitus', 'Pythagoras'],
    related: ['Aristotle', '亚里士多德', 'Neoplatonism', 'Plotinus'],
  },
  aristotle: {
    aliases: ['Aristotle', '亚里士多德', 'Aristoteles'],
    prereq: ['Plato', '柏拉图', 'Socrates', '苏格拉底'],
    related: ['Aquinas', '阿奎那', 'Scholasticism', '经院哲学'],
  },
  socrates: {
    aliases: ['Socrates', '苏格拉底'],
    prereq: ['Sophists', 'pre-Socratic', '前苏格拉底'],
    related: ['Plato', '柏拉图', 'Xenophon'],
  },
  // ── Medieval ─────────────────────────────────────────────
  aquinas: {
    aliases: ['Aquinas', '阿奎那', 'Thomas Aquinas', 'Aquinatis'],
    prereq: ['Aristotle', '亚里士多德', 'Augustine', '奥古斯丁'],
    related: ['Duns Scotus', 'Ockham', '奥卡姆'],
  },
  augustine: {
    aliases: ['Augustine', '奥古斯丁', 'Aurelius Augustinus'],
    prereq: ['Plato', '柏拉图', 'Neoplatonism', 'Plotinus'],
    related: ['Aquinas', '阿奎那'],
  },
  // ── Modern (17c) ─────────────────────────────────────────
  descartes: {
    aliases: ['Descartes', '笛卡尔', 'René Descartes', 'Cartesius'],
    prereq: ['Aristotle', '亚里士多德', 'scholasticism', '经院哲学', 'Augustine'],
    related: ['Spinoza', '斯宾诺莎', 'Locke', '洛克', 'Malebranche'],
  },
  spinoza: {
    aliases: ['Spinoza', '斯宾诺莎', 'Baruch Spinoza', '巴鲁赫·斯宾诺莎', 'Benedictus de Spinoza'],
    prereq: ['Descartes', '笛卡尔', 'Plato', '柏拉图', 'substance', '实体', 'scholastic', '经院哲学'],
    related: ['Leibniz', '莱布尼茨', 'Wolfson', 'Hegel', '黑格尔', 'Deleuze'],
  },
  leibniz: {
    aliases: ['Leibniz', '莱布尼茨', 'Gottfried Wilhelm Leibniz'],
    prereq: ['Descartes', '笛卡尔', 'Spinoza', '斯宾诺莎', 'Aristotle', '亚里士多德'],
    related: ['Wolff', 'Clarke', 'Kant', '康德'],
  },
  // ── Modern (18c) ─────────────────────────────────────────
  locke: {
    aliases: ['Locke', '洛克', 'John Locke'],
    prereq: ['Descartes', '笛卡尔', 'Hobbes', '霍布斯'],
    related: ['Berkeley', '贝克莱', 'Hume', '休谟'],
  },
  berkeley: {
    aliases: ['Berkeley', '贝克莱', 'George Berkeley'],
    prereq: ['Locke', '洛克', 'Malebranche'],
    related: ['Hume', '休谟', 'Kant', '康德'],
  },
  hume: {
    aliases: ['Hume', '休谟', 'David Hume'],
    prereq: ['Locke', '洛克', 'Berkeley', '贝克莱'],
    related: ['Kant', '康德', 'Reid', 'Smith', '亚当·斯密'],
  },
  kant: {
    aliases: ['Kant', '康德', 'Immanuel Kant'],
    prereq: ['Hume', '休谟', 'Leibniz', '莱布尼茨', 'Wolff'],
    related: ['Fichte', '费希特', 'Schelling', '谢林', 'Hegel', '黑格尔'],
  },
  // ── 19c ──────────────────────────────────────────────────
  hegel: {
    aliases: ['Hegel', '黑格尔', 'Georg Wilhelm Friedrich Hegel'],
    prereq: ['Kant', '康德', 'Fichte', '费希特', 'Schelling', '谢林'],
    related: ['Marx', '马克思', 'Kierkegaard', '克尔凯郭尔', 'Schopenhauer', '叔本华'],
  },
  schopenhauer: {
    aliases: ['Schopenhauer', '叔本华', 'Arthur Schopenhauer'],
    prereq: ['Kant', '康德', 'Plato', '柏拉图', 'Upanishads'],
    related: ['Nietzsche', '尼采', 'Wittgenstein', '维特根斯坦'],
  },
  nietzsche: {
    aliases: ['Nietzsche', '尼采', 'Friedrich Nietzsche'],
    prereq: ['Schopenhauer', '叔本华', 'Heraclitus', 'pre-Socratic'],
    related: ['Heidegger', '海德格尔', 'Foucault', '福柯', 'Deleuze'],
  },
  marx: {
    aliases: ['Marx', '马克思', 'Karl Marx'],
    prereq: ['Hegel', '黑格尔', 'Feuerbach', '费尔巴哈', 'Smith', '亚当·斯密'],
    related: ['Engels', '恩格斯', 'Lenin', 'Frankfurt School'],
  },
  // ── 20c ──────────────────────────────────────────────────
  husserl: {
    aliases: ['Husserl', '胡塞尔', 'Edmund Husserl'],
    prereq: ['Brentano', 'Kant', '康德', 'Bolzano'],
    related: ['Heidegger', '海德格尔', 'Merleau-Ponty', '梅洛-庞蒂', 'Sartre', '萨特'],
  },
  heidegger: {
    aliases: ['Heidegger', '海德格尔', 'Martin Heidegger'],
    prereq: ['Husserl', '胡塞尔', 'Nietzsche', '尼采', 'Kierkegaard', '克尔凯郭尔'],
    related: ['Sartre', '萨特', 'Gadamer', '伽达默尔', 'Derrida', '德里达'],
  },
  wittgenstein: {
    aliases: ['Wittgenstein', '维特根斯坦', 'Ludwig Wittgenstein'],
    prereq: ['Frege', '弗雷格', 'Russell', '罗素'],
    related: ['Carnap', '卡尔纳普', 'Ryle', 'Austin', 'Quine'],
  },
  sartre: {
    aliases: ['Sartre', '萨特', 'Jean-Paul Sartre'],
    prereq: ['Heidegger', '海德格尔', 'Husserl', '胡塞尔', 'Hegel', '黑格尔'],
    related: ['Beauvoir', '波伏娃', 'Merleau-Ponty', '梅洛-庞蒂', 'Camus', '加缪'],
  },
  // ── Cross-cutting concepts ───────────────────────────────
  substance: {
    aliases: ['substance', '实体', 'ousia', 'οὐσία'],
    prereq: ['Aristotle', '亚里士多德', 'Plato', '柏拉图', 'category', '范畴'],
    related: ['Spinoza', '斯宾诺莎', 'Leibniz', '莱布尼茨', 'attribute', '属性'],
  },
  causality: {
    aliases: ['causality', '因果', 'causation', '因果性'],
    prereq: ['Aristotle', '亚里士多德', 'four causes', '四因'],
    related: ['Hume', '休谟', 'Kant', '康德'],
  },
  phenomenology: {
    aliases: ['phenomenology', '现象学', 'Phänomenologie'],
    prereq: ['Husserl', '胡塞尔', 'Brentano', 'Kant', '康德'],
    related: ['Heidegger', '海德格尔', 'Merleau-Ponty', '梅洛-庞蒂', 'Sartre', '萨特'],
  },
};

/**
 * Normalize topic for dict lookup — lowercase, strip whitespace + punctuation.
 */
function _norm(s) {
  return String(s || '').toLowerCase().trim().replace(/[\s.,;:()【】《》「」"'`]+/g, ' ');
}

/**
 * Look up dict entry matching topic. Key match first, then alias match
 * (substring both ways — handles "斯宾诺莎" matching alias "斯宾诺莎" AND
 * topic "巴鲁赫·斯宾诺莎" matching alias "Baruch Spinoza" via alias "斯宾诺莎").
 */
function _lookupEntry(topic) {
  const norm = _norm(topic);
  if (!norm) return null;
  // Direct key match
  for (const k of Object.keys(PHILOSOPHY_DICT)) {
    if (norm === k || norm.includes(k)) return { key: k, entry: PHILOSOPHY_DICT[k] };
  }
  // Alias match (handles 多语言)
  for (const [k, v] of Object.entries(PHILOSOPHY_DICT)) {
    for (const alias of v.aliases) {
      const an = _norm(alias);
      if (an && (norm.includes(an) || an.includes(norm))) {
        return { key: k, entry: v };
      }
    }
  }
  return null;
}

/**
 * Expand a topic into 3 query vectors.
 *
 * @param {string} topic — user's course topic
 * @param {object} opts
 * @param {string[]} opts.layer1Ancestors — extra prereq terms from harvest Layer 1 (SEP / syllabus extraction). Optional.
 * @returns {{ direct: string[], prereq: string[], related: string[], matched_key: string|null }}
 */
function expandQueryForCourse(topic, opts = {}) {
  if (!topic || typeof topic !== 'string') {
    return { direct: [], prereq: [], related: [], matched_key: null };
  }
  const hit = _lookupEntry(topic);
  const direct = hit ? [...hit.entry.aliases] : [topic.trim()];
  const prereq = hit ? [...hit.entry.prereq] : [];
  const related = hit ? [...hit.entry.related] : [];
  // Merge extra Layer 1 ancestors (deduplicated, case-insensitive)
  const extras = Array.isArray(opts.layer1Ancestors) ? opts.layer1Ancestors : [];
  for (const x of extras) {
    if (typeof x !== 'string' || !x.trim()) continue;
    const xl = x.trim().toLowerCase();
    if (!prereq.some(p => p.toLowerCase() === xl)) prereq.push(x.trim());
  }
  // Ensure original topic stays in direct[]
  if (!direct.some(d => _norm(d) === _norm(topic))) direct.unshift(topic.trim());
  return { direct, prereq, related, matched_key: hit ? hit.key : null };
}

module.exports = { expandQueryForCourse, _PHILOSOPHY_DICT: PHILOSOPHY_DICT };
