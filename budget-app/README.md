# Budget App

A zero-based (envelope) budgeting app — YNAB-style — built from the Claude Design mockup in
`../Budget.dc.html`. Full stack: React (Vite) client + Express API + SQLite database.

## Run it

```
npm install
npm run dev
```

- Client: http://localhost:5173 (Vite dev server, proxies `/api` to the backend)
- API: http://localhost:3178

For a single-port "production" run:

```
npm run build
npm start        # serves the built client + API on http://localhost:3178
```

## Accounts & budgets

The app is gated behind email + password sign-in (passwords are scrypt-hashed,
sessions live in an httpOnly cookie for 90 days). The **first account you register
adopts the original demo budget** ("2026 Budget") if it hasn't been claimed yet;
later accounts start with an empty "My Budget".

Click the budget name at the top of the sidebar for the account/budget menu:
switch budgets, create a new budget (**each budget gets its own database file**,
optionally seeded with demo data), rename the current one, or sign out.

## Encryption

Budget databases are **encrypted at rest with per-user keys** — nobody without a
user's password (including the server operator) can read that user's budgets.

How it works (envelope encryption, see `server/crypto.js`):

- Each user has a random 32-byte data key (DEK). Their budget files are
  SQLCipher-style page-encrypted with it (`better-sqlite3-multiple-ciphers`).
- The DEK is only ever stored **wrapped** (AES-256-GCM): once by a key derived
  from the user's password (scrypt, per-user salt), and once per session by a
  key derived from the raw session token. Raw tokens exist only in the user's
  cookie; the sessions table stores token *hashes* — so `system.db` alone can
  never unwrap anything.
- `system.db` stays unencrypted (it must be readable before login) but contains
  only emails, password hashes, budget names, and wrapped keys.
- Budgets created before encryption are **encrypted in place at the owner's
  next login**. Sessions from before the change are invalidated once.

**A forgotten password means the data is permanently unrecoverable.** That is
the security model working as intended — there is nothing on disk that can
decrypt a user's budgets without their password.

## Account security

Open the sidebar menu → **🔐 Security** for:

- **Change password** — verifies the current password, re-wraps the data key
  (no re-encryption of budgets needed), and signs out all other sessions.
- **Two-factor (TOTP)** — RFC 6238 codes from any authenticator app. The TOTP
  secret is stored wrapped with your data key. Enabling generates **8 one-time
  recovery codes** (scrypt-hashed at rest) — save them; losing both your
  authenticator and the codes locks the account, and with it the data.
- **Passkeys** — passwordless sign-in via WebAuthn. Registration requires the
  **PRF extension**: the authenticator derives key material that wraps your data
  key, so a passkey can genuinely unlock encrypted budgets without a password
  and without the server ever holding a usable key at rest. Authenticators
  without PRF are rejected at registration with a clear message.

`npm run test:security` exercises all of this against a running API, including
a simulated WebAuthn authenticator (real ES256 signatures + replay-counter
checks) so the passkey path is testable without a browser ceremony.

`npm run test:sync` spins up a mock SimpleFIN bridge and drives the whole sync
flow (claim, link, import, dedupe, pending→posted, balance alignment, unlink,
delete) end-to-end. `npm run test:transfers` covers the paired-transfer
lifecycle. All test scripts need the API running (`npm run dev:api`).

## Where the data lives

All SQLite files are in `server/data/` (override with the `DATA_DIR` env var) —
`system.db` (users, budgets, sessions) plus one encrypted `budget-<id>.db` per
budget. The SQLite driver ships prebuilt binaries; no build toolchain needed.

## What works

- **Budget engine** — categories/groups (add, rename, delete), assigning money per
  month with live *Ready to Assign*, *Available = carryover + assigned + activity*,
  month navigation with automatic carryover.
- **Transactions** — add/edit/delete per account or across all accounts; payee
  autocomplete; income inflows fund Ready to Assign; uncategorized tracking.
- **Credit cards** — YNAB-style mechanic: categorized spending on a card moves that
  money into the card's payment category. Record a card payment as a checking
  outflow categorized to the payment category + a transfer inflow on the card.
  Payment categories are tied to their card: clicking one opens the card's account
  ledger, and when the card is synced via SimpleFIN the Available pill turns
  **yellow** whenever the amount set aside doesn't match what the bank reports as
  owed (hover the pill for the exact drift).
- **Transfers** — picking "Transfer / Card Payment" replaces the payee field with a
  required "⇄ Transfer to…" account picker, and the server maintains a linked mirror
  transaction on the other account (inverse amount). Editing either side updates
  both; deleting one side deletes both; converting to/from a transfer creates or
  removes the mirror. Transfers never touch the budget.
- **Accounts** — add cash/credit/loan accounts; balances computed from transactions;
  loans are tracking-only.
- **Bank sync (SimpleFIN)** — connect a SimpleFIN bridge and link each bank account
  to a budget account (links are per-account, not per-budget). A bank account with
  no matching account yet can be created right from the connection list — the name
  and type are prefilled from the bank, then it's created and linked in one step. Transactions import
  automatically, deduped by external ID; pending charges import uncleared and flip
  to cleared when they post. Linking aligns the account balance to the bank's with a
  one-time adjustment. Connections auto-sync on app load if stale (>6h), or on demand
  via "Sync All". Access URLs are stored inside the encrypted budget DB. The provider
  layer (`server/sync.js`) is pluggable for adding LunchFlow etc. later.
- **Auto-assign** — cover overspending, repeat last month's assignments.
- **Move money** — click any positive Available pill to move money from that
  category to another category or back to Ready to Assign. The Ready to Assign
  box has an Assign ▾ menu to assign to a category or auto-fund goals.
- **Goals** — set a monthly goal per category in the inspector panel (which also
  holds rename and delete, keeping table rows clear for status text). Rows show
  goal progress; "Fund goals" assigns to underfunded goals in order, never more
  than Ready to Assign holds.
- **Funding bars** — each category's bar is a row of rounded pills, one per month
  its money came from (older money renders dimmer), attributed FIFO — spending
  consumes the oldest funds first. Inside each pill, diagonal stripes cover the
  spent share; a red pill marks overspending past the funds, and empty track is
  the gap to an unmet goal. Hover a bar for the full breakdown.
- **Reports** — the main report is an interactive spending donut (ported from the
  "Interactive Budgeting Pie Chart" design artifact): rounded ring segments with
  outside labels, hover dims the rest and swaps the center readout, a
  Categories/Groups toggle re-aggregates, and a color-matched legend beneath
  carries the small slices (hovering it drives the chart too). Preset ranges
  (this/last month, 3 months, YTD, all time). Real categories net out refunds; the
  Uncategorized slice counts outflows only and is always red. Income, transfers,
  and balance adjustments are excluded. Slices beyond 9 fold into "Other".
- **Calendar** — month grid of cleared transactions plus recurring ones (flag them
  via the ✓ Cleared / 🔁 Recurring checkboxes in the transaction editor). Recurring
  transactions from past months project forward as dashed "upcoming" chips on their
  day of month until a matching transaction posts. Both chip types have toggles.

## Data model rules (cents, signed)

- All amounts are integer cents; outflows negative.
- Cash starting balances are income (fund Ready to Assign); credit/loan starting
  balances are budget-neutral debt.
- Transfers (`is_transfer`) never touch the budget.
- Loan-account transactions never touch the budget.
- Negative Available carries forward month to month.

## Not built yet (ideas)

- Targets/goals ("Cost to Be Me", underfunded calculations)
- Reports (the "Reflect" view)
- Transfers as first-class linked pairs
- CSV import, bank sync, multi-user
