/* global React */
// HYPHA · Product Pool list (BLUEPRINT §11.1).
//
// 2026-05-13 — 工具 → 产品蓝图 进入此屏 (不是直接编辑器). 屏列出 vault-level
// 所有产品 (HYPHA / 论文 / 小说 / ...), 不依赖任何 curriculum slug — 产品和
// 课程是两个轴, 在 Deepen / Lesson / Note 完成时通过 Product Transfer 交叉。
//
// 列表为空 → 显 PreconditionEmpty-style 卡 + 创建第一个产品 CTA。
// 列表非空 → 行渲染 (name / type / northStar / lastUpdated) + 新建产品 CTA。
// 点击行 → 进入 ProductBlueprintScreen w/ productId prop。
//
// Props: { onBack, onOpenProduct(productId) }

const { useState, useEffect, useCallback } = React;

const PRODUCT_TYPES = [
  { id: 'product',         label: '产品 · SaaS / 消费 / 硬件' },
  { id: 'thesis',          label: '论文 · academic thesis' },
  { id: 'novel',           label: '小说 · fiction / serialized' },
  { id: 'research',        label: '研究项目 · research program' },
  { id: 'website',         label: '网站 · marketing / portfolio' },
  { id: 'course',          label: '课程 · 你正在 BUILDING 的 course' },
  { id: 'personal_brand',  label: '个人品牌 · Twitter / Substack / talks' },
  { id: 'opensource',      label: '开源项目 · OSS library' },
  { id: 'business',        label: '商业计划 · business plan' },
  { id: 'exam_prep',       label: '考试备考 · long-arc prep' },
];

const ProductListScreen = ({ onBack, onOpenProduct }) => {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState('product');
  const [newNorthStar, setNewNorthStar] = useState('');
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await (window.ptor && window.ptor.product && window.ptor.product.list());
      if (r && r.ok) setProducts(r.products || []);
      else setError(r && r.error ? r.error : '加载失败');
    } catch (e) { setError(String(e && e.message || e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const onCreate = async () => {
    setError(null);
    if (!newName.trim()) { setError('请填产品名'); return; }
    setCreating(true);
    try {
      const r = await window.ptor.product.create({
        name: newName.trim(),
        type: newType,
        northStar: newNorthStar.trim(),
      });
      if (!r || !r.ok) {
        setError(r && r.error ? r.error : '创建失败');
      } else {
        setNewName(''); setNewType('product'); setNewNorthStar('');
        setShowCreateForm(false);
        await refresh();
        if (r.product && r.product.productId && typeof onOpenProduct === 'function') {
          onOpenProduct(r.product.productId);
        }
      }
    } catch (e) { setError(String(e && e.message || e)); }
    finally { setCreating(false); }
  };

  return (
    <div style={{
      maxWidth: 880, margin: '0 auto', padding: '40px 36px 64px',
      fontFamily: 'EB Garamond, "Noto Serif SC", serif', color: 'var(--ink)',
    }}>
      <header style={{
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
        marginBottom: 28, paddingBottom: 14,
        borderBottom: '1px solid var(--rule-soft)',
      }}>
        <h1 className="serif italic" style={{
          fontSize: 32, fontWeight: 400, margin: 0, letterSpacing: '0.01em',
        }}>
          产品池 · Product Pool
        </h1>
        {onBack && (
          <button
            onClick={onBack}
            className="mono"
            style={{
              fontSize: 10, letterSpacing: '0.16em', textTransform: 'uppercase',
              border: 'none', background: 'none', color: 'var(--ink-3)', cursor: 'pointer',
              padding: '4px 0',
            }}
          >← 返回</button>
        )}
      </header>

      <p style={{
        fontSize: 15, fontStyle: 'italic', color: 'var(--ink-3)',
        lineHeight: 1.6, marginTop: 0, marginBottom: 28,
      }}>
        每件你正在创造的东西 — 产品 / 论文 / 小说 / 网站 / 研究项目 — 都可以放进来。
        课程里学到的, 会在 Deepen 时自动检视相关性, 把启发追加到对应产品的灵感池。
        产品与课程不绑定: 一个产品可被多门课影响, 一门课也可启发多个产品。
      </p>

      {error && (
        <div style={{
          padding: '12px 16px', marginBottom: 20,
          background: 'rgba(180,60,40,0.06)',
          border: '1px solid rgba(180,60,40,0.20)',
          fontSize: 13, color: 'var(--ink-2)', fontStyle: 'italic',
        }}>{error}</div>
      )}

      {loading ? (
        <div style={{ fontSize: 14, fontStyle: 'italic', color: 'var(--ink-3)' }}>加载中…</div>
      ) : products.length === 0 && !showCreateForm ? (
        <div style={{
          padding: '32px 0', textAlign: 'left',
        }}>
          <div className="serif italic" style={{
            fontSize: 22, fontWeight: 400, color: 'var(--ink-1)',
            marginBottom: 10,
          }}>这扇门还差一步</div>
          <p style={{ fontSize: 15, color: 'var(--ink-2)', fontStyle: 'italic', lineHeight: 1.7, marginBottom: 18 }}>
            还没有创造物。先建第一个 — 它可以是产品 / 论文 / 小说 / 网站 / 任何你想做出来的东西。
            建好后, 学的每节课都会经过它一次, 看有没有可迁移的启发。
          </p>
          <button
            onClick={() => setShowCreateForm(true)}
            style={{
              padding: '8px 18px',
              fontFamily: 'EB Garamond, serif', fontStyle: 'italic', fontSize: 14,
              color: 'var(--paper, #faf6e8)',
              background: 'var(--accent-brass, #b08a3e)',
              border: '1px solid var(--accent-brass, #b08a3e)',
              borderRadius: 2, cursor: 'pointer',
              letterSpacing: '0.04em',
            }}>+ 创建第一个产品</button>
        </div>
      ) : (
        <div className="col gap-8" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {products.map((p) => (
            <button
              key={p.productId}
              onClick={() => typeof onOpenProduct === 'function' && onOpenProduct(p.productId)}
              style={{
                width: '100%', textAlign: 'left', cursor: 'pointer',
                padding: '16px 20px',
                background: 'rgba(244,239,228,0.40)',
                border: '1px solid var(--rule-soft)',
                borderLeft: '3px solid var(--accent-brass, #b08a3e)',
                borderRadius: 2,
                display: 'flex', alignItems: 'baseline', gap: 16,
                fontFamily: 'inherit',
              }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="serif" style={{
                  fontSize: 18, lineHeight: 1.3, color: 'var(--ink-1)', fontWeight: 500,
                  marginBottom: 4,
                }}>{p.name}</div>
                {p.northStar && (
                  <div style={{ fontSize: 13, fontStyle: 'italic', color: 'var(--ink-2)', marginBottom: 4 }}>
                    {p.northStar}
                  </div>
                )}
                <div className="mono" style={{
                  fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.06em',
                }}>
                  {p.type} · 最近 {new Date(p.lastUpdated || p.createdAt).toLocaleDateString()}
                </div>
              </div>
              <span className="mono" style={{
                fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase',
                color: 'var(--ink-3)',
              }}>打开 →</span>
            </button>
          ))}
        </div>
      )}

      {!showCreateForm && products.length > 0 && (
        <div style={{ marginTop: 28 }}>
          <button
            onClick={() => setShowCreateForm(true)}
            style={{
              padding: '8px 18px',
              fontFamily: 'EB Garamond, serif', fontStyle: 'italic', fontSize: 14,
              color: 'var(--ink-2)',
              background: 'transparent',
              border: '1px solid var(--rule-soft)',
              borderRadius: 2, cursor: 'pointer',
              letterSpacing: '0.04em',
            }}>+ 再建一个</button>
        </div>
      )}

      {showCreateForm && (
        <div style={{
          marginTop: 28, padding: '20px 22px',
          border: '1px solid var(--rule-soft)',
          background: 'rgba(244,239,228,0.40)', borderRadius: 2,
          display: 'flex', flexDirection: 'column', gap: 14,
        }}>
          <div className="mono" style={{
            fontSize: 10, letterSpacing: '0.16em', textTransform: 'uppercase',
            color: 'var(--ink-3)',
          }}>新产品</div>
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            autoFocus
            style={{
              fontFamily: 'EB Garamond, serif', fontSize: 22, fontStyle: 'italic',
              color: 'var(--ink-1)', background: 'transparent',
              border: 'none', borderBottom: '1px solid var(--rule-soft)',
              outline: 'none', padding: '4px 0',
            }}
            /* intentional-placeholder: HTML placeholder= attribute = real UX hint shown
               when input is empty, not a TODO marker. anti-lazy-detector matches the word. */
            placeholder="产品名 (HYPHA / 一本小说 / 一个网站 …)"
          />
          <select
            value={newType}
            onChange={(e) => setNewType(e.target.value)}
            style={{
              fontFamily: 'EB Garamond, serif', fontSize: 14, fontStyle: 'italic',
              color: 'var(--ink-2)', background: 'transparent',
              border: '1px solid var(--rule-soft)', borderRadius: 2,
              padding: '6px 10px', cursor: 'pointer',
            }}>
            {PRODUCT_TYPES.map(t => (
              <option key={t.id} value={t.id}>{t.label}</option>
            ))}
          </select>
          <input
            type="text"
            value={newNorthStar}
            onChange={(e) => setNewNorthStar(e.target.value)}
            style={{
              fontFamily: 'EB Garamond, serif', fontSize: 15, fontStyle: 'italic',
              color: 'var(--ink-1)', background: 'transparent',
              border: 'none', borderBottom: '1px solid var(--rule-soft)',
              outline: 'none', padding: '4px 0',
            }}
            /* intentional-placeholder: HTML placeholder= attribute = real UX hint. */
            placeholder="北极星 · 一句话: 这个产品最终要改变什么? (可空, 进编辑器再填)"
          />
          <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
            <button
              onClick={onCreate}
              disabled={creating || !newName.trim()}
              style={{
                padding: '8px 18px',
                fontFamily: 'EB Garamond, serif', fontStyle: 'italic', fontSize: 14,
                color: 'var(--paper, #faf6e8)',
                background: 'var(--accent-brass, #b08a3e)',
                border: '1px solid var(--accent-brass, #b08a3e)',
                borderRadius: 2,
                cursor: creating ? 'wait' : (newName.trim() ? 'pointer' : 'not-allowed'),
                opacity: (creating || !newName.trim()) ? 0.6 : 1,
                letterSpacing: '0.04em',
              }}>{creating ? '创建中…' : '+ 创建产品'}</button>
            <button
              onClick={() => { setShowCreateForm(false); setError(null); }}
              disabled={creating}
              style={{
                padding: '8px 18px',
                fontFamily: 'EB Garamond, serif', fontStyle: 'italic', fontSize: 14,
                color: 'var(--ink-2)',
                background: 'transparent',
                border: '1px solid var(--rule-soft)',
                borderRadius: 2, cursor: 'pointer',
                letterSpacing: '0.04em',
              }}>取消</button>
          </div>
        </div>
      )}
    </div>
  );
};

if (typeof window !== 'undefined') {
  window.ProductListScreen = ProductListScreen;
}
