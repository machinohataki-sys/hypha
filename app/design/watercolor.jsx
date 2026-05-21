/* global React */
// Watercolor art + iconography for HYPHA

const Watercolor = {
  // Mycelial network on parchment — the home hero
  Mycelium: ({ seed = 1, opacity = 1 }) => {
    const id = `wc-${seed}`;
    return (
      <svg className="wc" viewBox="0 0 1200 600" preserveAspectRatio="xMidYMid slice" style={{ opacity }}>
        <defs>
          <radialGradient id={`${id}-sage`} cx="22%" cy="35%" r="32%">
            <stop offset="0%" stopColor="#7a9482" stopOpacity=".55" />
            <stop offset="60%" stopColor="#a7b8a3" stopOpacity=".18" />
            <stop offset="100%" stopColor="#a7b8a3" stopOpacity="0" />
          </radialGradient>
          <radialGradient id={`${id}-ochre`} cx="68%" cy="28%" r="30%">
            <stop offset="0%" stopColor="#d49b4b" stopOpacity=".55" />
            <stop offset="55%" stopColor="#e2b878" stopOpacity=".22" />
            <stop offset="100%" stopColor="#e2b878" stopOpacity="0" />
          </radialGradient>
          <radialGradient id={`${id}-terra`} cx="32%" cy="78%" r="32%">
            <stop offset="0%" stopColor="#c1714f" stopOpacity=".5" />
            <stop offset="60%" stopColor="#d59b82" stopOpacity=".18" />
            <stop offset="100%" stopColor="#d59b82" stopOpacity="0" />
          </radialGradient>
          <radialGradient id={`${id}-indigo`} cx="78%" cy="78%" r="34%">
            <stop offset="0%" stopColor="#5e7290" stopOpacity=".5" />
            <stop offset="55%" stopColor="#8c9bb1" stopOpacity=".18" />
            <stop offset="100%" stopColor="#8c9bb1" stopOpacity="0" />
          </radialGradient>
          <filter id={`${id}-grain`} x="-10%" y="-10%" width="120%" height="120%">
            <feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2" seed={seed} />
            <feColorMatrix values="0 0 0 0 0   0 0 0 0 0   0 0 0 0 0   0 0 0 .25 0" />
            <feComposite in2="SourceGraphic" operator="in" />
          </filter>
        </defs>
        {/* Color washes */}
        <ellipse cx="280" cy="220" rx="260" ry="170" fill={`url(#${id}-sage)`} />
        <ellipse cx="820" cy="180" rx="260" ry="170" fill={`url(#${id}-ochre)`} />
        <ellipse cx="380" cy="460" rx="280" ry="170" fill={`url(#${id}-terra)`} />
        <ellipse cx="900" cy="470" rx="270" ry="170" fill={`url(#${id}-indigo)`} />
        {/* Grain */}
        <rect width="1200" height="600" filter={`url(#${id}-grain)`} opacity=".5" />
        {/* Mycelial threads */}
        <g stroke="#3a443d" strokeOpacity=".35" fill="none" strokeWidth="0.6">
          <path d="M 600 300 Q 480 250 320 220 T 120 200" />
          <path d="M 600 300 Q 720 240 880 200 T 1080 180" />
          <path d="M 600 300 Q 500 380 380 460 T 180 520" />
          <path d="M 600 300 Q 740 380 880 460 T 1080 520" />
          <path d="M 600 300 Q 600 200 580 120" />
          <path d="M 600 300 Q 620 420 640 520" />
          <path d="M 320 220 Q 380 300 480 320" />
          <path d="M 880 200 Q 800 290 700 320" />
          <path d="M 380 460 Q 460 400 540 360" />
          <path d="M 880 460 Q 800 400 700 360" />
        </g>
        {/* Nodes */}
        <g fill="#3a443d">
          {[
          [600, 300, 5], [320, 220, 3.5], [880, 200, 3.5], [380, 460, 3.5], [880, 460, 3.5],
          [120, 200, 2.5], [1080, 180, 2.5], [180, 520, 2.5], [1080, 520, 2.5], [580, 120, 2.5],
          [640, 520, 2.5], [480, 320, 2.5], [700, 320, 2.5], [540, 360, 2.5], [700, 360, 2.5]].
          map(([x, y, r], i) => <circle key={i} cx={x} cy={y} r={r} fillOpacity=".6" />)}
        </g>
      </svg>);

  },

  Spore: ({ tone = "sage", size = 220 }) => {
    const palette = {
      sage: ["#7a9482", "#b9c8b3"],
      ochre: ["#d49b4b", "#e2b878"],
      terra: ["#c1714f", "#d59b82"],
      indigo: ["#5e7290", "#8c9bb1"],
      plum: ["#7c4f63", "#a4889a"]
    }[tone];
    const id = React.useMemo(() => `sp-${tone}-${Math.floor(Math.random() * 99999)}`, [tone]);
    return (
      <svg viewBox="0 0 200 200" width={size} height={size} style={{ display: "block" }}>
        <defs>
          <radialGradient id={id} cx="50%" cy="48%" r="55%">
            <stop offset="0%" stopColor={palette[0]} stopOpacity=".75" />
            <stop offset="55%" stopColor={palette[1]} stopOpacity=".35" />
            <stop offset="100%" stopColor={palette[1]} stopOpacity="0" />
          </radialGradient>
        </defs>
        <ellipse cx="100" cy="98" rx="92" ry="78" fill={`url(#${id})`} />
        <g stroke={palette[0]} strokeOpacity=".35" fill="none" strokeWidth=".6">
          <path d="M100 98 Q60 70 30 60" />
          <path d="M100 98 Q140 70 170 60" />
          <path d="M100 98 Q70 130 40 150" />
          <path d="M100 98 Q140 130 170 150" />
          <path d="M100 98 Q100 60 102 30" />
          <path d="M100 98 Q102 140 104 170" />
        </g>
        <g fill={palette[0]} fillOpacity=".55">
          {[[100, 98, 2.5], [60, 70, 1.5], [140, 70, 1.5], [70, 130, 1.5], [140, 130, 1.5], [100, 60, 1.5], [102, 140, 1.5]].map(([x, y, r], i) =>
          <circle key={i} cx={x} cy={y} r={r} />
          )}
        </g>
      </svg>);

  },

  Wash: ({ tone = "sage", w = "100%", h = "100%" }) => {
    const palette = {
      sage: ["#7a9482", "#b9c8b3"],
      ochre: ["#d49b4b", "#e2b878"],
      terra: ["#c1714f", "#d59b82"],
      indigo: ["#5e7290", "#8c9bb1"],
      plum: ["#7c4f63", "#a4889a"]
    }[tone];
    const id = React.useMemo(() => `wash-${tone}-${Math.floor(Math.random() * 99999)}`, [tone]);
    return (
      <svg viewBox="0 0 200 120" width={w} height={h} preserveAspectRatio="xMidYMid slice" style={{ display: "block" }}>
        <defs>
          <radialGradient id={id} cx="50%" cy="50%" r="55%">
            <stop offset="0%" stopColor={palette[0]} stopOpacity=".7" />
            <stop offset="55%" stopColor={palette[1]} stopOpacity=".3" />
            <stop offset="100%" stopColor={palette[1]} stopOpacity="0" />
          </radialGradient>
        </defs>
        <ellipse cx="100" cy="60" rx="105" ry="62" fill={`url(#${id})`} />
      </svg>);

  },

  // Tiny botanical icon for the brand mark
  BrandMark: ({ size = 28 }) =>
  <img src="brand-mark.png" alt="HYPHA"
  width={size} height={size}
  style={{
      display: "block",
      width: size, height: size,
      filter: "brightness(0) saturate(100%)", objectFit: "fill"
    }} />

};

// Lightweight stroke icon set
const Icon = ({ name, size = 18, stroke = 1.4 }) => {
  const p = {
    fill: "none", stroke: "currentColor",
    strokeWidth: stroke, strokeLinecap: "round", strokeLinejoin: "round"
  };
  const paths = {
    home: <><path {...p} d="M3 11 L12 4 L21 11" /><path {...p} d="M5 10 V20 H19 V10" /></>,
    book: <><path {...p} d="M4 5 H11 V20 H4 Z" /><path {...p} d="M13 5 H20 V20 H13 Z" /></>,
    map: <><path {...p} d="M3 6 L9 4 L15 6 L21 4 V18 L15 20 L9 18 L3 20 Z" /><path {...p} d="M9 4 V18" /><path {...p} d="M15 6 V20" /></>,
    note: <><path {...p} d="M5 4 H17 L19 6 V20 H5 Z" /><path {...p} d="M8 9 H16" /><path {...p} d="M8 13 H16" /><path {...p} d="M8 17 H13" /></>,
    spark: <><path {...p} d="M12 3 V8" /><path {...p} d="M12 16 V21" /><path {...p} d="M3 12 H8" /><path {...p} d="M16 12 H21" /><path {...p} d="M5.5 5.5 L8.5 8.5" /><path {...p} d="M15.5 15.5 L18.5 18.5" /><path {...p} d="M5.5 18.5 L8.5 15.5" /><path {...p} d="M15.5 8.5 L18.5 5.5" /></>,
    compass: <><circle {...p} cx="12" cy="12" r="9" /><path {...p} d="M9 15 L11 9 L15 11 L13 17 Z" fill="currentColor" fillOpacity=".15" /></>,
    search: <><circle {...p} cx="11" cy="11" r="6" /><path {...p} d="M16 16 L21 21" /></>,
    bell: <><path {...p} d="M5 17 H19 L17 14 V10 A5 5 0 0 0 7 10 V14 Z" /><path {...p} d="M10 20 H14" /></>,
    arrow: <><path {...p} d="M5 12 H19" /><path {...p} d="M14 6 L20 12 L14 18" /></>,
    arrowL: <><path {...p} d="M19 12 H5" /><path {...p} d="M10 6 L4 12 L10 18" /></>,
    plus: <><path {...p} d="M12 5 V19" /><path {...p} d="M5 12 H19" /></>,
    check: <><path {...p} d="M5 12 L10 17 L19 7" /></>,
    play: <><path {...p} d="M7 5 L19 12 L7 19 Z" fill="currentColor" /></>,
    pause: <><path {...p} d="M7 5 V19" /><path {...p} d="M17 5 V19" /></>,
    eye: <><path {...p} d="M2 12 Q7 5 12 5 Q17 5 22 12 Q17 19 12 19 Q7 19 2 12Z" /><circle {...p} cx="12" cy="12" r="2.5" /></>,
    quote: <><path {...p} d="M7 7 H10 V11 L8 14 H6 V10 Z" /><path {...p} d="M14 7 H17 V11 L15 14 H13 V10 Z" /></>,
    flask: <><path {...p} d="M9 3 V9 L4 19 H20 L15 9 V3" /><path {...p} d="M8 3 H16" /></>,
    gavel: <><path {...p} d="M5 19 H19" /><path {...p} d="M9 15 L15 9" /><path {...p} d="M11 7 L17 13" /></>,
    bolt: <><path {...p} d="M13 3 L5 13 H11 L11 21 L19 11 H13 Z" fill="currentColor" fillOpacity=".1" /></>,
    palette: <><path {...p} d="M12 3 A9 9 0 1 0 12 21 Q14 21 14 19 V18 Q14 16 16 16 H18 A3 3 0 0 0 21 13 A9 9 0 0 0 12 3 Z" /><circle cx="8" cy="9" r="1.2" fill="currentColor" /><circle cx="12" cy="7" r="1.2" fill="currentColor" /><circle cx="16" cy="9" r="1.2" fill="currentColor" /></>,
    settings: <><circle {...p} cx="12" cy="12" r="3" /><path {...p} d="M12 2 V5 M12 19 V22 M2 12 H5 M19 12 H22 M5 5 L7 7 M17 17 L19 19 M5 19 L7 17 M17 7 L19 5" /></>,
    chev: <><path {...p} d="M9 6 L15 12 L9 18" /></>,
    chevD: <><path {...p} d="M6 9 L12 15 L18 9" /></>,
    dot: <circle {...p} cx="12" cy="12" r="3" fill="currentColor" />,
    link: <><path {...p} d="M10 14 L14 10" /><path {...p} d="M9 7 H7 A5 5 0 0 0 7 17 H9" /><path {...p} d="M15 17 H17 A5 5 0 0 0 17 7 H15" /></>,
    sparkle: <><path {...p} d="M12 4 L13.5 10.5 L20 12 L13.5 13.5 L12 20 L10.5 13.5 L4 12 L10.5 10.5 Z" fill="currentColor" fillOpacity=".15" /></>,
    quoteOpen: <><path {...p} d="M6 7 H10 V13 H6 Z" /><path {...p} d="M14 7 H18 V13 H14 Z" /></>,
    pen: <><path {...p} d="M4 20 L8 19 L20 7 L17 4 L5 16 L4 20 Z" /></>,
    leaf: <><path {...p} d="M5 19 Q5 5 19 5 Q19 19 5 19 Z" /><path {...p} d="M5 19 Q12 12 19 5" /></>,
    mush: <><path {...p} d="M4 11 Q4 5 12 5 Q20 5 20 11 Z" /><path {...p} d="M9 11 V19 H15 V11" /></>,
    bookmark: <><path {...p} d="M6 4 H18 V21 L12 17 L6 21 Z" /></>
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ display: "inline-block", flexShrink: 0 }}>
      {paths[name] || paths.dot}
    </svg>);

};

Object.assign(window, { Watercolor, Icon });