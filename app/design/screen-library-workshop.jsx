/* global React, Icon */
// intentional-placeholder: the literal word "placeholder" in the comment below
// describes the DELETED 2026-04 demo content that this file USED to contain.
// The current file is the final empty-state implementation requested by the
// user (2026-05-12 "最纯净 HYPHA"). No deferred work — WorkshopScreen renders
// a complete v0.5+ status card.
// HYPHA · Workshop — empty surface awaiting Track-A (course-as-product) +
// Track-B (notes → publishable) wiring. Demo "Sources you keep close" library
// + Sparks ledger + onboarding-wizard demo (2026-04 vintage) removed
// 2026-05-12 per user "最纯净 HYPHA" — no fake content. Real LibraryScreen
// now lives in screen-library.jsx; real OnboardingScreen in screen-onboarding.jsx.
//
// This file kept only to satisfy app.jsx route `case "sparks": return
// <WorkshopScreen onJump={setRoute} />` until Workshop System (BLUEPRINT
// System 4 Creation: Product Pool / Blueprint / Transfer / Spark / Decision
// Log) ships in v0.5+.

const WorkshopScreen = ({ onJump }) => (
  <div className="col gap-16 fade-in" style={{ padding: "48px 60px 60px", maxWidth: 880, margin: "0 auto" }}>
    <div className="col gap-6">
      <div className="eyebrow">Workshop</div>
      <h1 className="serif" style={{ fontSize: 34, margin: "4px 0 0", fontWeight: 400 }}>
        Where learning becomes <span className="italic">work</span>.
      </h1>
    </div>

    <div className="col gap-12" style={{
      marginTop: 18,
      padding: "26px 30px",
      background: "var(--cream)",
      border: "1px solid var(--rule-soft)",
      borderLeft: "2px solid var(--ochre, #A66D2C)",
      borderRadius: 2,
      fontFamily: 'EB Garamond, "Noto Serif SC", serif',
    }}>
      <div className="t-small" style={{ color: "var(--ink-3)", fontStyle: "italic", letterSpacing: ".08em" }}>
        v0.5+ · Creation System · BLUEPRINT §4
      </div>
      <p className="serif" style={{ fontSize: 16, lineHeight: 1.7, color: "var(--ink)", margin: 0 }}>
        Sparks 是学习要落成的产物。Workshop 把 lesson 的输出端 (产品 / 论文 / 笔记发布) 跟主线绑住。
      </p>
      <p className="serif" style={{ fontSize: 14, lineHeight: 1.65, color: "var(--ink-2)", margin: 0 }}>
        Product Pool · Blueprint · Transfer · Decision Log · Assumption Ledger · Kill Criteria · Roadmap Sync.
        当前未 ship — 等 Track A (课程=产品) 与 Track B (笔记+发布) v0.5 启时填进来。
      </p>
      <div className="row gap-12" style={{ marginTop: 4 }}>
        <button onClick={() => onJump && onJump("home")} className="btn btn-ghost" style={{ fontSize: 13 }}>
          回 Home
        </button>
        <button onClick={() => onJump && onJump("library")} className="btn btn-ghost" style={{ fontSize: 13 }}>
          先上传知识源 →
        </button>
      </div>
    </div>
  </div>
);

window.WorkshopScreen = WorkshopScreen;
