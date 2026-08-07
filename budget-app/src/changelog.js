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
    version: '0.6.1',
    date: '2026-07-30',
    title: 'Goals count money you already spent',
    items: [
      {
        heading: 'A funded goal stays funded after you spend it',
        body: 'A $20 monthly gym goal that you funded and then spent still read '
          + '"$0 of $20" and asked for another $20. Progress was being measured '
          + 'against what was left in the category rather than what you put in, '
          + 'so spending undid it. It now counts the money you budgeted, whether '
          + 'or not it has been spent yet. Goals that save toward a date are '
          + 'unchanged: spending the holiday fund really does mean the holiday '
          + 'fund no longer holds what it needs.',
      },
      {
        heading: 'Search and filter the register',
        body: 'Every transaction list now has a search box and a category picker. '
          + 'Search matches payees, memos, categories, account names and amounts, '
          + 'and several words narrow rather than widen — "costco 84" finds the '
          + 'Costco trip that cost $84. The count and total of what you are '
          + 'looking at sit beside it, and selecting rows still works, so you can '
          + 'filter down and delete the lot.',
      },
      {
        heading: 'Uncategorized transactions are one click away',
        body: 'Clicking "Uncategorized Transactions" on the budget opens every '
          + 'account filtered to exactly those, ready to be filed.',
      },
      {
        heading: 'Start the month over',
        body: 'The Assign menu can now clear every assignment at once and put the '
          + 'lot back in Ready to Assign, so you can budget the month again from '
          + 'scratch. It asks twice, and warns you when categories you have '
          + 'already spent from will show overspent until you fund them again.',
      },
    ],
  },
  {
    version: '0.6.0',
    date: '2026-07-30',
    title: 'Undo an overassignment, and see money in vs out',
    items: [
      {
        heading: 'The tab tells you which budget is open',
        body: 'The browser tab now carries the name of the budget you have open '
          + 'rather than a fixed title, so two budgets in two tabs are easy to '
          + 'tell apart. Sprout has a proper icon there too.',
      },
      {
        heading: 'A new Income vs Expenses report',
        body: 'The Reports tab now has a second view: what came in against what '
          + 'went out, month by month. Money in rises above the line, money out '
          + 'falls below it, and a line tracks whether you finished each month '
          + 'ahead or behind. It opens on the last three months and can look '
          + 'back up to two years.',
      },
      {
        heading: 'Put back money you did not have',
        body: 'Assign more than you have and the number at the top turns red. '
          + 'The Assign menu now offers to put it right: it takes money back '
          + 'from the categories that need it furthest in the future — anything '
          + 'without a goal first, then yearly, then quarterly — and leaves next '
          + 'week\'s money where it is. Anything already spent stays spent, and '
          + 'it tells you if it could not cover the whole amount.',
      },
    ],
  },
  {
    version: '0.5.0',
    date: '2026-07-30',
    title: 'Goals on your own schedule',
    items: [
      {
        heading: 'Goals no longer have to be monthly',
        body: 'A goal can now repeat weekly, monthly, quarterly, twice a year or '
          + 'annually. Enter what the thing actually costs — $1,200 a year for '
          + 'insurance — and Sprout works out that it needs $100 a month and asks '
          + 'for that instead, so a big yearly bill never lands all at once.',
      },
      {
        heading: 'Custom schedules',
        body: 'Pick Custom to repeat on your own cadence, like $400 every two '
          + 'months starting in March.',
      },
      {
        heading: 'Save a total by a date',
        body: 'Choose "By a date" for one-off targets — $2,400 by next March. '
          + 'Sprout divides what is still missing by the months left, so the '
          + 'amount it asks for goes up if you fall behind and down if you get '
          + 'ahead.',
      },
      {
        heading: 'Tidier budget and summary',
        body: 'Categories sit indented under their group heading, the summary '
          + 'panel on the right has room to breathe, and date fields match the '
          + 'rest of the app instead of standing out.',
      },
    ],
  },
  {
    version: '0.4.1',
    date: '2026-07-30',
    title: 'Loan Payment is easier to find',
    items: [
      {
        heading: 'Loan Payment is always in the list',
        body: 'It only appeared once you already had a loan account, which made it '
          + 'impossible to find if you were setting one up for the first time. It '
          + 'now sits alongside Transfer / Card Payment every time, and tells you '
          + 'to add a loan account if you have not got one yet.',
      },
    ],
  },
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
