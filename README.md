# 🌿 Sprout

**Give every dollar a job.**

Sprout is a budgeting app you run on your own computer. Instead of guessing where
your money went, you decide up front what each dollar is for — rent, groceries,
the car repair fund — and watch those amounts go up and down as you actually
spend. It's the envelope method, without the envelopes.

Your money and your bank details stay on your machine. Nobody else — not even
whoever set the app up — can read your budget without your password.

---

## What you can do

### Plan the month
Put your income into categories you create, like 🏠 Rent, 🍜 Groceries, or
🎮 Games. The big **Ready to Assign** number at the top tells you how much is
still waiting for a job. When it hits zero, every dollar is accounted for.

Overspent somewhere? The category turns red and Sprout offers to cover it from
somewhere else. Changed your mind? Click any category's balance and move money
to a different one — no re-doing your whole budget.

Money you don't spend rolls into next month automatically, and each category
shows a small bar that tells you which month its money came from and how much of
it you've used.

### Set goals
Give a category a monthly target — say $400 for groceries — and Sprout shows how
close you are. One click on **Fund goals** spreads whatever's ready to assign
across everything that's still short.

### Track your accounts
Add your checking, savings, credit cards, and loans. Record what you spend, or
let your bank do it for you. Everything you type gets remembered: start typing a
store you've used before and it fills in, along with the category you filed it
under last time.

### Connect your bank
Link your accounts through **SimpleFIN** and new transactions show up on their
own — no more typing in receipts. Sprout checks for new activity whenever you
open your budget, skips anything it's already imported, and updates pending
charges once they clear.

### Handle credit cards properly
Buy groceries with a credit card and Sprout quietly sets that money aside for the
bill, so the payment never catches you by surprise. If what you've set aside
doesn't match what the card company says you owe, it flags it.

### Plan a loan payoff
Enter your interest rate and how many payments are left, then play with the
numbers: what if you paid an extra $100 a month, or dropped a bonus on it today?
A chart shows both paths side by side, along with how much time and interest
you'd save.

### See where it all went
The **Reports** view breaks your spending into a colorful ring — hover any slice
for the details. Pick this month, last month, the last three months, the year so
far, or everything.

### See what's coming
The **Calendar** lays your month out day by day. Mark a transaction as recurring
and it shows up on future months as a dotted reminder until the real one lands,
so you can see a big bill coming before it arrives.

### Keep more than one budget
Household budget, side business, next year's plan — keep as many as you like,
fully separate, and switch between them from the menu at the top. New budgets can
start empty or with sample data so you can poke around risk-free.

---

## Your privacy

- **Everything stays on your computer.** There's no Sprout company server, no
  account to sign up for, no data sold to anyone.
- **Your budget is locked with your password.** The files on disk are scrambled
  and unreadable without it.
- **Extra protection if you want it.** Turn on two-step sign-in with an
  authenticator app, or skip passwords entirely with Windows Hello, Face ID, or a
  security key.
- **One catch:** because nobody can unlock your budget but you, a forgotten
  password means the data is gone for good. There's no reset link. Keep your
  password somewhere safe, and hold on to the recovery codes Sprout gives you.

---

## Getting started

You'll need [Node.js](https://nodejs.org) installed. Then, in a terminal, from
this folder:

```
npm install --prefix budget-app
npm run build
npm start
```

Open **http://localhost:3178** in your browser, create an account with an email
and password, and you're in. (The email is just your username — no mail is ever
sent.)

Tip: when you create your first budget, tick **Start with demo data** to explore
with fake numbers before committing to your real ones.

### Or run it with Docker

If you'd rather not install Node.js, and you have
[Docker](https://docs.docker.com/get-started/get-docker/) installed:

```
docker compose up -d
```

That builds the app and starts it in the background at
**http://localhost:3178**. To follow along while it starts, or to check on it
later:

```
docker compose logs -f
```

Set your timezone so months roll over at the right time — Sprout uses the
container's clock to decide what "this month" means. Either put it in a `.env`
file next to `docker-compose.yml`:

```
TZ=America/Chicago
```

...or edit the `TZ` line in `docker-compose.yml` directly.

To update after pulling new code, rebuild and restart — your budget is untouched:

```
docker compose up -d --build
```

To stop it: `docker compose down`. That leaves your data alone. **Do not run
`docker compose down -v`** — the `-v` deletes the volume holding your budgets,
and there is no way to get them back.

---

## Questions

**Does this cost anything?** No.

**Do I need a bank connection?** No — you can type everything in by hand. Bank
syncing is a convenience, not a requirement.

**Can I use it on my phone?** It runs in a web browser, so it works on any device
that can reach the computer you installed it on.

**Is my data backed up?** That part's on you. If you started it with `npm start`,
your budget lives in `budget-app/server/data/` — copy that folder somewhere safe
now and then. Under Docker it's in a volume named `sprout-data`; to pull a copy
out into the current folder:

```
docker run --rm -v sprout-data:/data -v "$PWD:/backup" busybox tar czf /backup/sprout-backup.tar.gz -C /data .
```

**Can I put it behind a real domain or HTTPS?** Yes — point a reverse proxy at
port 3178 and Sprout picks up the hostname on its own, including for passkeys.
Passkeys and Windows Hello need HTTPS (or plain `localhost`) to work at all, so
if you're reaching it by IP address, expect to sign in with your password.

---

Building on Sprout or curious how it works under the hood? See
[budget-app/README.md](budget-app/README.md).
