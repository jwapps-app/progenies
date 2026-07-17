import { ReactNode, useEffect, useRef } from "react";

interface Props {
  title: string;
  onClose: () => void;
  children: ReactNode;
}

/** A simple centered modal dialog with a backdrop. Closes on backdrop click or Esc. */
export default function Modal({ title, onClose, children }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Move focus into the dialog on open, so keyboard and screen-reader users
  // land in it instead of staying on the control that opened it.
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-6 shadow-xl outline-none dark:bg-slate-800"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-brand dark:text-brand-soft">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:text-slate-500 dark:hover:text-slate-300"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
