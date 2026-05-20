'use strict';

// W3.6 Companion Triggers — test surface scaffold.
// intentional-placeholder: bodies deferred to W3.6.1 calibration pass per
// brief ("单元测试 placeholder ... test.todo() ≥ 12 项"). hypha repo has no
// jest runner wired yet (only node --check + ad-hoc smokes), so concrete
// bodies would dangle until the test harness lands. test.todo() preserves
// the surface contract + lets jest discover them once installed. Detection
// functions are pure → trivial to fill in; dispatch tests need a tmp
// HYPHA_VAULT_ROOT to verify companion-fired.json sidecar writes.

describe('companion-triggers · pure detection', () => {
  test.todo('detectLessonComplete returns true when harness overall_pass=true');
  test.todo('detectLessonComplete returns false for missing slug or null harnessResult');
  test.todo('detectInterruptResume fires at exactly 3-day boundary (≥ INTERRUPT_DAYS_MIN)');
  test.todo('detectInterruptResume returns false when lastLessonAt is null (no prior activity)');
  test.todo('detectOverGrind fires when lessonsLast24h >= OVER_GRIND_LESSONS_24H');
  test.todo('detectOverGrind fires on consecutiveNoRest path even with lessonsLast24h=0');
  test.todo('detectFinishCapture accepts both "completed" and "done" stage labels');
  test.todo('detectSparkSprout requires exact seed → considered (not seed → killed)');
});

describe('companion-triggers · dispatch + dedupe', () => {
  test.todo('dispatchTrigger writes companion-fired.json entry on first fire');
  test.todo('dispatchTrigger skips identical (slug, type, key) on second fire (dedupe)');
  test.todo('dispatchTrigger is record-first (entry exists even if W3.5 throws)');
});

describe('companion-triggers · cadence wrapper', () => {
  test.todo('computeCadenceWithCompanion returns base decision unchanged on no over_grind');
  test.todo('computeCadenceWithCompanion fires over_grind once per day (day-keyed dedupe)');
  test.todo('computeCadenceWithCompanion preserves cadence_mode + ratios + kp_coefficient fields');
});
