// 12x12 original pixel tent mark.
export default function TentIcon({ className = 'h-6 w-6' }) {
  return (
    <svg viewBox="0 0 12 12" shapeRendering="crispEdges" className={className} aria-hidden="true">
      <rect x="5" y="0" width="1" height="2" fill="var(--color-pine)" />
      <rect x="6" y="0" width="2" height="1" fill="var(--color-coral)" />
      <rect x="5" y="2" width="2" height="1" fill="var(--color-coral)" />
      <rect x="4" y="3" width="4" height="1" fill="var(--color-coral)" />
      <rect x="3" y="4" width="6" height="1" fill="var(--color-coral)" />
      <rect x="3" y="5" width="6" height="1" fill="var(--color-coral-dark)" />
      <rect x="2" y="6" width="8" height="1" fill="var(--color-coral)" />
      <rect x="1" y="7" width="10" height="1" fill="var(--color-coral)" />
      <rect x="1" y="8" width="10" height="1" fill="var(--color-coral-dark)" />
      <rect x="0" y="9" width="12" height="2" fill="var(--color-coral)" />
      <rect x="5" y="7" width="2" height="4" fill="var(--color-pine)" />
      <rect x="0" y="11" width="12" height="1" fill="var(--color-pine)" />
    </svg>
  );
}
