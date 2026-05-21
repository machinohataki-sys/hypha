'use strict';
// Smoke verify for v1.0 boot-9 — Companion T2_LOCAL scaffold.
//
// 11 cases (CL1-CL11). Exit 0 on all-pass, 1 on any fail. No external deps.
// Mirrors _dev_verify_emotion_tone_bridge.js style.
//
// Falsifiers:
//   - local-model.js exports the contract surface
//   - initLocalModel({lazy:true}) returns ready:false when capability disabled
//   - getModelStatus returns the expected shape
//   - generateLocal throws LOCAL_MODEL_NOT_READY when not ready
//   - downloadModel returns not_implemented_v1.0
//   - Router DISPATCH_POLICY exposes T2_LOCAL
//   - executeChat('T2_LOCAL') with stub provider survives — local-first
//     short-circuits when T2_LOCAL_AVAILABLE=false, cloud chain takes over
//   - tone-engine still emits canonical mock template after the T2_LOCAL
//     probe (regression: emotion-tone-bridge / emotion-state stay green)
//   - Settings UI grep finds the new section
//   - Preload bridge exposes companion.localStatus + companion.localDownload
//   - main.js registers companion:local-status + companion:local-download

const fs   = require('node:fs');
const path = require('node:path');

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  const tag = pass ? 'PASS' : 'FAIL';
  // eslint-disable-next-line no-console
  console.log(`[${tag}] ${name}${detail ? ' — ' + detail : ''}`);
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

(async () => {
  // ── CL1: local-model.js exports the contract surface ──────────────────
  let localModel;
  try {
    localModel = require(path.join(__dirname, '..', 'lib', 'companion', 'local-model'));
    const want = [
      'initLocalModel', 'generateLocal', 'getModelStatus',
      'downloadModel', 'unloadModel',
      'T2_LOCAL_AVAILABLE', 'LocalModelNotReadyError',
    ];
    for (const k of want) {
      assert(k in localModel, `missing export ${k}`);
    }
    record('CL1: local-model exports the contract surface', true);
  } catch (e) {
    record('CL1: local-model exports the contract surface', false, e.message);
  }

  // ── CL2: initLocalModel returns ready:false when model absent ─────────
  try {
    localModel._resetState();
    const r = localModel.initLocalModel({
      model_path: path.join(__dirname, 'no-such-model.gguf'),
      lazy:       true,
    });
    assert(r.ready === false, `ready=${r.ready}`);
    assert(typeof r.reason === 'string' && r.reason.length > 0, `reason=${r.reason}`);
    assert(typeof r.path === 'string' && r.path.length > 0, `path=${r.path}`);
    record('CL2: initLocalModel returns ready:false when capability disabled', true);
  } catch (e) {
    record('CL2: initLocalModel returns ready:false when capability disabled', false, e.message);
  }

  // ── CL3: getModelStatus returns the expected shape ─────────────────────
  try {
    localModel._resetState();
    const s = localModel.getModelStatus();
    const want = ['ready', 'model_name', 'model_size_mb', 'ram_available_mb', 'expected_path'];
    for (const k of want) {
      assert(k in s, `missing key ${k}`);
    }
    assert(s.ready === false, `ready=${s.ready}`);
    assert(typeof s.model_name === 'string' && s.model_name.length > 0, 'model_name');
    assert(typeof s.model_size_mb === 'number' && s.model_size_mb > 0, 'model_size_mb');
    assert(s.capability_available === false, `capability_available=${s.capability_available}`);
    record('CL3: getModelStatus returns expected shape', true);
  } catch (e) {
    record('CL3: getModelStatus returns expected shape', false, e.message);
  }

  // ── CL4: generateLocal throws LOCAL_MODEL_NOT_READY when not ready ────
  try {
    localModel._resetState();
    let caught = null;
    try {
      await localModel.generateLocal({ prompt: 'hello', max_tokens: 5 });
    } catch (err) {
      caught = err;
    }
    assert(caught != null, 'expected throw');
    assert(caught.code === 'LOCAL_MODEL_NOT_READY', `code=${caught && caught.code}`);
    assert(caught.name === 'LocalModelNotReadyError', `name=${caught && caught.name}`);
    record('CL4: generateLocal throws LOCAL_MODEL_NOT_READY when not ready', true);
  } catch (e) {
    record('CL4: generateLocal throws LOCAL_MODEL_NOT_READY when not ready', false, e.message);
  }

  // ── CL5: downloadModel returns not_implemented_v1.0 ────────────────────
  try {
    const r = await localModel.downloadModel({});
    assert(r.ok === false, `ok=${r.ok}`);
    assert(r.status === 'not_implemented_v1.0', `status=${r.status}`);
    assert(typeof r.message === 'string' && r.message.length > 0, 'message');
    record('CL5: downloadModel returns not_implemented_v1.0', true);
  } catch (e) {
    record('CL5: downloadModel returns not_implemented_v1.0', false, e.message);
  }

  // ── CL6: Router DISPATCH_POLICY registers T2_LOCAL ─────────────────────
  try {
    const router = require(path.join(__dirname, '..', 'lib', 'llm', 'router'));
    assert(router.DISPATCH_POLICY && Array.isArray(router.DISPATCH_POLICY.T2_LOCAL),
      'T2_LOCAL not in DISPATCH_POLICY');
    assert(router.DISPATCH_POLICY.T2_LOCAL.length >= 1, 'T2_LOCAL chain empty');
    // pickWeighted should pick a cloud provider for T2_LOCAL (since locals
    // aren't dispatched via pickWeighted — they go through _routeLocalFirst).
    const pick = router.pickWeighted('T2_LOCAL', []);
    assert(pick && typeof pick.providerId === 'string', 'pickWeighted gave nothing');
    record('CL6: Router DISPATCH_POLICY registers T2_LOCAL with cloud fallback', true);
  } catch (e) {
    record('CL6: Router DISPATCH_POLICY registers T2_LOCAL with cloud fallback', false, e.message);
  }

  // ── CL7: Cloud-path regression — executeChat('T3_MID') unchanged ──────
  // We monkey-patch the provider getter to a deterministic stub so we don't
  // hit a network. Verifies the local-first short-circuit doesn't break the
  // existing cloud dispatch path for non-T2 capabilities.
  try {
    const llmIndex = require(path.join(__dirname, '..', 'lib', 'llm'));
    const origGet = llmIndex.getProvider;
    const stubProvider = {
      async chatWithUsage() { return { content: 'cloud-ok', usage: { input_tokens: 1, output_tokens: 1 } }; },
      async chat()          { return { content: 'pong' }; },
    };
    llmIndex.getProvider = () => stubProvider;
    try {
      const r = await llmIndex.executeChat('T3_MID', {
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 5,
      });
      assert(r && r.result === 'cloud-ok', `cloud path result=${r && r.result}`);
      assert(r.capability === 'T3_MID', 'capability mismatch');
    } finally {
      llmIndex.getProvider = origGet;
    }
    record('CL7: T3_MID cloud-path regression — executeChat unchanged', true);
  } catch (e) {
    record('CL7: T3_MID cloud-path regression — executeChat unchanged', false, e.message);
  }

  // ── CL8: T2_LOCAL dispatch falls through to cloud (transparent) ────────
  // With T2_LOCAL_AVAILABLE=false, _routeLocalFirst returns null and the
  // cloud chain handles the request. The user/caller sees a normal envelope.
  try {
    const llmIndex = require(path.join(__dirname, '..', 'lib', 'llm'));
    const origGet = llmIndex.getProvider;
    const stubProvider = {
      async chatWithUsage() { return { content: 'cloud-fallback', usage: null }; },
      async chat()          { return { content: 'pong' }; },
    };
    llmIndex.getProvider = () => stubProvider;
    try {
      const r = await llmIndex.executeChat('T2_LOCAL', {
        messages: [{ role: 'user', content: 'companion thought' }],
        maxTokens: 5,
      });
      assert(r && r.result === 'cloud-fallback', `T2_LOCAL fallback result=${r && r.result}`);
      assert(r.providerId !== 'local-gemma', `providerId=${r.providerId} should be cloud, not local`);
    } finally {
      llmIndex.getProvider = origGet;
    }
    record('CL8: T2_LOCAL dispatch falls through to cloud transparently', true);
  } catch (e) {
    record('CL8: T2_LOCAL dispatch falls through to cloud transparently', false, e.message);
  }

  // ── CL9: tone-engine generateExpression still emits canonical mock ────
  // After the T2_LOCAL probe (which short-circuits because capability is
  // disabled), generateExpression must keep returning MOCK_TEMPLATES[trig][0].
  try {
    const tone = require(path.join(__dirname, '..', 'lib', 'companion', 'tone-engine'));
    const out = await tone.generateExpression('lesson_complete', {});
    const expected = tone.MOCK_TEMPLATES.lesson_complete[0];
    assert(out === expected, `got ${JSON.stringify(out)} expected ${JSON.stringify(expected)}`);
    record('CL9: tone-engine still emits canonical mock after T2_LOCAL probe', true);
  } catch (e) {
    record('CL9: tone-engine still emits canonical mock after T2_LOCAL probe', false, e.message);
  }

  // ── CL10: Settings UI grep — LocalModelPanel + 本地模型 + 4 GB 模型 ───
  try {
    const ui = fs.readFileSync(
      path.join(__dirname, '..', 'design', 'screen-ux-settings.jsx'),
      'utf8',
    );
    assert(ui.includes('LocalModelPanel'), 'LocalModelPanel symbol missing');
    assert(ui.includes('Companion 本地模型 · 未下载'),
      '"Companion 本地模型 · 未下载" status string missing');
    assert(/下载\s*\{?[^}]*\}?\s*GB\s*模型/.test(ui), '"下载 X GB 模型" button missing');
    assert(ui.includes('需要 8 GB 内存'), '"需要 8 GB 内存" note missing');
    assert(ui.includes('v1.1+'), 'v1.1+ marker missing');
    record('CL10: Settings UI surfaces LocalModelPanel section', true);
  } catch (e) {
    record('CL10: Settings UI surfaces LocalModelPanel section', false, e.message);
  }

  // ── CL11: preload + main wire companion:local-status + local-download ─
  try {
    const preload = fs.readFileSync(
      path.join(__dirname, '..', 'preload.js'),
      'utf8',
    );
    assert(preload.includes("ipcRenderer.invoke('companion:local-status')"),
      'preload missing companion:local-status invoke');
    assert(preload.includes("ipcRenderer.invoke('companion:local-download')"),
      'preload missing companion:local-download invoke');
    assert(preload.includes('localStatus:'),   'preload missing localStatus accessor');
    assert(preload.includes('localDownload:'), 'preload missing localDownload accessor');

    const main = fs.readFileSync(
      path.join(__dirname, '..', 'main.js'),
      'utf8',
    );
    assert(main.includes("ipcMain.handle('companion:local-status'"),
      'main missing ipcMain handler for companion:local-status');
    assert(main.includes("ipcMain.handle('companion:local-download'"),
      'main missing ipcMain handler for companion:local-download');

    record('CL11: preload + main register companion:local-status / -download', true);
  } catch (e) {
    record('CL11: preload + main register companion:local-status / -download', false, e.message);
  }

  // ── Summary ────────────────────────────────────────────────────────────
  const passed = results.filter((r) => r.pass).length;
  const total  = results.length;
  // eslint-disable-next-line no-console
  console.log(`\n[summary] ${passed}/${total} passed`);
  process.exit(passed === total ? 0 : 1);
})().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('[fatal]', e);
  process.exit(1);
});
