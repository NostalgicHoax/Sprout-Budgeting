import { useRef } from 'react';

/** The drag strip where a side pane meets the middle.
 *
 *  It reports each pointer move as a delta rather than an absolute position, so
 *  the pane keeps ownership of its own limits and decides for itself when a drag
 *  has gone far enough to collapse — a collapsed pane has no width to measure
 *  against, so absolute positions would have nothing to mean.
 *
 *  Pointer capture matters here: without it the drag dies the moment the cursor
 *  outruns the 8px strip, which it does immediately. */
export default function ResizeHandle({ onDrag, onDone, label }) {
  const last = useRef(null);

  function down(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();          // a collapsed pane expands on click; dragging it isn't a click
    e.currentTarget.setPointerCapture(e.pointerId);
    last.current = e.clientX;
    document.body.classList.add('resizing');
  }

  function move(e) {
    if (last.current == null) return;
    const dx = e.clientX - last.current;
    if (dx === 0) return;
    last.current = e.clientX;
    onDrag(dx);
  }

  function end(e) {
    if (last.current == null) return;
    last.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    document.body.classList.remove('resizing');
    onDone?.();
  }

  return (
    <div
      className="resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title={label}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onClick={e => e.stopPropagation()}
    />
  );
}
