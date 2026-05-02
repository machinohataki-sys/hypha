// NavRail — right-rail two-region nav for the active note.
//
// Region 1 (top): TOC. Parses headings out of the note body. Click → smooth-
// scroll the rendered note to that heading. Empty if note has no headings —
// region collapses to 0 height.
//
// Region 2 (bottom): see-also. window.ptor.corpus.similar(rel, 3) returns
// up to 3 co-cited notes (event-log proxy until embeddings ship in v0.2).
// Empty state: italic "no companions yet". Click → onPick(rel).
//
// Both regions self-fetch on rel change. Empty rail (no headings + no
// companions) folds to 0 width via the `empty` flag returned to App.jsx.

// Parse ALL headings from body in document order. The caller handles
// display filtering — keeping parseHeadings stable means TOC indices map
// directly to marked's rendered <h1..h6> tag order in `.note-rendered`.
function parseHeadings(body) {
  if (!body) return [];
  const lines = body.split(/\r?\n/);
  const out = [];
  let inFence = false;
  let inFrontmatter = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (i === 0 && l.trim() === '---') { inFrontmatter = true; continue; }
    if (inFrontmatter) {
      if (l.trim() === '---') inFrontmatter = false;
      continue;
    }
    if (/^```/.test(l)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = l.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (m) out.push({ level: m[1].length, text: m[2].trim(), parsedIdx: out.length });
  }
  return out;
}

function NavRail({ rel, onPick }) {
  const [body, setBody] = React.useState('');
  const [similar, setSimilar] = React.useState([]);
  const [similarLoading, setSimilarLoading] = React.useState(false);
  const railRef = React.useRef(null);

  // One-shot diagnostic on first body load — verifies flex chain math.
  // Logs clientHeight (visible viewport) vs scrollHeight (total content).
  // If scrollHeight > clientHeight + a few px → scroll is working.
  // If they're equal but content visually clipped → flex chain still broken.
  React.useEffect(() => {
    if (!railRef.current || !body) return;
    const t = setTimeout(() => {
      const el = railRef.current;
      if (!el) return;
      console.log('[NavRail] geom client=' + el.clientHeight + ' scroll=' + el.scrollHeight + ' overflow=' + (el.scrollHeight - el.clientHeight));
    }, 200);
    return () => clearTimeout(t);
  }, [body]);

  // Pull body for TOC. Same vault.read NoteView calls — OS file cache makes
  // the duplicate cheap (~ms). Lifting state up was the alternative but
  // adds App-level coupling we don't need.
  React.useEffect(() => {
    setBody('');
    if (!rel || !window.ptor || !window.ptor.vault) return;
    let cancelled = false;
    window.ptor.vault.read(rel).then(res => {
      if (cancelled) return;
      setBody((res && res.body) || '');
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [rel]);

  React.useEffect(() => {
    setSimilar([]);
    if (!rel || !window.ptor || !window.ptor.corpus || !window.ptor.corpus.similar) return;
    setSimilarLoading(true);
    let cancelled = false;
    window.ptor.corpus.similar(rel, 3).then(res => {
      if (cancelled) return;
      setSimilar(Array.isArray(res) ? res : []);
      setSimilarLoading(false);
    }).catch(() => { if (!cancelled) setSimilarLoading(false); });
    return () => { cancelled = true; };
  }, [rel]);

  const allHeadings = React.useMemo(() => parseHeadings(body), [body]);

  // Display filter: skip leading H1 if it duplicates the note title (the
  // page already renders the title prominently). Each displayed heading
  // keeps its parsedIdx so the jump targets marked's Nth rendered <hN>.
  const displayHeadings = React.useMemo(() => {
    if (allHeadings.length === 0) return [];
    if (allHeadings[0].level === 1) return allHeadings.slice(1);
    return allHeadings;
  }, [allHeadings]);

  const onJump = React.useCallback((parsedIdx) => {
    const nodes = document.querySelectorAll(
      '.note-rendered h1, .note-rendered h2, .note-rendered h3, ' +
      '.note-rendered h4, .note-rendered h5, .note-rendered h6'
    );
    const target = nodes[parsedIdx];
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    // Elegant in-place pulse: text COLOR brightens to brass briefly, then
    // eases back to its natural CSS color. NO background fill — chrome
    // rectangles ("highlight box") read as web-app, not editorial. brass
    // inhabits the text itself, so the heading "lights up" the way ink
    // does when struck — natural, contained, 0 register pollution.
    // Two-stage: 200ms snap-on (brighten reads as pulse start) + 800ms
    // ease-out (settle reads as breath out, not as "stayed colored").
    target.style.transition = 'color 200ms cubic-bezier(0.22, 1, 0.36, 1)';
    target.style.color = 'var(--brass-bright)';
    setTimeout(() => {
      target.style.transition = 'color 800ms cubic-bezier(0.16, 1, 0.3, 1)';
      target.style.color = '';   // revert to CSS-inherited color
      setTimeout(() => { target.style.transition = ''; }, 850);
    }, 450);
  }, []);

  const tocVisible = displayHeadings.length > 0;
  const similarVisible = similar.length > 0 || similarLoading;
  const empty = !tocVisible && !similarVisible && !!rel;

  return (
    <div ref={railRef} style={{
      width: '100%', minWidth: 0,
      // flex: 1 + minHeight: 0 — this is the canonical "child of flex
      // container that wants to own its scroll" pattern. Parent (App.jsx
      // right-rail div) is now display:flex flexDirection:column with
      // min-height:0, so flex:1 here makes NavRail size to the parent's
      // visible area regardless of how much content is inside.
      // overflow:hidden auto on this div = THIS is where scroll lives.
      flex: 1,
      minHeight: 0,
      display: 'block',
      background: 'var(--glass-light)',
      backdropFilter: 'var(--glass-blur)',
      WebkitBackdropFilter: 'var(--glass-blur)',
      overflow: 'hidden auto',
      padding: '20px 16px 40px',
    }}>
      {!rel && (
        <div style={{
          fontFamily: '"EB Garamond", "Cormorant Garamond", Georgia, serif',
          fontStyle: 'italic', fontSize: 14, color: 'var(--ink-faint)',
          opacity: 0.7, lineHeight: 1.55,
        }}>
          open a note to see its sections + companions.
        </div>
      )}

      {/* Layout per Leo+Muse r2 synthesis (2026-04-28):
          - Single font family: EB Garamond italic throughout (no JBM, no roman)
          - Single style axis: size + indent (no weight shift, no opacity shift,
            no italic/roman flip)
          - Region labels REMOVED — structural distinction (TOC indents per
            heading depth, see-also doesn't) carries the visual contrast.
            Apple Reading List / Bear sidebar pattern: no "Items"/"Tags" label.
          - Single 0.5px brass-mid hairline separates the two regions.
          Title content (section titles, note titles) = italic per
          feedback_italic_decoration_only — italic = decoration register, and
          titles are decoration regardless of click affordance.
       */}
      {tocVisible && (
        <section style={{ marginBottom: 0 }}>
          <ol style={{
            listStyle: 'none', padding: 0, margin: 0,
            display: 'flex', flexDirection: 'column', gap: 4,
          }}>
            {displayHeadings.map((h, i) => (
              <li key={i}>
                <button
                  onClick={() => onJump(h.parsedIdx)}
                  style={{
                    background: 'transparent', border: 'none', cursor: 'pointer',
                    padding: '2px 0 2px ' + ((h.level - 1) * 14) + 'px',
                    textAlign: 'left', width: '100%',
                    fontFamily: '"EB Garamond", "Noto Serif SC", serif',
                    fontStyle: 'italic',
                    fontSize:
                      h.level === 2 ? 14.5 :
                      h.level === 3 ? 13.5 :
                      h.level === 4 ? 12.5 : 12,
                    fontWeight: 500,
                    lineHeight: 1.45,
                    color: 'var(--ink-primary)',
                    letterSpacing: '0.005em',
                    transition: 'color 180ms',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.color = 'var(--brass-bright)'; }}
                  onMouseLeave={e => { e.currentTarget.style.color = 'var(--ink-primary)'; }}
                >{h.text}</button>
              </li>
            ))}
          </ol>
        </section>
      )}

      {/* Hairline divider — only when both regions present */}
      {tocVisible && similarVisible && (
        <hr style={{
          border: 'none',
          height: '0.5px',
          background: 'color-mix(in srgb, var(--brass-mid) 32%, transparent)',
          margin: '20px 0 18px',
        }} />
      )}

      {similarVisible && (
        <section>
          {similarLoading && similar.length === 0 ? (
            <div style={{
              fontFamily: '"EB Garamond", serif', fontStyle: 'italic',
              fontSize: 13, color: 'var(--ink-faint)', opacity: 0.6,
              padding: '4px 2px',
            }}>looking…</div>
          ) : (
            <ol style={{
              listStyle: 'none', padding: 0, margin: 0,
              display: 'flex', flexDirection: 'column', gap: 6,
            }}>
              {similar.map((s, i) => {
                const fileName = (s.rel.split('/').pop() || s.rel).replace(/\.md$/i, '');
                return (
                  <li key={i}>
                    <button
                      onClick={() => onPick && onPick(s.rel)}
                      style={{
                        background: 'transparent', border: 'none', cursor: 'pointer',
                        padding: '4px 0', textAlign: 'left', width: '100%',
                        fontFamily: '"EB Garamond", "Noto Serif SC", serif',
                        fontStyle: 'italic', fontSize: 14, fontWeight: 500,
                        lineHeight: 1.42,
                        color: 'var(--ink-primary)',
                        letterSpacing: '0.005em',
                        transition: 'color 180ms',
                      }}
                      onMouseEnter={e => { e.currentTarget.style.color = 'var(--brass-bright)'; }}
                      onMouseLeave={e => { e.currentTarget.style.color = 'var(--ink-primary)'; }}
                    >{fileName.replace(/[_-]+/g, ' ')}</button>
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      )}

      {empty && (
        <div style={{
          fontFamily: '"EB Garamond", "Cormorant Garamond", Georgia, serif',
          fontStyle: 'italic', fontSize: 13, color: 'var(--ink-faint)',
          opacity: 0.55, lineHeight: 1.55,
          // Empty case is the ONLY child; no need for marginTop:auto pushdown.
          paddingTop: 8,
        }}>
          no sections, no companions yet — write more, agents will start citing.
        </div>
      )}
    </div>
  );
}

Object.assign(window, { NavRail });
