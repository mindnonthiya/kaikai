"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ActionState } from "@/lib/action-state";

type Action = (form: FormData) => Promise<ActionState>;

/**
 * Form that calls a server action and shows its Thai success/error message.
 * Submits via onSubmit (not the `action` prop) so inputs are kept when validation fails.
 */
export function ActionForm({ action, children, submitLabel, className = "form-grid", resetOnSuccess = true, id }: {
  action: Action; children: React.ReactNode; submitLabel: string; className?: string; resetOnSuccess?: boolean; id?: string;
}) {
  const [state, setState] = useState<ActionState>({});
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setState({});
    startTransition(async () => {
      const result = await action(data);
      setState(result);
      if (result.ok) {
        if (resetOnSuccess) form.reset();
        router.refresh();
      }
    });
  }

  return <form ref={formRef} onSubmit={submit} className={className} id={id}>
    {children}
    <div className="form-footer">
      {state.error && <p className="form-error" role="alert">{state.error}</p>}
      {state.ok && state.message && <p className="form-success" role="status">{state.message}</p>}
      <button className="primary-button" disabled={pending}>{pending ? "กำลังบันทึก…" : submitLabel}</button>
    </div>
  </form>;
}

/** Small button that runs a server action with hidden fields, optionally after a confirm dialog. */
export function ActionButton({ action, fields, label, pendingLabel, confirmText, className = "link-button" }: {
  action: Action; fields: Record<string, string>; label: string; pendingLabel?: string; confirmText?: string; className?: string;
}) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  function run() {
    if (confirmText && !window.confirm(confirmText)) return;
    const data = new FormData();
    for (const [key, value] of Object.entries(fields)) data.set(key, value);
    startTransition(async () => {
      const result = await action(data);
      if (result.error) window.alert(result.error);
      else router.refresh();
    });
  }
  return <button type="button" className={className} onClick={run} disabled={pending}>{pending ? (pendingLabel ?? "กำลังทำรายการ…") : label}</button>;
}
