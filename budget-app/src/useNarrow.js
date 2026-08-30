import { useEffect, useState } from 'react';

/** Where the layout stops being three columns.
 *
 *  The register alone asks for 474px and the two side panes take another 580,
 *  so on a phone there is no arrangement in which all three fit — one has to
 *  leave the flow and become an overlay. That is a change in behaviour, not
 *  only in appearance, so the breakpoint has to exist in JS as well as in CSS.
 *  Keep this in step with the 860px media queries in styles.css. */
export const NARROW_PX = 860;

const QUERY = `(max-width: ${NARROW_PX}px)`;

export default function useNarrow() {
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(QUERY).matches
  );

  useEffect(() => {
    const mq = window.matchMedia(QUERY);
    const onChange = e => setNarrow(e.matches);
    // re-read on mount: the window can be resized between first render and here
    setNarrow(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return narrow;
}
