// Click-first requirements. Chips are saved as structured data (no AI) and merged with
// whatever the free-text extraction finds. Must-have chips are strict; nice-to-have are soft.
// Chip labels map to the listings vocabulary; a chip with no matching listing is hidden.

// feature: an amenity or vibe tag. avoid: room types ruled out. room: room type that must exist.
const MUST = [
  { group: 'Rooms', chips: [
    { id: 'private_room', label: 'My own private room', avoid: ['shared_rooms', 'mixed_dorm'], room: 'private_rooms' },
    { id: 'no_mixed_dorms', label: 'No mixed dorms', avoid: ['mixed_dorm'], room: 'mixed_dorm' },
    { id: 'shared_ok', label: 'Shared room is fine', avoid: [], room: 'shared_rooms' },
  ] },
  { group: 'Access & comfort', chips: [
    { id: 'step_free', label: 'Step-free access', feature: 'step-free access' },
    { id: 'ac', label: 'Air conditioning', feature: 'air conditioning' },
    { id: 'wifi', label: 'Wifi', feature: 'wifi' },
  ] },
  { group: 'Food', chips: [
    { id: 'veg_kitchen', label: 'Vegetarian kitchen', feature: 'vegetarian kitchen' },
    { id: 'kitchen', label: 'Kitchen', feature: 'kitchen' },
    { id: 'breakfast', label: 'Breakfast included', feature: 'breakfast included' },
    { id: 'home_cooked', label: 'Home-cooked meals', feature: 'home-cooked meals' },
  ] },
];

const NICE = [
  { group: 'Stay', chips: [
    { id: 'pool', label: 'Pool', feature: 'pool' },
    { id: 'workspace', label: 'Workspace', feature: 'workspace' },
    { id: 'gym', label: 'Gym', feature: 'gym' },
    { id: 'spa', label: 'Spa', feature: 'spa' },
    { id: 'yoga_deck', label: 'Yoga deck', feature: 'yoga deck' },
  ] },
  { group: 'Activities', chips: [
    { id: 'surf', label: 'Surf lessons', feature: 'surf' },
    { id: 'snorkel', label: 'Snorkel gear', feature: 'snorkel gear' },
    { id: 'dive', label: 'Dive centre', feature: 'dive centre' },
    { id: 'scooter', label: 'Scooter rental', feature: 'scooter rental' },
  ] },
  { group: 'Vibe', chips: [
    ...['quiet', 'party', 'nature', 'wellness', 'beach', 'culture', 'nightlife', 'adventure', 'views', 'sunset'].map((v) => (
      { id: `vibe_${v}`, label: v[0].toUpperCase() + v.slice(1), feature: v })),
    { id: 'vibe_remote_work', label: 'Remote work', feature: 'remote work' },
  ] },
];

const index = (sections) => new Map(sections.flatMap((s) => s.chips.map((c) => [c.id, c])));
export const MUST_CHIPS = index(MUST);
export const NICE_CHIPS = index(NICE);

const LABELS = {
  'air conditioning': 'Air conditioning', 'step-free access': 'Step-free access', 'vegetarian kitchen': 'Vegetarian kitchen',
  private_rooms: 'Private rooms', shared_rooms: 'Shared rooms', mixed_dorm: 'Mixed dorm',
};
export const friendlyLabel = (v) => LABELS[v] ?? (v[0].toUpperCase() + v.slice(1).replace(/[_-]/g, ' '));

const visible = (c, features, rooms) =>
  (c.feature ? features.has(c.feature) : rooms.has(c.room));

function visibleSections(sections, vocab) {
  const features = new Set([...vocab.amenities, ...vocab.vibeTags]);
  const rooms = new Set(vocab.roomTypes);
  return sections
    .map((s) => ({ group: s.group, chips: s.chips.filter((c) => visible(c, features, rooms)).map(({ id, label }) => ({ id, label })) }))
    .filter((s) => s.chips.length > 0);
}

/** Everything the client may show: listing vocabulary with labels, and only chips that match a listing. */
export function vocabularyView(vocab) {
  const labelled = (xs) => xs.map((value) => ({ value, label: friendlyLabel(value) }));
  return {
    amenities: labelled(vocab.amenities),
    vibeTags: labelled(vocab.vibeTags),
    roomTypes: labelled(vocab.roomTypes),
    mustHave: visibleSections(MUST, vocab),
    niceToHave: visibleSections(NICE, vocab),
  };
}

/** Returns an error message, or null if the chip selection is acceptable. */
export function validateChips(must, nice, vocab) {
  const okMust = new Set(visibleSections(MUST, vocab).flatMap((s) => s.chips.map((c) => c.id)));
  const okNice = new Set(visibleSections(NICE, vocab).flatMap((s) => s.chips.map((c) => c.id)));
  if (must.some((id) => !okMust.has(id)) || nice.some((id) => !okNice.has(id))) return 'Unknown option selected';
  if (must.includes('private_room') && must.includes('shared_ok')) return 'Pick either your own room or shared room is fine';
  return null;
}

/**
 * Merges chip requirements into extraction output (same shape as extracted_json).
 * Strict wins: a must-have chip beats a soft mention of the same thing.
 */
export function mergeChips(extracted, mustIds = [], niceIds = []) {
  const base = extracted ?? { hardRequirements: [], avoidRoomTypes: [], softPreferences: [] };
  const must = mustIds.map((id) => MUST_CHIPS.get(id)).filter(Boolean);
  const nice = niceIds.map((id) => NICE_CHIPS.get(id)).filter(Boolean);

  const hard = [...new Set([...base.hardRequirements, ...must.flatMap((c) => (c.feature ? [c.feature] : []))])];
  const strictAvoid = new Set([
    ...base.avoidRoomTypes.filter((a) => typeof a === 'string' || a.strength === 'strict').map((a) => (typeof a === 'string' ? a : a.type)),
    ...must.flatMap((c) => c.avoid ?? []),
  ]);
  const avoidRoomTypes = [
    ...[...strictAvoid].map((type) => ({ type, strength: 'strict' })),
    ...base.avoidRoomTypes.filter((a) => typeof a !== 'string' && a.strength !== 'strict' && !strictAvoid.has(a.type)),
  ];
  const soft = [...new Set([...base.softPreferences, ...nice.flatMap((c) => (c.feature ? [c.feature] : []))])]
    .filter((f) => !hard.includes(f));
  return { ...base, hardRequirements: hard, avoidRoomTypes, softPreferences: soft };
}
