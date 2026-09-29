import { useState, type FormEvent, type ReactNode } from 'react';
import { ApiRequestError } from './api.js';

/** États explicites des pages (PAR-007) : chargement, vide, erreur, interdit. */
export function Loading({ label = 'Chargement…' }: { label?: string }) {
  return (
    <p className="state" role="status" aria-live="polite">
      {label}
    </p>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="state state-empty">{children}</p>;
}

export function ErrorMessage({ error }: { error: unknown }) {
  if (!error) return null;
  const message =
    error instanceof ApiRequestError ? error.message : 'Une erreur inattendue est survenue.';
  const requestId = error instanceof ApiRequestError ? error.body.request_id : '';
  return (
    <div className="alert alert-error" role="alert">
      <p>{message}</p>
      {requestId && <p className="muted">Référence : {requestId}</p>}
    </div>
  );
}

export function Forbidden({ reason }: { reason: string }) {
  return (
    <div className="alert alert-info" role="note">
      <p>Accès non autorisé. {reason}</p>
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
}) {
  const id = `field-${props.name}`;
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

/** Formulaire avec état d’envoi et affichage de l’erreur API. */
export function Form(props: {
  submitLabel: string;
  onSubmit(values: Record<string, string>): Promise<void>;
  children: ReactNode;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = Object.fromEntries(
      [...new FormData(event.currentTarget).entries()].map(([k, v]) => [k, String(v)]),
    );
    setPending(true);
    setError(null);
    try {
      await props.onSubmit(data);
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(false);
    }
  }
  return (
    <form onSubmit={submit} noValidate={false}>
      {props.children}
      <ErrorMessage error={error} />
      <button type="submit" disabled={pending}>
        {pending ? 'Envoi…' : props.submitLabel}
      </button>
    </form>
  );
}
