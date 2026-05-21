'use strict';

// W6.4 Curriculum Graph — test surface scaffold.
// intentional-placeholder: bodies deferred to jest harness wave per parent
// brief ("单元测试 placeholder ... test.todo() ≥ 14 项"). hypha repo has no
// jest runner wired yet (node --check + ad-hoc smokes only), so concrete
// bodies would dangle until the harness lands. test.todo() preserves the
// surface contract + lets jest discover them once installed.

describe('curriculum-graph · loadGraph', () => {
  test.todo('loadGraph returns AI/CS graph with 40-60 nodes');
  test.todo('loadGraph rejects seed JSON missing nodes array');
  test.todo('loadGraph rejects duplicate node ids');
  test.todo('loadGraph rejects unknown prereq references');
});

describe('curriculum-graph · findPath', () => {
  test.todo('findPath(py-basics, dl-transformer) returns a topologically-ordered list ending in dl-transformer');
  test.todo('findPath(null, target) returns the full prereq closure of target');
  test.todo('findPath returns null when fromKpId is not in toKpId closure');
  test.todo('findPath returns null when toKpId does not exist');
});

describe('curriculum-graph · recommendNextKP', () => {
  test.todo('recommendNextKP returns only nodes whose prereq_ids are all in masteredKpIds');
  test.todo('recommendNextKP sorts by (difficulty asc, layer order asc)');
  test.todo('recommendNextKP respects limit argument');
  test.todo('recommendNextKP returns [] when masteredKpIds covers the whole graph');
});

describe('curriculum-graph · kpForGoal', () => {
  test.todo('kpForGoal returns top-3 matches for a transformer-related goal');
  test.todo('kpForGoal returns [] for an off-domain goal (e.g. "knit a sweater")');
});

describe('curriculum-graph · getFrontierBridge', () => {
  test.todo('getFrontierBridge returns bridges + recommended_reading for dl-transformer');
  test.todo('getFrontierBridge returns null for unknown kpId');
});

describe('curriculum-graph · buildCustomCurriculum', () => {
  test.todo('buildCustomCurriculum emits 16-lesson plan for "build a RAG agent" goal');
  test.todo('buildCustomCurriculum trims merged closure when it exceeds targetTotalLessons');
  test.todo('buildCustomCurriculum extends with recommendNextKP when closure is shorter than target');
  test.todo('buildCustomCurriculum fails gracefully with NO_KP_MATCH when goal cannot be resolved');
});
