import { Link } from 'react-router';

export const btn = {
  base: 'inline-flex items-center justify-center gap-2 rounded-full px-6 py-3 font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
  coral: 'bg-coral text-cloud hover:bg-coral-dark',
  cloud: 'bg-cloud text-pine ring-1 ring-mint-dark hover:bg-white',
  small: 'px-4 py-2 text-sm',
};

export const card = 'rounded-2xl bg-cloud p-5 ring-1 ring-mint-dark sm:p-6';
export const input =
  'w-full rounded-xl border border-mint-dark bg-white px-3 py-2.5 text-pine placeholder:text-pine-soft/60 focus:border-coral focus:outline-none';
export const label = 'mb-1.5 block text-sm font-medium';

export function Page({ children, narrow = false }) {
  return <main className={`mx-auto px-4 py-8 sm:py-12 ${narrow ? 'max-w-xl' : 'max-w-4xl'}`}>{children}</main>;
}

export function Skeleton({ className = 'h-24' }) {
  return <div className={`animate-pulse rounded-2xl bg-mint-dark/60 ${className}`} aria-hidden="true" />;
}

export function Loading() {
  return (
    <div className="flex justify-center py-20" role="status">
      <span className="h-6 w-6 animate-spin rounded-full border-2 border-mint-dark border-t-coral" />
      <span className="sr-only">Loading…</span>
    </div>
  );
}

export function ErrorNote({ children }) {
  if (!children) return null;
  return (
    <p role="alert" className="rounded-xl bg-coral/10 px-3 py-2 text-sm text-coral-dark">
      {children}
    </p>
  );
}

export function NotFoundCard({ what = 'page' }) {
  return (
    <div className={`${card} text-center`}>
      <p className="font-bold">We couldn’t find that {what}.</p>
      <p className="mt-2 text-sm text-pine-soft">It may not exist, or you’re not a member.</p>
      <Link to="/dashboard" className={`${btn.base} ${btn.coral} ${btn.small} mt-5`}>Back to dashboard</Link>
    </div>
  );
}

const TRIP_STATUS = {
  collecting: 'bg-water/30 text-pine',
  planning: 'bg-mint-dark text-pine',
  voting: 'bg-coral/15 text-coral-dark',
  committing: 'bg-coral text-cloud',
  needs_attention: 'bg-coral/15 text-coral-dark ring-1 ring-coral',
  booked: 'bg-pine text-cloud',
  cancelled: 'bg-pine-soft/15 text-pine-soft line-through',
};

const MEMBER_STATUS = {
  invited: { cls: 'bg-mint-dark/60 text-pine-soft', text: 'invited' },
  submitted: { cls: 'bg-water/30 text-pine', text: 'submitted ✓' },
  committed: { cls: 'bg-pine text-cloud', text: 'committed ✓' },
  dropped: { cls: 'bg-pine-soft/15 text-pine-soft', text: 'dropped' },
};

export function TripStatusChip({ status }) {
  return (
    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${TRIP_STATUS[status] ?? ''}`}>
      {status}
    </span>
  );
}

export function MemberStatusChip({ status }) {
  const s = MEMBER_STATUS[status] ?? { cls: '', text: status };
  return <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${s.cls}`}>{s.text}</span>;
}

export function Avatar({ emoji, size = 'h-9 w-9 text-lg' }) {
  return (
    <span className={`grid shrink-0 place-items-center rounded-full bg-mint ${size}`} aria-hidden="true">
      {emoji}
    </span>
  );
}
