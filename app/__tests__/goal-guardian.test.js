'use strict';

/**
 * HYPHA · W2.3 Goal Guardian + Affective Router — test placeholders.
 *
 * Per specs/goal-guardian.md §9. Real implementation deferred to W2.3.1
 * (T4_JUDGE二判 wiring + cross-language fixtures). The placeholders below
 * mark every behavior we plan to cover so the next pass has a checklist
 * rather than a green field. `test.todo` keeps CI quiet today + visible
 * tomorrow.
 *
 * Run when wired: `npx jest app/__tests__/goal-guardian.test.js`
 */

const router = require('../lib/affective-router');
const guardian = require('../lib/goal-guardian');

describe('affective-router · extractAffect', () => {
  test.todo('frustration_marker hits on "我完全不懂这个, 算了我放弃了"');
  test.todo('doubt_marker hits on short "我是不是太笨了"');
  test.todo('spark_marker + high_energy_marker on "我想到了一个新例子!"');
  test.todo('sentiment stays in [-1, 1] for stacked negative cues');
  test.todo('energy crosses 0.5 on long expressive turn (≥60 char + 多 !)');
  test.todo('energy < 0.3 on silent ≤6-char turn ("嗯")');
  test.todo('banned AI cliché ("yyds") does NOT count as high_energy_marker');
  test.todo('agreement_marker telemetry-only, does not trigger action');
});

describe('goal-guardian · assessGuardianState', () => {
  test.todo('returns on_track when signals are empty + score trajectory steady');
  test.todo('frustration_marker → state=frustrated + lower_difficulty');
  test.todo('explicit mood "frustrated" override beats regex (confidence 0.8)');
  test.todo('two consecutive off-topic turns + lesson concepts → distracted');
  test.todo('one off-topic turn → drifting (gentle_pullback)');
  test.todo('sustained low score trajectory (3× < 50) → frustrated even w/o cue');
  test.todo('missing goalContract degrades to affect-only (guardian_action=null)');
});

describe('goal-guardian · decideIntervention', () => {
  test.todo('frustrated → lower_difficulty + difficulty_adjust=-1 + ConfusionRepair');
  test.todo('high_energy → capture_spark + difficulty unchanged + downstream_repair=null');
  test.todo('self_doubt prompt_modifier bans cheerleading / "great question"');
  test.todo('on_track returns empty modifier + 0 adjust');
});

describe('integration shape sanity (runs today as smoke)', () => {
  it('extractAffect frustration sample yields expected signals', () => {
    const a = router.extractAffect('我完全不懂这个, 算了我放弃了');
    expect(Array.isArray(a.signals)).toBe(true);
    expect(a.signals).toEqual(expect.arrayContaining(['frustration_marker']));
    expect(a.sentiment).toBeLessThanOrEqual(0);
  });
  it('extractAffect spark sample yields spark + high_energy', () => {
    const a = router.extractAffect('我想到了一个新例子!');
    expect(a.signals).toEqual(expect.arrayContaining(['spark_marker']));
    expect(a.signals).toEqual(expect.arrayContaining(['high_energy_marker']));
    expect(a.sentiment).toBeGreaterThan(0);
  });
  it('assessGuardianState returns 6-state enum shape', () => {
    const r = guardian.assessGuardianState({
      userTrace: { recentTurns: [{ role: 'user', text: '我不懂' }] },
      goalContract: { north_star_goal: 'understand X' },
    });
    expect(['on_track', 'drifting', 'frustrated', 'self_doubt', 'distracted', 'high_energy']).toContain(r.state);
    expect(typeof r.confidence).toBe('number');
  });
  it('decideIntervention frustrated path emits prompt_modifier + diff=-1', () => {
    const i = guardian.decideIntervention('frustrated', { thesis: 'X 是 Y' });
    expect(i.difficulty_adjust).toBe(-1);
    expect(typeof i.prompt_modifier).toBe('string');
    expect(i.prompt_modifier.length).toBeGreaterThan(20);
  });
});
