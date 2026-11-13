"use client";
import { useState, type FormEvent, type ReactNode } from "react";
import type { Outcome } from "../domain/types";
import { BTN_DANGER, BTN_GHOST, BTN_PRIMARY, Modal, Notice } from "./primitives";

/** A form dialog that runs a simulated action and keeps any denial or validation message visible INSIDE the dialog until it is fixed or closed. */
export function ActionDialog({ open, title, onClose, submit, submitLabel, danger, children, testId }: {
  open: boolean; title: string; onClose: () => void; submit: () => Outcome; submitLabel: string; danger?: boolean; testId?: string;
  children: (errors: Record<string, string>) => ReactNode;
}) {
  const [out, setOut] = useState<Outcome | null>(null);
  const close = (): void => { setOut(null); onClose(); };
  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    const o = submit();
    if (o.ok) close(); else setOut(o);
  };
  const errors = out && !out.ok ? out.fieldErrors ?? {} : {};
  return (
    <Modal open={open} onClose={close} title={title}>
      <form onSubmit={onSubmit} noValidate className="space-y-4" data-testid={testId}>
        {out && !out.ok && (out.kind === "denied" || out.kind === "conflict" || !out.fieldErrors) && (
          <Notice tone={out.kind === "denied" || out.kind === "conflict" ? "error" : "warning"} role="alert" title={out.kind === "denied" ? "Denied" : out.kind === "conflict" ? "Conflict" : "Check your input"}>{out.message}</Notice>
        )}
        {children(errors)}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className={BTN_GHOST} onClick={close}>Cancel</button>
          <button type="submit" className={danger ? BTN_DANGER : BTN_PRIMARY} data-testid={testId ? `${testId}-submit` : undefined}>{submitLabel}</button>
        </div>
      </form>
    </Modal>
  );
}
