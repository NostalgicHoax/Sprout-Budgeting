import { useEffect, useRef, useState } from 'react';

/** A destructive button that asks for a second click instead of a native
 *  confirm() dialog — browsers can suppress those, which silently swallowed
 *  deletes. Disarms itself after a few seconds so a stray click can't delete. */
export default function ConfirmButton({
  label = 'Delete',
  confirmLabel = 'Confirm delete',
  title,
  className = 'btn btn-danger btn-sm',
  disabled = false,
  onConfirm,
}) {
  const [armed, setArmed] = useState(false);
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  function click(e) {
    e.stopPropagation();
    if (!armed) {
      setArmed(true);
      timer.current = setTimeout(() => setArmed(false), 4000);
      return;
    }
    clearTimeout(timer.current);
    setArmed(false);
    onConfirm();
  }

  return (
    <button
      className={`${className}${armed ? ' armed' : ''}`}
      title={armed ? 'Click again to confirm' : title}
      disabled={disabled}
      onClick={click}
    >
      {armed ? confirmLabel : label}
    </button>
  );
}
