// Original pixel-art lakeside camp. Every shape is a rect on a 160x72 grid,
// scaled up with crispEdges so the pixels stay sharp at any width.

const C = {
  pine: 'var(--color-pine)',
  pineSoft: 'var(--color-pine-soft)',
  mintDark: 'var(--color-mint-dark)',
  water: 'var(--color-water)',
  cloud: 'var(--color-cloud)',
  coral: 'var(--color-coral)',
  coralDark: 'var(--color-coral-dark)',
  flame: '#F4C15D',
  bark: '#7A5A43',
  stone: '#9FB3AA',
};

function Px({ x, y, w = 1, h = 1, fill }) {
  return <rect x={x} y={y} width={w} height={h} fill={fill} />;
}

function Cloud({ x, y }) {
  return (
    <g fill={C.cloud}>
      <rect x={x + 3} y={y} width={6} height={1} />
      <rect x={x + 1} y={y + 1} width={11} height={1} />
      <rect x={x} y={y + 2} width={15} height={2} />
    </g>
  );
}

// Pine tree, centred on cx, standing on baseY. size = number of branch tiers.
function Pine({ cx, baseY, size = 3, fill = C.pine }) {
  const rects = [];
  let y = baseY - 2;
  rects.push(<Px key="trunk" x={cx} y={y} w={1} h={2} fill={C.bark} />);
  for (let tier = size; tier >= 1; tier--) {
    // each tier: two rows, widening downwards
    const wide = tier * 2 + 1;
    rects.push(<Px key={`a${tier}`} x={cx - tier} y={y - 1} w={wide} h={1} fill={fill} />);
    rects.push(<Px key={`b${tier}`} x={cx - tier + 1} y={y - 2} w={wide - 2} h={1} fill={fill} />);
    y -= 2;
  }
  rects.push(<Px key="tip" x={cx} y={y - 1} fill={fill} />);
  return <g>{rects}</g>;
}

function Tent({ cx, baseY, height = 11 }) {
  const rows = [];
  for (let i = 0; i < height; i++) {
    const y = baseY - height + i;
    rows.push(<Px key={`t${i}`} x={cx - i} y={y} w={i * 2 + 1} fill={i % 4 === 3 ? C.coralDark : C.coral} />);
    const d = i - 5;
    if (d >= 0) rows.push(<Px key={`d${i}`} x={cx - d} y={y} w={d * 2 + 1} fill={C.pine} />);
  }
  return (
    <g>
      <Px x={cx} y={baseY - height - 3} h={3} fill={C.bark} />
      <Px x={cx + 1} y={baseY - height - 3} w={2} fill={C.flame} />
      {rows}
    </g>
  );
}

function Campfire({ cx, baseY }) {
  return (
    <g>
      <Px x={cx - 5} y={baseY - 1} w={2} fill={C.stone} />
      <Px x={cx + 4} y={baseY - 1} w={2} fill={C.stone} />
      <Px x={cx - 3} y={baseY - 2} w={7} fill={C.bark} />
      <Px x={cx - 2} y={baseY - 1} w={5} fill={C.bark} />
      <g className="pixel-flame">
        <Px x={cx - 2} y={baseY - 5} w={5} h={3} fill={C.coral} />
        <Px x={cx - 1} y={baseY - 7} w={3} h={2} fill={C.coral} />
        <Px x={cx} y={baseY - 8} fill={C.coral} />
        <Px x={cx - 1} y={baseY - 4} w={3} h={2} fill={C.flame} />
        <Px x={cx} y={baseY - 5} fill={C.flame} />
      </g>
    </g>
  );
}

// Tiny 3x8 friend standing on baseY.
function Friend({ x, baseY, shirt, skin, hair }) {
  const top = baseY - 8;
  return (
    <g>
      <Px x={x} y={top} w={3} fill={hair} />
      <Px x={x} y={top + 1} w={3} h={2} fill={skin} />
      <Px x={x} y={top + 3} w={3} h={3} fill={shirt} />
      <Px x={x} y={top + 6} h={2} fill={C.pine} />
      <Px x={x + 2} y={top + 6} h={2} fill={C.pine} />
    </g>
  );
}

export default function PixelScene({ className = '' }) {
  return (
    <svg
      viewBox="0 12 160 60"
      shapeRendering="crispEdges"
      preserveAspectRatio="xMidYMid slice"
      className={`block h-auto min-h-[200px] w-full ${className}`}
      role="img"
      aria-label="Pixel art of friends around a campfire beside a tent on a lakeshore"
    >
      <Cloud x={12} y={18} />
      <Cloud x={68} y={24} />
      <Cloud x={122} y={16} />

      {/* far bank */}
      <Px x={0} y={38} w={160} h={6} fill={C.mintDark} />
      <Pine cx={6} baseY={40} size={3} fill={C.pineSoft} />
      <Pine cx={15} baseY={40} size={4} fill={C.pineSoft} />
      <Pine cx={24} baseY={40} size={2} fill={C.pineSoft} />
      <Pine cx={128} baseY={40} size={3} fill={C.pineSoft} />
      <Pine cx={138} baseY={40} size={4} fill={C.pineSoft} />
      <Pine cx={150} baseY={40} size={3} fill={C.pineSoft} />

      {/* lake */}
      <Px x={0} y={44} w={160} h={8} fill={C.water} />
      <Px x={18} y={46} w={7} fill={C.cloud} />
      <Px x={58} y={49} w={10} fill={C.cloud} />
      <Px x={104} y={47} w={8} fill={C.cloud} />
      <Px x={140} y={50} w={5} fill={C.cloud} />

      {/* near bank */}
      <Px x={0} y={52} w={160} h={1} fill={C.pineSoft} />
      <Px x={0} y={53} w={160} h={19} fill={C.mintDark} />
      <Pine cx={5} baseY={66} size={5} />
      <Pine cx={16} baseY={68} size={4} />
      <Pine cx={145} baseY={67} size={4} />
      <Pine cx={155} baseY={66} size={5} />

      <Tent cx={44} baseY={66} />
      <Campfire cx={82} baseY={66} />
      <Friend x={66} baseY={66} shirt={C.coralDark} skin="#C68A5E" hair={C.pine} />
      <Friend x={72} baseY={67} shirt={C.water} skin="#F1C9A5" hair="#7A5A43" />
      <Friend x={90} baseY={67} shirt={C.cloud} skin="#8D5A3B" hair={C.pine} />
      <Friend x={96} baseY={66} shirt={C.pineSoft} skin="#E9B48A" hair="#3B2A20" />
    </svg>
  );
}
