import { desc, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import Type from 'typebox';
import { schema, withTenant } from '@pixlova/db';
import { ApiError } from '../errors.js';
import { authorize, requireMember } from '../http/context.js';
import type { Services } from '../http/services.js';
import { Strict } from './schemas.js';

function decodeCursor(cursor: string): { t: string; id: string } {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      t: string;
      id: string;
    };
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    if (
      typeof value.t !== 'string' ||
      typeof value.id !== 'string' ||
      !uuid.test(value.id) ||
      Number.isNaN(Date.parse(value.t))
    ) {
      throw new Error();
    }
    return value;
  } catch {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Curseur invalide.');
  }
}

/** Journal d’audit du tenant, paginé par curseur stable (API-004), permission `audit.read`. */
export function auditRoutes(app: FastifyInstance, services: Services): void {
  app.get(
    '/audit',
    {
      schema: {
        querystring: Type.Object(
          // Paramètres de requête reçus en texte : aucune coercition implicite (API-003).
          {
            limit: Type.Optional(Type.String({ pattern: '^(?:[1-9][0-9]?|1[0-9]{2}|200)$' })),
            cursor: Type.Optional(Type.String({ maxLength: 200 })),
          },
          Strict,
        ),
      },
    },
    async (request) => {
      const member = await requireMember(request, services);
      authorize(member, 'audit.read');
      const query = request.query as { limit?: string; cursor?: string };
      const limit = query.limit ? Number(query.limit) : 50;
      const cursor = query.cursor ? decodeCursor(query.cursor) : null;
      const t = schema.auditLogs;
      const rows = await withTenant(services.db, member.organizationId, (tx) =>
        tx
          // Horodatage en texte : précision microseconde conservée dans le curseur.
          .select({ row: t, at: sql<string>`${t.createdAt}::text` })
          .from(t)
          .where(
            cursor
              ? sql`(${t.createdAt}, ${t.id}) < (${cursor.t}::timestamptz, ${cursor.id}::uuid)`
              : undefined,
          )
          .orderBy(desc(t.createdAt), desc(t.id))
          .limit(limit + 1),
      );
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map(({ row }) => ({
          id: row.id,
          created_at: row.createdAt.toISOString(),
          actor_type: row.actorType,
          actor_id: row.actorId,
          action: row.action,
          permission: row.permission,
          target_type: row.targetType,
          target_id: row.targetId,
          result: row.result,
          reason: row.reason,
          request_id: row.requestId,
          metadata: row.metadata,
        })),
        has_more: rows.length > limit,
        next_cursor:
          rows.length > limit && last
            ? Buffer.from(JSON.stringify({ t: last.at, id: last.row.id })).toString('base64url')
            : null,
      };
    },
  );
}
