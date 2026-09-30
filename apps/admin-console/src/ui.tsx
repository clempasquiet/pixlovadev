import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { ApiRequestError } from './api.js';

export function Loading({ label = 'Chargement…' }: { label?: string }) {
  return (
    <p className="state" role="status" aria-live="polite">
      {label}
    </p>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="state">{children}</p>;
}

export function ErrorMessage({ error }: { error: unknown }) {
  if (!error) return null;
  const message =
    error instanceof ApiRequestError
      ? error.message
      : error instanceof Error
        ? error.message
        : 'Une erreur inattendue est survenue.';
  const requestId = error instanceof ApiRequestError ? error.body.request_id : '';
  return (
    <div className="alert alert-error" role="alert">
      <p>{message}</p>
      {requestId && <p className="muted">Référence : {requestId}</p>}
    </div>
  );
}

/** Donnée absente : affichée comme telle, jamais remplacée par une valeur inventée. */
export function Unavailable({ children }: { children: ReactNode }) {
  return (
    <div className="alert alert-info" role="note">
      <p>{children}</p>
    </div>
  );
}

export function Field(props: {
  label: string;
  name: string;
  type?: string;
  autoComplete?: string;
  required?: boolean;
  defaultValue?: string;
  hint?: string;
  inputMode?: 'numeric' | 'email' | 'text';
  pattern?: string;
  minLength?: number;
}) {
  // Identifiant unique : plusieurs formulaires d’une page ont un champ « motif ».
  const id = `field-${props.name}-${useId()}`;
  return (
    <div className="field">
      <label htmlFor={id}>{props.label}</label>
      <input
        id={id}
        name={props.name}
        type={props.type ?? 'text'}
        autoComplete={props.autoComplete}
        required={props.required ?? true}
        defaultValue={props.defaultValue}
        inputMode={props.inputMode}
        pattern={props.pattern}
        minLength={props.minLength}
        aria-describedby={props.hint ? `${id}-hint` : undefined}
      />
      {props.hint && (
        <p className="hint" id={`${id}-hint`}>
          {props.hint}
        </p>
      )}
    </div>
  );
}

/** Motif de consultation ou d’action (ADM-003), toujours saisi explicitement. */
export function ReasonField({ label = 'Motif (ticket, demande client…)' }: { label?: string }) {
  return (
    <Field
      label={label}
      name="reason"
      minLength={5}
      hint="Enregistré dans le journal d’audit de la plateforme."
    />
  );
}

export function Form(props: {
  submitLabel: string;
  danger?: boolean;
  onSubmit(values: Record<string, string>, form: HTMLFormElement): Promise<void>;
  children: ReactNode;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data: Record<string, string> = {};
    for (const [key, value] of new FormData(form).entries()) {
      data[key] = data[key] ? `${data[key]},${String(value)}` : String(value);
    }
    setPending(true);
    setError(null);
    try {
      await props.onSubmit(data, form);
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(false);
    }
  }
  return (
    <form onSubmit={submit}>
      {props.children}
      <ErrorMessage error={error} />
      <button type="submit" disabled={pending} className={props.danger ? 'danger' : undefined}>
        {pending ? 'Envoi…' : props.submitLabel}
      </button>
    </form>
  );
}
