# Future Edits

A running list of changes I want to make later, but am not ready to do yet.

- [x] **Create categories and payees inline while editing a transaction** — in the
  transaction editor, allow adding a brand-new category and a new payee on the fly
  (e.g. a "+ New category…" option in the category dropdown and free-entry that
  saves a new payee), instead of having to create them elsewhere first.
  *(Done — "＋ New category…" in the category dropdown opens a creation popover
  with group picker + inline "＋ New group…", and the payee autocomplete shows a
  "＋ New payee" row for unrecognized names.)*

- [x] **Polish the "All Accounts" transaction list padding** — tighten up and even
  out the row/column spacing in the combined All Accounts register so it reads more
  cleanly.
  *(Done — columns now shrink proportionally with per-column minimums, cells
  truncate with ellipsis instead of wrapping (dates and amounts never truncate),
  header/row column alignment fixed via matched scrollbar gutters, header + body
  scroll horizontally as one unit below the minimum width, and the sidebar narrows
  on windows under 1100px.)*

- [ ] **Goal timeframes beyond monthly** — goals are currently a single monthly
  amount per category. Add a timeframe to each goal:
  - **Weekly**, **Monthly**, **Quarterly**, **Bi-annually**, **Annually**
  - **Custom** — pick the day and month it's due, plus how often it repeats
    (e.g. "the 15th of March, every 2 years")

  Things this will touch: the goal needs a per-month funding target derived from
  the timeframe (a $600 annual goal ≈ $50/month), so "Fund goals", the underfunded
  math, and the goal progress bars/status text all need to use that derived
  monthly number rather than the raw amount. Goals with a due date should also
  show how much is needed per month to arrive on time.
