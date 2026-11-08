# Pact
Group trip planning: private budgets, commit-together PayPal holds, nobody fronts money. PayPal SANDBOX only.

## Stack
server/: Node 20 + Express (ESM), pg, zod, helmet, cors, cookie-parser, jsonwebtoken, express-rate-limit, vitest + supertest
client/: React + Vite + Tailwind + react-router
DB: Postgres (Neon), schema in server/db/schema.sql

## Commands
npm run dev (root): server :4000 + client :5173 | npm run db:migrate | npm run db:seed | npm test (server/)

## Hard rules
- NEVER read, print or edit any .env file.
- Money is integer cents. Server computes every amount; never trust amounts from the client.
- private_inputs, shares, payments rows are returned ONLY to their owner. Group endpoints build responses field-by-field in server/src/lib/views.js.
- Every group/trip route checks membership; return 404 (not 403) for non-members.
- Parameterized SQL only. Validate every request body with zod.
- AI code never calls PayPal and never computes money.
- Never render user or AI text as HTML.
- Don't log request bodies or private inputs.

## Style
Calm mint UI, JetBrains Mono, coral pill buttons, original pixel art (docs/ui-reference.jpg = mood only, never copy its artwork).
Keep replies short: list files changed + anything I must do manually.
