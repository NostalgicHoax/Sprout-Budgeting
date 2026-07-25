// Shared by the server (rule lookups) and the client (live suggestions in the
// transaction editor). Both sides must agree on the key or a payee typed in the
// UI won't line up with the rules stored for it.

/** Normalizes a payee into the key its category rules are stored under.
 *  Banks decorate the same merchant differently between transactions
 *  ("KROGER #452", "Kroger  #0117"), so punctuation, store numbers, and other
 *  bare reference numbers are dropped. */
export function payeeKey(payee) {
  return String(payee ?? '')
    .toLowerCase()
    .replace(/#\s*\w+/g, ' ')      // store / reference numbers: "WALMART #1234"
    .replace(/['’`]/g, '')         // dropped, not spaced: "McDonald's" = "MCDONALDS"
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b\d{3,}\b/g, ' ')   // bare reference numbers
    .replace(/\s+/g, ' ')
    .trim();
}
