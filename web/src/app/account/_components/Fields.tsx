"use client";

import { useId, useState } from "react";

export function TextField({
  label, name, type = "text", value, onChange, autoComplete, error, hint, required = true, inputMode,
}: {
  label: string; name: string; type?: "text" | "email"; value: string; onChange: (v: string) => void;
  autoComplete?: string; error?: string; hint?: string; required?: boolean; inputMode?: "email" | "text";
}) {
  const id = useId();
  const describedBy = [hint ? `${id}-hint` : "", error ? `${id}-err` : ""].filter(Boolean).join(" ") || undefined;
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-parchment">{label}</label>
      <input id={id} name={name} type={type} value={value} onChange={(e) => onChange(e.target.value)} required={required}
        autoComplete={autoComplete} inputMode={inputMode} maxLength={254} autoCapitalize="none" spellCheck={false}
        aria-invalid={error ? true : undefined} aria-describedby={describedBy} className="field w-full" />
      {hint && <p id={`${id}-hint`} className="text-xs text-mist">{hint}</p>}
      {error && <p id={`${id}-err`} className="text-sm text-danger">{error}</p>}
    </div>
  );
}

export function PasswordField({
  label, name, value, onChange, autoComplete, error, hint,
}: {
  label: string; name: string; value: string; onChange: (v: string) => void;
  autoComplete: "new-password" | "current-password"; error?: string; hint?: string;
}) {
  const id = useId();
  const [shown, setShown] = useState(false);
  const describedBy = [hint ? `${id}-hint` : "", error ? `${id}-err` : ""].filter(Boolean).join(" ") || undefined;
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-parchment">{label}</label>
      <div className="flex gap-2">
        <input id={id} name={name} type={shown ? "text" : "password"} value={value} onChange={(e) => onChange(e.target.value)} required
          autoComplete={autoComplete} maxLength={200} autoCapitalize="none" spellCheck={false}
          aria-invalid={error ? true : undefined} aria-describedby={describedBy} className="field min-w-0 flex-1" />
        <button type="button" className="btn-ghost" aria-pressed={shown} onClick={() => setShown((s) => !s)}>
          {shown ? "Hide" : "Show"}<span className="sr-only"> password</span>
        </button>
      </div>
      {hint && <p id={`${id}-hint`} className="text-xs text-mist">{hint}</p>}
      {error && <p id={`${id}-err`} className="text-sm text-danger">{error}</p>}
    </div>
  );
}

/** Announced to assistive technology and focused after a failed submit so keyboard users land on the problem. */
export function FormAlert({ message, alertRef }: { message: string | null; alertRef: React.RefObject<HTMLDivElement | null> }) {
  return (
    <div ref={alertRef} tabIndex={-1} role="alert" aria-live="assertive" className={message ? "rounded-lg border border-danger/50 bg-danger/10 px-3 py-2 text-sm text-danger outline-none" : "sr-only"}>
      {message ?? ""}
    </div>
  );
}
