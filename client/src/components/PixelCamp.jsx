// Original pixel-art camp (tent, pines, fire) on a 48x20 grid. Decorative only.
const R = ({ x, y, w = 1, h = 1, f }) => <rect x={x} y={y} width={w} height={h} fill={f} />;

export default function PixelCamp({ className = '' }) {
  const pine = 'var(--color-pine)';
  const soft = 'var(--color-pine-soft)';
  const coral = 'var(--color-coral)';
  const cloud = 'var(--color-cloud)';
  const water = 'var(--color-water)';
  return (
    <svg viewBox="0 0 48 20" className={className} shapeRendering="crispEdges" aria-hidden="true" focusable="false">
      <R x={0} y={0} w={48} h={20} f="var(--color-mint-dark)" />
      <R x={4} y={3} w={6} h={1} f={cloud} /><R x={3} y={4} w={9} h={1} f={cloud} />
      <R x={34} y={2} w={5} h={1} f={cloud} /><R x={33} y={3} w={8} h={1} f={cloud} />
      <R x={0} y={15} w={48} h={5} f={water} />
      <R x={0} y={14} w={48} h={1} f={soft} />
      {/* pines */}
      {[6, 40].map((cx) => (
        <g key={cx}>
          <R x={cx} y={12} w={1} h={2} f="#7A5A43" />
          <R x={cx - 1} y={10} w={3} h={2} f={pine} />
          <R x={cx - 2} y={8} w={5} h={2} f={pine} />
          <R x={cx - 1} y={6} w={3} h={2} f={pine} />
          <R x={cx} y={5} w={1} h={1} f={pine} />
        </g>
      ))}
      {/* tent */}
      <R x={19} y={8} w={2} h={1} f={coral} />
      <R x={18} y={9} w={4} h={1} f={coral} />
      <R x={17} y={10} w={6} h={1} f={coral} />
      <R x={16} y={11} w={8} h={1} f={coral} />
      <R x={15} y={12} w={10} h={2} f={coral} />
      <R x={19} y={11} w={2} h={3} f={pine} />
      {/* fire */}
      <R x={29} y={13} w={3} h={1} f="#7A5A43" />
      <R x={30} y={11} w={1} h={2} f="#F4C15D" />
      <R x={29} y={12} w={1} h={1} f="#F4C15D" />
    </svg>
  );
}
