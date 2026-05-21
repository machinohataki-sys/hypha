'use strict';
// Commons Pack schema validator — pure JS, no external deps.
// Validates structural shape of a Knowledge Pack JSON.
// See specs/commons.md §2 for field-by-field spec.

const ARCHETYPES = new Set([
  'TECH-CONCEPT', 'HUMANITIES', 'MINDSET', 'LANG-ACQ',
  'EXAM-MASTERY', 'MATH-MASTERY', 'SCIENCE-WORLD', 'CREATIVE-PROJECT',
]);

const LICENSES = new Set(['CC-BY-4.0', 'CC-BY-NC-4.0', 'CC-BY-SA-4.0', 'MIT', 'proprietary']);

const LESSON_ROLES = new Set(['prerequisite', 'core', 'ultimate']);

const LIFECYCLE_STATES = new Set(['draft', 'ratified', 'superseded', 'deprecated']);

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,79}$/;
const VERSION_PATTERN = /^\d+\.\d+(\.\d+)?$/;

function validatePack(pack) {
  const errors = [];
  if (!pack || typeof pack !== 'object' || Array.isArray(pack)) {
    errors.push('pack: must be object');
    return { ok: false, errors };
  }

  // id: kebab-case slug, 3-80 chars
  if (!pack.id || typeof pack.id !== 'string' || !ID_PATTERN.test(pack.id)) {
    errors.push('id: must be kebab-case slug 3-80 chars, [a-z0-9][a-z0-9-]+');
  }

  // name: string 3-200 chars
  if (!pack.name || typeof pack.name !== 'string' || pack.name.length < 3 || pack.name.length > 200) {
    errors.push('name: must be string 3-200 chars');
  }

  // version: semver-ish (M.m or M.m.p)
  if (!pack.version || typeof pack.version !== 'string' || !VERSION_PATTERN.test(pack.version)) {
    errors.push('version: must be semver like 1.0 or 1.0.0');
  }

  // archetype: enum
  if (!pack.archetype || !ARCHETYPES.has(pack.archetype)) {
    errors.push(`archetype: must be one of ${[...ARCHETYPES].join(',')}`);
  }

  // license: enum
  if (!pack.license || !LICENSES.has(pack.license)) {
    errors.push(`license: must be one of ${[...LICENSES].join(',')}`);
  }

  // author: string ≤ 100 chars
  if (!pack.author || typeof pack.author !== 'string' || pack.author.length === 0 || pack.author.length > 100) {
    errors.push('author: must be non-empty string ≤100 chars');
  }

  // lessons: non-empty array of well-shaped lesson objects
  if (!Array.isArray(pack.lessons) || pack.lessons.length === 0) {
    errors.push('lessons: must be non-empty array');
  } else {
    for (let i = 0; i < pack.lessons.length; i++) {
      const l = pack.lessons[i];
      if (!l || typeof l !== 'object' || Array.isArray(l)) {
        errors.push(`lessons[${i}]: must be object`);
        continue;
      }
      if (!l.topic || typeof l.topic !== 'string' || l.topic.length === 0) {
        errors.push(`lessons[${i}].topic: required non-empty string`);
      }
      if (!l.role || !LESSON_ROLES.has(l.role)) {
        errors.push(`lessons[${i}].role: must be prerequisite|core|ultimate`);
      }
      if (l.lessons_count !== undefined && (!Number.isInteger(l.lessons_count) || l.lessons_count < 1)) {
        errors.push(`lessons[${i}].lessons_count: must be positive integer if present`);
      }
      if (l.summary !== undefined && typeof l.summary !== 'string') {
        errors.push(`lessons[${i}].summary: must be string if present`);
      }
    }
  }

  // optional source_trust: object shape only
  if (pack.source_trust !== undefined) {
    if (!pack.source_trust || typeof pack.source_trust !== 'object' || Array.isArray(pack.source_trust)) {
      errors.push('source_trust: must be object if present');
    }
  }

  // optional lifecycle: enum if present. Default ('draft') applied at load
  // time in pack-loader so existing packs without the field stay valid.
  if (pack.lifecycle !== undefined) {
    if (typeof pack.lifecycle !== 'string' || !LIFECYCLE_STATES.has(pack.lifecycle)) {
      errors.push(`lifecycle: must be one of ${[...LIFECYCLE_STATES].join(',')} if present`);
    }
  }

  // optional intelligence_card: object shape only
  if (pack.intelligence_card !== undefined) {
    if (!pack.intelligence_card || typeof pack.intelligence_card !== 'object' || Array.isArray(pack.intelligence_card)) {
      errors.push('intelligence_card: must be object if present');
    }
  }

  // optional distill_log: array if present
  if (pack.distill_log !== undefined && !Array.isArray(pack.distill_log)) {
    errors.push('distill_log: must be array if present');
  }

  // optional created_at / updated_at: ISO-8601 string if present
  for (const ts of ['created_at', 'updated_at']) {
    if (pack[ts] !== undefined) {
      if (typeof pack[ts] !== 'string' || Number.isNaN(Date.parse(pack[ts]))) {
        errors.push(`${ts}: must be ISO-8601 string if present`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

module.exports = { validatePack, ARCHETYPES, LICENSES, LESSON_ROLES, LIFECYCLE_STATES };
