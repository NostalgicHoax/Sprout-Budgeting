// What's New, shown from the sidebar menu.
//
// Add a new entry at the TOP when you release, and bump `version` in
// package.json to match — that field is the single source of truth for the
// version the app reports (vite injects it as __APP_VERSION__), and the
// unread dot keys off it, so a release with no entry here shows an empty
// What's New.
//
// Keep `items` written for the person using the budget, not the person who
// wrote the code: say what they can now do, not which module changed.

/** Version of the running build, from package.json via vite's define. */
export const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';

export const CHANGELOG = [
  {
    version: '0.4.0',
    date: '2026-07-30',
    title: 'See what changed',
    items: [
      {
        heading: 'What\'s New lives in the menu',
        body: 'Sprout now keeps a short note of what changed in each release. '
          + 'Open it from the menu at the top of the sidebar — a green dot appears '
          + 'there whenever there is something you have not read yet.',
      },
    ],
  },
  {
    version: '0.3.0',
    date: '2026-07-30',
    title: 'Loans, bulk edits, and account clean-up',
    items: [
      {
        heading: 'Record a loan payment properly',
        body: 'Paying a car note used to mean recording a transfer, which quietly '
          + 'changed the estimated monthly payment every time. There is now a Loan '
          + 'Payment option next to Transfer: it splits the interest from the '
          + 'principal, so your balance drops by what actually came off the loan, '
          + 'counts one payment off the term, and leaves the monthly figure alone.',
      },
      {
        heading: 'See your progress on the payoff chart',
        body: 'Each payment you record leaves a dot on the loan chart, building a '
          + 'trail behind today so you can see how the real balance compares with '
          + 'the plan.',
      },
      {
        heading: 'Select and delete several transactions at once',
        body: 'Tick the box on any row in the register, or shift-click to grab a '
          + 'whole run. A bar shows how many you picked and what they add up to, '
          + 'with one button to delete the lot.',
      },
      {
        heading: 'Rename, close, or delete an account',
        body: 'The new ⚙ Account menu covers all three. Closing keeps every '
          + 'transaction and tucks the account away; deleting shows you exactly '
          + 'what goes with it — including what returns to Ready to Assign — '
          + 'before you confirm.',
      },
    ],
  },
  {
    version: '0.2.0',
    date: '2026-07-29',
    title: 'Run Sprout in Docker',
    items: [
      {
        heading: 'One-command self-hosting',
        body: 'Sprout ships as a Docker image, so you can run it without '
          + 'installing Node.js. Your budget lives in a volume that survives '
          + 'updates and restarts.',
      },
      {
        heading: 'Your timezone is now required',
        body: 'Sprout works out what "this month" is from the clock where it runs. '
          + 'A container left on UTC could show the wrong month for part of every '
          + 'day, so it now refuses to start until the timezone is set rather than '
          + 'quietly getting it wrong.',
      },
    ],
  },
  {
    version: '0.1.0',
    date: '2026-07-24',
    title: 'First release',
    items: [
      {
        heading: 'Give every dollar a job',
        body: 'Envelope budgeting with rollover and goals, accounts for cash, '
          + 'credit cards and loans, optional bank import through SimpleFIN, '
          + 'reports and a calendar — with every budget encrypted on disk behind '
          + 'your password.',
      },
    ],
  },
];
