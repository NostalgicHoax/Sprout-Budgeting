import { useEffect, useState } from 'react';

/** Where the layout stops being three columns.
 *
 *  The register alone asks for 474px and the two side panes take another 580,
 *  so on a phone there is no arrangement in which all three fit — one has to
 *  leave the flow and become an overlay. That is a change in behaviour, not
 *  only in appearance, so the breakpoint has to exist in JS as well as in CSS.
 *  Keep this in step with the 860px media queries in styles.css. */
export const NARROW_PX = 860;

/** And where it stops being a desktop layout at all: the register stops being a
 *  table, the calendar stops being a grid. Seven columns of a 390px screen is
 *  50px a day, which is not enough for a date and an amount — so this one is a
 *  change in behaviour too. Keep in step with the 560px media queries. */
export const PHONE_PX = 560;

function useMaxWidth(px) {
  const query = `(max-width: ${px}px)`;
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches
  );

  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = e => setMatches(e.matches);
    // re-read on mount: the window can be resized between first render and here
    setMatches(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}

export default function useNarrow() { return useMaxWidth(NARROW_PX); }
export function usePhone() { return useMaxWidth(PHONE_PX); }
