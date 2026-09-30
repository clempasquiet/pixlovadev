import { and, asc, eq, isNull, lte, sql } from 'drizzle-orm';
import { createTransport, type Transporter } from 'nodemailer';
import { schema, type Database, type Transaction } from '@pixlova/db';
import type { DataCipher } from './crypto.js';

export type EmailMessage =
  | { template: 'email_verification'; to: string; data: { link: string } }
  | { template: 'account_exists'; to: string; data: { loginLink: string; resetLink: string } }
  | { template: 'password_reset'; to: string; data: { link: string } }
  | { template: 'password_changed'; to: string; data: Record<string, never> }
  | {
      template: 'invitation';
      to: string;
      data: { link: string; organizationName: string; role: string };
    }
  | { template: 'mfa_changed'; to: string; data: { enabled: boolean } }
  | {
      template: 'alert';
      to: string;
      data: {
        kind: 'opened' | 'resolved' | 'reminder';
        rule: string;
        severity: string;
        targetName: string;
        organizationName: string;
        openedAt: string;
        link: string;
      };
    };

/** Libellés des règles d’alerte (ADR-014). */
const ALERT_LABELS: Record<string, string> = {
  player_offline: 'Player hors ligne',
  manifest_not_applied: 'Programmation non appliquée',
  delivery_failed: 'Échec de préparation du contenu',
  playback_errors: 'Erreurs de lecture répétées',
  disk_low: 'Espace disque faible',
};

export interface RenderedEmail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(email: RenderedEmail): Promise<void>;
}

/** Textes en français ; aucun secret autre que le lien à usage unique destiné au titulaire. */
export function renderEmail(message: EmailMessage): RenderedEmail {
  const footer =
    '\n\n— pixlova\nCe message est automatique. Si vous n’êtes pas à l’origine de cette demande, ignorez-le.';
  switch (message.template) {
    case 'email_verification':
      return {
        to: message.to,
        subject: 'Confirmez votre adresse email pixlova',
        text: `Bonjour,\n\nConfirmez votre adresse pour activer votre compte pixlova :\n${message.data.link}${footer}`,
      };
    case 'account_exists':
      return {
        to: message.to,
        subject: 'Un compte pixlova existe déjà avec cette adresse',
        text: `Bonjour,\n\nUne inscription a été tentée avec votre adresse, qui possède déjà un compte.\nSe connecter : ${message.data.loginLink}\nMot de passe oublié : ${message.data.resetLink}${footer}`,
      };
    case 'password_reset':
      return {
        to: message.to,
        subject: 'Réinitialisation de votre mot de passe pixlova',
        text: `Bonjour,\n\nPour choisir un nouveau mot de passe, ouvrez ce lien à usage unique :\n${message.data.link}${footer}`,
      };
    case 'password_changed':
      return {
        to: message.to,
        subject: 'Votre mot de passe pixlova a été modifié',
        text: `Bonjour,\n\nLe mot de passe de votre compte vient d’être modifié et vos autres sessions ont été fermées. Si ce n’est pas vous, réinitialisez-le immédiatement.${footer}`,
      };
    case 'invitation':
      return {
        to: message.to,
        subject: `Invitation à rejoindre ${message.data.organizationName} sur pixlova`,
        text: `Bonjour,\n\nVous êtes invité à rejoindre l’organisation « ${message.data.organizationName} » (rôle : ${message.data.role}).\nAccepter l’invitation : ${message.data.link}${footer}`,
      };
    case 'mfa_changed':
      return {
        to: message.to,
        subject: message.data.enabled
          ? 'Double authentification activée sur votre compte pixlova'
          : 'Double authentification désactivée sur votre compte pixlova',
        text: `Bonjour,\n\nLa double authentification de votre compte a été ${message.data.enabled ? 'activée' : 'désactivée'}. Si ce n’est pas vous, contactez le support.${footer}`,
      };
    case 'alert': {
      const { data } = message;
      const label = ALERT_LABELS[data.rule] ?? data.rule;
      const state = {
        opened: 'Incident ouvert',
        reminder: 'Incident toujours ouvert',
        resolved: 'Incident résolu',
      }[data.kind];
      return {
        to: message.to,
        subject: `[pixlova] ${state} : ${label} — ${data.targetName}`,
        text: `Bonjour,\n\n${state} dans l’organisation « ${data.organizationName} ».\nRègle : ${label} (${data.severity})\nCible : ${data.targetName}\nOuvert le : ${data.openedAt}\n\nDétail et historique : ${data.link}\n\nVous recevez ce message car vous pouvez configurer ce parc. Désabonnement : préférences de supervision.${footer}`,
      };
    }
  }
}

const CONTEXT = 'email_outbox';

/** Inscrit l’email dans la transaction métier : il part seulement si la transaction est validée. */
export async function queueEmail(
  tx: Transaction | Database,
  cipher: DataCipher,
  message: EmailMessage,
): Promise<void> {
  await tx.insert(schema.emailOutbox).values({
    template: message.template,
    recipient: message.to,
    payloadEncrypted: Buffer.from(cipher.encrypt(JSON.stringify(message), CONTEXT), 'utf8'),
  });
}

/**
 * Envoie les emails en attente (rôle système). Verrouillage `SKIP LOCKED` : plusieurs
 * dispatchers peuvent tourner. Le contenu chiffré est effacé après envoi.
 */
export async function dispatchEmails(
  system: Database,
  cipher: DataCipher,
  mailer: Mailer,
  batchSize = 20,
): Promise<number> {
  let sent = 0;
  await system.transaction(async (tx) => {
    const pending = await tx
      .select()
      .from(schema.emailOutbox)
      .where(
        and(isNull(schema.emailOutbox.sentAt), lte(schema.emailOutbox.nextAttemptAt, sql`now()`)),
      )
      .orderBy(asc(schema.emailOutbox.id))
      .limit(batchSize)
      .for('update', { skipLocked: true });
    for (const row of pending) {
      try {
        const message = JSON.parse(
          cipher.decrypt(row.payloadEncrypted!.toString('utf8'), CONTEXT),
        ) as EmailMessage;
        await mailer.send(renderEmail(message));
        await tx
          .update(schema.emailOutbox)
          .set({
            sentAt: sql`now()`,
            payloadEncrypted: null,
            attempts: row.attempts + 1,
            lastError: null,
          })
          .where(eq(schema.emailOutbox.id, row.id));
        sent++;
      } catch (error) {
        const attempts = row.attempts + 1;
        await tx
          .update(schema.emailOutbox)
          .set({
            attempts,
            lastError: String(error).slice(0, 500),
            nextAttemptAt: sql`now() + make_interval(secs => ${Math.min(3600, 2 ** attempts * 30)})`,
          })
          .where(eq(schema.emailOutbox.id, row.id));
      }
    }
  });
  return sent;
}

/** Transport de test et de développement : conserve les messages en mémoire. */
export class MemoryMailer implements Mailer {
  readonly sent: RenderedEmail[] = [];
  async send(email: RenderedEmail): Promise<void> {
    this.sent.push(email);
  }
  linkFor(to: string, path: string): string | undefined {
    const pattern = new RegExp(`https?://[^\\s]*${path.replace(/[/.]/g, '\\$&')}[^\\s]*`);
    return [...this.sent]
      .reverse()
      .find((email) => email.to === to && pattern.test(email.text))
      ?.text.match(pattern)?.[0];
  }
}

/**
 * Transport SMTP (ADR-015) : `smtp://hôte:port` ou `smtps://utilisateur:motdepasse@hôte:465`.
 * En recette, il pointe vers une boîte de capture (Mailpit) : rien ne sort du serveur.
 */
export class SmtpMailer implements Mailer {
  private readonly transport: Transporter;

  constructor(
    url: string,
    private readonly from: string,
  ) {
    this.transport = createTransport(url);
  }

  async send(email: RenderedEmail): Promise<void> {
    await this.transport.sendMail({
      from: this.from,
      to: email.to,
      subject: email.subject,
      text: email.text,
    });
  }
}

/** Développement : affiche les emails dans les logs. Jamais en production (liens à jeton). */
export class ConsoleMailer implements Mailer {
  async send(email: RenderedEmail): Promise<void> {
    process.stdout.write(
      `\n--- email (dev) → ${email.to}\n${email.subject}\n\n${email.text}\n---\n`,
    );
  }
}
