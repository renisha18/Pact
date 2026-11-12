// Derived ONLY from real backend state (trip row, public member statuses, readiness, vote counts).
export const EDITABLE_TRIP = new Set(['collecting', 'planning']);
export const HAS_PROPOSALS = new Set(['voting', 'committing', 'needs_attention', 'booked']);
export const COMMIT_STAGE = new Set(['committing', 'needs_attention', 'booked']);

export const TABS = [
  { id: 'overview', label: 'Overview', icon: '🏕️' },
  { id: 'plan', label: 'Plan', icon: '🧭' },
  { id: 'commit', label: 'Commit', icon: '🤝' },
  { id: 'ask', label: 'Ask Pact', icon: '💬' },
];

/** Which tab holds each kind of pending to-do from /api/me/actions. */
export const ACTION_TAB = {
  availability: 'plan',
  dates_nudge: 'plan',
  private_details: 'plan',
  negotiation: 'plan',
  vote: 'plan',
  commit: 'commit',
  payment_failed: 'commit',
  cover: 'commit',
};

export function activeMembers(members) {
  return members.filter((m) => m.status !== 'dropped');
}

/** Five-step tracker. state: 'done' | 'current' | 'todo'. detail is counts only. */
export function buildStages({ trip, members, readiness, votes }) {
  const active = activeMembers(members);
  const shared = active.filter((m) => m.status !== 'invited').length;
  const s = trip.status;
  const found = HAS_PROPOSALS.has(s);
  const decided = Boolean(trip.chosenListingId) || COMMIT_STAGE.has(s);
  const secured = s === 'booked' || Boolean(readiness?.allSecured);
  const booked = s === 'booked';

  const flags = [shared === active.length && active.length > 0, found, decided, secured, booked];
  const currentIdx = flags.findIndex((f) => !f);
  const details = [
    `${shared} of ${active.length} shared`,
    found ? 'Ready to compare' : 'Not yet',
    s === 'voting' && votes ? `${votes.cast} of ${votes.total} voted` : decided ? 'Chosen' : 'Not yet',
    readiness && COMMIT_STAGE.has(s) ? `${readiness.secured} of ${readiness.total} secured` : 'Not yet',
    booked ? 'Booked' : 'Not yet',
  ];
  const tabs = ['plan', 'plan', 'plan', 'commit', 'commit'];
  return ['Details shared', 'Stays found', 'Group decided', 'Commitments secured', 'Booked'].map((label, i) => ({
    label,
    detail: details[i],
    tab: tabs[i],
    state: flags[i] ? 'done' : i === currentIdx ? 'current' : 'todo',
  }));
}
