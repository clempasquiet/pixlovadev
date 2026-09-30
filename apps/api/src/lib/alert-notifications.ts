import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { schema, type Database } from '@pixlova/db';
import { can } from '@pixlova/permissions';
import { loadGrants } from '../http/context.js';
import type { DataCipher } from './crypto.js';
import { queueEmail } from './email.js';

/** Type d’événement écrit par le worker à chaque notification d’incident (ADR-014). */
export const ALERT_NOTIFICATION = 'alert.notification';

type Kind = 'opened' | 'resolved' | 'reminder';

/**
 * Transforme les notifications d’incident du worker en emails (outbox existante, chiffrée).
 * Destinataires : membres actifs, email vérifié, abonnés aux alertes et disposant de
 * `player.configure` sur le site de la cible. Rôle système, verrou `SKIP LOCKED`.
 */
export async function dispatchAlertNotifications(
  system: Database,
  cipher: DataCipher,
  appBaseUrl: string,
  batchSize = 50,
): Promise<number> {
  let queued = 0;
  await system.transaction(async (tx) => {
    const events = await tx
      .select()
      .from(schema.outboxEvents)
      .where(
        and(
          eq(schema.outboxEvents.eventType, ALERT_NOTIFICATION),
          isNull(schema.outboxEvents.dispatchedAt),
        ),
      )
      .orderBy(asc(schema.outboxEvents.id))
      .limit(batchSize)
      .for('update', { skipLocked: true });
    for (const event of events) {
      const kind = (event.payload as { kind?: Kind }).kind ?? 'opened';
      const [row] = await tx
        .select({ alert: schema.alerts, organizationName: schema.organizations.name })
        .from(schema.alerts)
        .innerJoin(schema.organizations, eq(schema.organizations.id, schema.alerts.organizationId))
        .where(eq(schema.alerts.id, event.aggregateId));
      if (row) {
        const { alert } = row;
        const members = await tx
          .select({
            membershipId: schema.memberships.id,
            email: schema.users.emailNormalized,
          })
          .from(schema.memberships)
          .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
          .where(
            and(
              eq(schema.memberships.organizationId, alert.organizationId),
              eq(schema.memberships.status, 'active'),
              eq(schema.memberships.alertEmails, true),
              eq(schema.users.status, 'active'),
              isNotNull(schema.users.emailVerifiedAt),
            ),
          );
        const grants = await loadGrants(
          tx,
          members.map((m) => m.membershipId),
        );
        const details = alert.details as { name?: string };
        const link =
          alert.targetType === 'display'
            ? `${appBaseUrl}/displays/${alert.targetId}`
            : `${appBaseUrl}/incidents`;
        for (const member of members) {
          if (
            !can(grants.get(member.membershipId) ?? [], 'player.configure', {
              siteId: alert.siteId,
            })
          ) {
            continue;
          }
          await queueEmail(tx, cipher, {
            template: 'alert',
            to: member.email,
            data: {
              kind,
              rule: alert.rule,
              severity: alert.severity,
              targetName: details.name ?? alert.targetId,
              organizationName: row.organizationName,
              openedAt: alert.openedAt.toISOString(),
              link,
            },
          });
          queued += 1;
        }
      }
      await tx
        .update(schema.outboxEvents)
        .set({ dispatchedAt: sql`now()`, attempts: event.attempts + 1 })
        .where(eq(schema.outboxEvents.id, event.id));
    }
  });
  return queued;
}
