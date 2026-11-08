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
