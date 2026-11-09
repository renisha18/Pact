// Response shapes are built field-by-field here so private columns never leak.

/** Safe for anyone to see. */
export function publicUser(row) {
  return { id: row.id, name: row.name, avatarEmoji: row.avatar_emoji };
}

/** Only for the user themselves. */
export function selfUser(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    avatarEmoji: row.avatar_emoji,
    paypalSandboxEmail: row.paypal_sandbox_email,
  };
}

/** Row from GET /api/groups list query. */
export function groupSummary(row) {
  return {
    id: row.id,
    name: row.name,
    emoji: row.emoji,
    memberCount: Number(row.member_count),
    nextTrip: row.next_trip_id
      ? {
          id: row.next_trip_id,
          title: row.next_trip_title,
          status: row.next_trip_status,
          startDate: row.next_trip_start_date,
        }
      : null,
  };
}

export function groupDetail(row) {
  return {
    id: row.id,
    name: row.name,
    emoji: row.emoji,
    personality: row.personality,
    createdAt: row.created_at,
  };
}

export function groupMember(row) {
  return {
    id: row.id,
    name: row.name,
    avatarEmoji: row.avatar_emoji,
    role: row.role,
    funTitle: row.fun_title,
  };
}

export function tripSummary(row) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    startDate: row.start_date,
    endDate: row.end_date,
  };
}

export function invitePreview(row) {
  return { groupName: row.name, emoji: row.emoji, memberCount: Number(row.member_count) };
}

export function inviteUrl(token) {
  const origin = (process.env.CLIENT_ORIGIN || 'http://localhost:5173').replace(/\/+$/, '');
  return `${origin}/join/${token}`;
}

/** Trip fields any trip member may see. No budgets, commitments or private text. */
export function tripPublic(row) {
  return {
    id: row.id,
    groupId: row.group_id,
    title: row.title,
    region: row.region,
    startDate: row.start_date,
    endDate: row.end_date,
    nights: row.nights,
    status: row.status,
    chosenListingId: row.chosen_listing_id,
    bookingDeadline: row.booking_deadline,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

/** Trip member as seen by other members: status only. */
export function tripMemberPublic(row) {
  return { id: row.id, name: row.name, avatarEmoji: row.avatar_emoji, status: row.status };
}

/** PRIVATE: only ever returned to the owner. Joined private_inputs + own trip_members row. */
export function privateInputSelf(row) {
  return {
    maxBudgetCents: row.max_budget_cents,
    preferencesText: row.preferences_text,
    comfortText: row.comfort_text,
    commitmentType: row.commitment_type,
    roastLevel: row.roast_level,
    updatedAt: row.updated_at,
  };
}

/** Proposal any trip member may see. Joined proposals + listings + vote count. No shares. */
export function proposalPublic(row) {
  return {
    id: row.id,
    listingName: row.listing_name,
    area: row.area,
    emoji: row.emoji,
    pricePerNightCents: row.price_per_night_cents,
    totalCents: row.total_cents,
    amenities: row.amenities,
    reason: row.reason_text,
    voteCount: Number(row.vote_count),
  };
}

/** PRIVATE: a user's own payment row. Never includes PayPal ids beyond the order id they approve. */
export function paymentSelf(row) {
  return {
    id: row.id,
    kind: row.kind,
    amountCents: row.amount_cents,
    status: row.status,
    orderId: row.paypal_order_id,
    updatedAt: row.updated_at,
  };
}

/**
 * PRIVATE: a member's own negotiation. Joined negotiations + the unlocked listing.
 * change_json is server-built and only ever describes this member.
 */
export function negotiationSelf(row) {
  const c = row.change_json;
  const canAskAnother = !c.isAlternative && c.alternative != null;
  return {
    id: row.id,
    kind: c.change.kind,
    ...(c.change.kind === 'raiseBudget' ? { raiseByCents: c.change.byCents } : {}),
    ...(c.change.kind === 'allowRoomType' ? { roomType: c.change.roomType } : {}),
    stay: { id: row.listing_id, name: row.listing_name, area: row.area, emoji: row.emoji },
    newShareCents: c.newShareCents,
    matchesOwnWishes: c.matchesOwnWishes,
    message: row.message,
    responses: [
      'accept',
      c.change.kind === 'raiseBudget' ? 'more_time' : 'reject',
      ...(c.change.kind === 'raiseBudget' ? ['reject'] : []),
      ...(canAskAnother ? ['another'] : []),
    ],
    createdAt: row.created_at,
  };
}
