'use strict';

// =====================================================================
// HYPHA Lesson Schema v0.2+ (forward-compat).
//
// Per BLUEPRINT.md §6.1 amendment AMD-3+6:
//   v0.1 lesson body = 4 fields {1 objective, 2 prerequisite_check,
//     3 hook_concrete, 11 micro_proof + next_lesson_seed} from plan
//     plus {4 人话 prose} from generateLessonBody.
//   v0.2+ lesson body = all 11 fields (1-3 from plan, 4-9 added in v0.2,
//     10 references §11.3 Product Transfer state machine, 11 from plan).
//
// This module ONLY validates the v0.2+ shape. v0.1 still uses
// `validateBody` exported from lesson-generator.js. generateLessonBodyV2
// (Wave 3) will consume validateLessonV2 below.
// =====================================================================

const REQUIRED_V2_KEYS = [
  'objective',
  'prerequisite_check',
  'hook_concrete',
  'human_explanation',
  'mechanism',
  'required_terms',
  'examples',
  'common_misconceptions',
  'note_pack_connections',
  'product_transfer',
  'micro_proof',
  'next_lesson_seed',
];

const REQUIRED_PROOF_KEYS = ['stimulus', 'expected_signal', 'fail_mode'];
const VALID_REF_TYPES = ['note', 'pack', 'book_spark'];

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

/**
 * Validate v0.2+ Lesson Body shape (11 fields).
 * Pure function; does not mutate input.
 *
 * @param {object} lessonV2 - the 11-field object
 * @returns {Array<string>} errors (empty array = valid)
 */
function validateLessonV2(lessonV2) {
  if (!isPlainObject(lessonV2)) return ['lessonV2 must be object'];

  const errors = [];

  for (const k of REQUIRED_V2_KEYS) {
    if (!(k in lessonV2)) errors.push(`missing key: ${k}`);
  }

  // 1. objective — non-empty string.
  if ('objective' in lessonV2 && !isNonEmptyString(lessonV2.objective)) {
    errors.push('objective must be non-empty string');
  }

  // 2. prerequisite_check — string OR null.
  if (
    'prerequisite_check' in lessonV2 &&
    lessonV2.prerequisite_check !== null &&
    typeof lessonV2.prerequisite_check !== 'string'
  ) {
    errors.push('prerequisite_check must be string or null');
  }

  // 3. hook_concrete — non-empty string.
  if ('hook_concrete' in lessonV2 && !isNonEmptyString(lessonV2.hook_concrete)) {
    errors.push('hook_concrete must be non-empty string');
  }

  // 4. human_explanation — string >= 100 chars.
  if ('human_explanation' in lessonV2) {
    if (typeof lessonV2.human_explanation !== 'string') {
      errors.push('human_explanation must be a string');
    } else if (lessonV2.human_explanation.length < 100) {
      errors.push(`human_explanation must be >=100 chars, got ${lessonV2.human_explanation.length}`);
    }
  }

  // 5. mechanism — string >= 80 chars (explains WHY).
  if ('mechanism' in lessonV2) {
    if (typeof lessonV2.mechanism !== 'string') {
      errors.push('mechanism must be a string');
    } else if (lessonV2.mechanism.length < 80) {
      errors.push(`mechanism must be >=80 chars, got ${lessonV2.mechanism.length}`);
    }
  }

  // 6. required_terms — array, >=1, each {term, plain_definition}.
  if ('required_terms' in lessonV2) {
    if (!Array.isArray(lessonV2.required_terms)) {
      errors.push('required_terms must be an array');
    } else if (lessonV2.required_terms.length < 1) {
      errors.push('required_terms must have >=1 entry');
    } else {
      lessonV2.required_terms.forEach((t, i) => {
        if (!isPlainObject(t)) {
          errors.push(`required_terms[${i}] must be an object`);
          return;
        }
        if (!isNonEmptyString(t.term)) errors.push(`required_terms[${i}].term must be non-empty string`);
        if (!isNonEmptyString(t.plain_definition)) errors.push(`required_terms[${i}].plain_definition must be non-empty string`);
      });
    }
  }

  // 7. examples — array of strings, >=1, each >=30 chars.
  if ('examples' in lessonV2) {
    if (!Array.isArray(lessonV2.examples)) {
      errors.push('examples must be an array');
    } else if (lessonV2.examples.length < 1) {
      errors.push('examples must have >=1 entry');
    } else {
      lessonV2.examples.forEach((ex, i) => {
        if (typeof ex !== 'string') {
          errors.push(`examples[${i}] must be a string`);
        } else if (ex.length < 30) {
          errors.push(`examples[${i}] must be >=30 chars, got ${ex.length}`);
        }
      });
    }
  }

  // 8. common_misconceptions — array, >=1, each {wrong, why_wrong, correct}.
  if ('common_misconceptions' in lessonV2) {
    if (!Array.isArray(lessonV2.common_misconceptions)) {
      errors.push('common_misconceptions must be an array');
    } else if (lessonV2.common_misconceptions.length < 1) {
      errors.push('common_misconceptions must have >=1 entry');
    } else {
      lessonV2.common_misconceptions.forEach((m, i) => {
        if (!isPlainObject(m)) {
          errors.push(`common_misconceptions[${i}] must be an object`);
          return;
        }
        if (!isNonEmptyString(m.wrong)) errors.push(`common_misconceptions[${i}].wrong must be non-empty string`);
        if (!isNonEmptyString(m.why_wrong)) errors.push(`common_misconceptions[${i}].why_wrong must be non-empty string`);
        if (!isNonEmptyString(m.correct)) errors.push(`common_misconceptions[${i}].correct must be non-empty string`);
      });
    }
  }

  // 9. note_pack_connections — array (>=0), each {ref_type in enum, ref_id, why_relevant}.
  if ('note_pack_connections' in lessonV2) {
    if (!Array.isArray(lessonV2.note_pack_connections)) {
      errors.push('note_pack_connections must be an array');
    } else {
      lessonV2.note_pack_connections.forEach((c, i) => {
        if (!isPlainObject(c)) {
          errors.push(`note_pack_connections[${i}] must be an object`);
          return;
        }
        if (!VALID_REF_TYPES.includes(c.ref_type)) {
          errors.push(`note_pack_connections[${i}].ref_type must be one of ${VALID_REF_TYPES.join('|')}`);
        }
        if (!isNonEmptyString(c.ref_id)) errors.push(`note_pack_connections[${i}].ref_id must be non-empty string`);
        if (!isNonEmptyString(c.why_relevant)) errors.push(`note_pack_connections[${i}].why_relevant must be non-empty string`);
      });
    }
  }

  // 10. product_transfer — {triggered: bool, suggestion: string|null};
  //     if triggered === true, suggestion MUST be string >=20 chars.
  if ('product_transfer' in lessonV2) {
    const pt = lessonV2.product_transfer;
    if (!isPlainObject(pt)) {
      errors.push('product_transfer must be an object');
    } else {
      if (typeof pt.triggered !== 'boolean') {
        errors.push('product_transfer.triggered must be boolean');
      }
      if (pt.suggestion !== null && typeof pt.suggestion !== 'string') {
        errors.push('product_transfer.suggestion must be string or null');
      }
      if (pt.triggered === true) {
        if (typeof pt.suggestion !== 'string' || pt.suggestion.length < 20) {
          errors.push('product_transfer.suggestion must be string >=20 chars when triggered=true');
        }
      }
    }
  }

  // 11a. micro_proof — {stimulus, expected_signal, fail_mode} all strings.
  if ('micro_proof' in lessonV2) {
    const mp = lessonV2.micro_proof;
    if (!isPlainObject(mp)) {
      errors.push('micro_proof must be an object');
    } else {
      for (const k of REQUIRED_PROOF_KEYS) {
        if (!(k in mp)) errors.push(`micro_proof missing key: ${k}`);
        else if (typeof mp[k] !== 'string') errors.push(`micro_proof.${k} must be a string`);
      }
    }
  }

  // 11b. next_lesson_seed — string.
  if ('next_lesson_seed' in lessonV2 && typeof lessonV2.next_lesson_seed !== 'string') {
    errors.push('next_lesson_seed must be a string');
  }

  return errors;
}

module.exports = { validateLessonV2, REQUIRED_V2_KEYS };
