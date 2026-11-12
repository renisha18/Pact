import { Link } from 'react-router';

/** items: [{ label, to? }]; the last item is the current page (no link). */
export default function Breadcrumbs({ items }) {
  return (
    <nav aria-label="Breadcrumb" className="mb-4 text-xs text-pine-soft">
      <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
        {items.map((it, i) => {
          const last = i === items.length - 1;
          return (
            <li key={`${i}-${it.label}`} className="flex min-w-0 items-center gap-1.5">
              {i > 0 && <span aria-hidden="true">›</span>}
              {it.to && !last ? (
                <Link to={it.to} className="max-w-[18ch] truncate hover:text-pine hover:underline">{it.label}</Link>
              ) : (
                <span aria-current={last ? 'page' : undefined} className="max-w-[24ch] truncate font-medium text-pine">{it.label}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
