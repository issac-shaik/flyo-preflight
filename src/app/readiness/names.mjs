// Ticket name vs travel-document name comparison.
// Airlines deny boarding for name mismatches; Indian passports frequently have
// empty surnames, swapped order, or middle names that are missing from the ticket.

const TITLES = new Set(['MR', 'MRS', 'MS', 'MISS', 'MSTR', 'MASTER', 'DR', 'PROF', 'SHRI', 'SMT', 'KUM']);

export const normName = (s) =>
  String(s || '')
    .toUpperCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Z ]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !TITLES.has(t));

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

/**
 * @returns {{ level: 'pass'|'warn'|'fail', detail: string, score: number }}
 */
export function compareNames(ticket, doc) {
  const tFirst = normName(ticket.first_name);
  const tLast = normName(ticket.last_name);
  const dGiven = normName(doc.given_names);
  const dSur = normName(doc.surname);
  const t = [...tFirst, ...tLast];
  const d = [...dGiven, ...dSur];
  if (!t.length || !d.length) return { level: 'warn', detail: 'Name could not be compared', score: 0 };

  const docLabel = `${dSur.join(' ') || '(no surname)'} / ${dGiven.join(' ')}`;
  const same = (x, y) => x.join(' ') === y.join(' ');
  if (same(tFirst, dGiven) && same(tLast, dSur)) return { level: 'pass', detail: 'Ticket name matches passport exactly', score: 1 };
  if (same(tFirst, dSur) && same(tLast, dGiven)) {
    return { level: 'warn', detail: `First and last name appear swapped on the ticket vs passport (${docLabel})`, score: 0.8 };
  }
  const tSet = [...t].sort().join(' ');
  const dSet = [...d].sort().join(' ');
  if (tSet === dSet) {
    return { level: 'warn', detail: `Same names in a different order (passport: ${docLabel}). Many airlines accept this; confirm with the carrier.`, score: 0.85 };
  }
  // Indian passports with a single name: surname empty, everything in given names
  if (!dSur.length && same(t.slice().sort(), d.slice().sort())) {
    return { level: 'warn', detail: 'Passport has no surname; airline FNU/LNU convention may apply', score: 0.8 };
  }
  // Middle name on passport, missing on ticket
  if (t.every((tok) => d.includes(tok)) && d.length > t.length) {
    const extra = d.filter((x) => !t.includes(x)).join(' ');
    return { level: 'warn', detail: `Passport includes "${extra}" which is not on the ticket. Usually accepted; middle names are often omitted.`, score: 0.75 };
  }
  // Typo detection
  const dist = levenshtein(t.join(''), d.join(''));
  if (dist <= 2) {
    return { level: 'fail', detail: `Ticket name looks like a typo of the passport name (${docLabel}); get the airline to correct it before check-in`, score: 0.6 };
  }
  return { level: 'fail', detail: `Ticket name "${t.join(' ')}" does not match passport (${docLabel})`, score: 0 };
}

/** Pick the passenger index whose ticket name best matches a document holder; -1 if none is plausible. */
export function bestPassengerMatch(passengers, doc) {
  let best = -1;
  let bestScore = 0.5;
  passengers.forEach((p, i) => {
    const { score } = compareNames(p, doc);
    if (score > bestScore) { best = i; bestScore = score; }
  });
  return best;
}
