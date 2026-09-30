/**
 * Observabilité (OBS-001, OBS-002, ADR-014).
 *
 * - Journaux Pino structurés, expurgés : en-têtes d’authentification et cookies, jetons,
 *   secrets de suivi ; les requêtes sont journalisées sans chaîne de requête (URL signées).
 * - Métriques Prometheus servies par le seul listener interne, avec des labels à
 *   cardinalité bornée : route modèle, méthode, classe de statut. Aucun identifiant
 *   d’organisation, de Player ou d’utilisateur en label.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest, FastifyServerOptions } from 'fastify';
import { schema, type Database } from '@pixlova/db';

const REDACTED = '[expurgé]';

/** Chemins expurgés par Pino (en-têtes et champs de corps éventuellement journalisés). */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["idempotency-key"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.token',
  '*.access_token',
  '*.poll_secret',
  '*.signature',
  '*.secret',
];

/** Chemin seul : la chaîne de requête peut porter une signature de stockage. */
export function pathOnly(url: string | undefined): string {
  if (!url) return '';
  const index = url.indexOf('?');
  return index === -1 ? url : url.slice(0, index);
}

export function loggerOptions(
  level = process.env.PIXLOVA_LOG_LEVEL ?? 'info',
): Exclude<FastifyServerOptions['logger'], boolean | undefined> {
  return {
    level,
    redact: { paths: REDACT_PATHS, censor: REDACTED },
    serializers: {
      req(request: FastifyRequest) {
        return {
          method: request.method,
          url: pathOnly(request.url),
          route: request.routeOptions?.url,
        };
      },
      res(reply: Pick<FastifyReply, 'statusCode'>) {
        return { statusCode: reply.statusCode };
      },
    },
  };
}

export interface Gauge {
  name: string;
  help: string;
  /** Valeurs par combinaison de labels (bornées). */
  samples: { labels: Record<string, string>; value: number }[];
}

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

function escape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function labels(values: Record<string, string>): string {
  const entries = Object.entries(values);
  return entries.length ? `{${entries.map(([k, v]) => `${k}="${escape(v)}"`).join(',')}}` : '';
}

/** Registre en mémoire, par processus : compteurs et histogrammes des requêtes HTTP. */
export class Metrics {
  private readonly requests = new Map<string, { labels: Record<string, string>; count: number }>();
  private readonly durations = new Map<
    string,
    { labels: Record<string, string>; buckets: number[]; sum: number; count: number }
  >();

  observeRequest(route: string, method: string, status: number, seconds: number): void {
    const statusClass = `${Math.floor(status / 100)}xx`;
    const requestKey = `${route}|${method}|${statusClass}`;
    const counter = this.requests.get(requestKey) ?? {
      labels: { route, method, status_class: statusClass },
      count: 0,
    };
    counter.count += 1;
    this.requests.set(requestKey, counter);
    const durationKey = `${route}|${method}`;
    const histogram = this.durations.get(durationKey) ?? {
      labels: { route, method },
      buckets: BUCKETS.map(() => 0),
      sum: 0,
      count: 0,
    };
    BUCKETS.forEach((bound, i) => {
      if (seconds <= bound) histogram.buckets[i]! += 1;
    });
    histogram.sum += seconds;
    histogram.count += 1;
    this.durations.set(durationKey, histogram);
  }

  /** Format d’exposition texte Prometheus 0.0.4. */
  render(gauges: Gauge[] = []): string {
    const lines: string[] = [
      '# HELP pixlova_http_requests_total Requêtes HTTP par route modèle, méthode et classe de statut.',
      '# TYPE pixlova_http_requests_total counter',
    ];
    for (const { labels: l, count } of this.requests.values()) {
      lines.push(`pixlova_http_requests_total${labels(l)} ${count}`);
    }
    lines.push(
      '# HELP pixlova_http_request_duration_seconds Durée des requêtes HTTP.',
      '# TYPE pixlova_http_request_duration_seconds histogram',
    );
    for (const h of this.durations.values()) {
      BUCKETS.forEach((bound, i) => {
        lines.push(
          `pixlova_http_request_duration_seconds_bucket${labels({ ...h.labels, le: String(bound) })} ${h.buckets[i]}`,
        );
      });
      lines.push(
        `pixlova_http_request_duration_seconds_bucket${labels({ ...h.labels, le: '+Inf' })} ${h.count}`,
        `pixlova_http_request_duration_seconds_sum${labels(h.labels)} ${h.sum}`,
        `pixlova_http_request_duration_seconds_count${labels(h.labels)} ${h.count}`,
      );
    }
    for (const gauge of gauges) {
      lines.push(`# HELP ${gauge.name} ${gauge.help}`, `# TYPE ${gauge.name} gauge`);
      for (const sample of gauge.samples) {
        lines.push(`${gauge.name}${labels(sample.labels)} ${sample.value}`);
      }
    }
    return `${lines.join('\n')}\n`;
  }
}

/** Mesure chaque réponse ; une URL sans route connue est regroupée sous `unmatched`. */
export function instrument(app: FastifyInstance, metrics: Metrics): void {
  app.addHook('onResponse', async (request, reply) => {
    metrics.observeRequest(
      request.routeOptions.url ?? 'unmatched',
      request.method,
      reply.statusCode,
      reply.elapsedTime / 1000,
    );
  });
}

/**
 * État du parc au moment de la collecte, agrégé sans identifiant : présence des Players,
 * incidents ouverts, commandes en cours, tâches et emails en attente.
 */
export async function collectGauges(
  system: Database,
  presenceTimeoutSeconds: number,
  now: Date,
): Promise<Gauge[]> {
  const online = new Date(now.getTime() - presenceTimeoutSeconds * 1000);
  const players = await system
    .select({
      presence: sql<string>`case when ${schema.players.lastSeenAt} is null then 'unknown'
        when ${schema.players.lastSeenAt} >= ${online} then 'online' else 'offline' end`,
      n: sql<number>`count(*)::int`,
    })
    .from(schema.players)
    .where(and(eq(schema.players.lifecycleStatus, 'paired'), isNull(schema.players.deletedAt)))
    .groupBy(sql`1`);
  const alerts = await system
    .select({
      rule: schema.alerts.rule,
      severity: schema.alerts.severity,
      n: sql<number>`count(*)::int`,
    })
    .from(schema.alerts)
    .where(eq(schema.alerts.status, 'open'))
    .groupBy(schema.alerts.rule, schema.alerts.severity);
  const commands = await system
    .select({ status: schema.playerCommands.status, n: sql<number>`count(*)::int` })
    .from(schema.playerCommands)
    .where(inArray(schema.playerCommands.status, ['pending', 'sent', 'acknowledged']))
    .groupBy(schema.playerCommands.status);
  const jobs = await system
    .select({ kind: schema.jobs.kind, state: schema.jobs.state, n: sql<number>`count(*)::int` })
    .from(schema.jobs)
    .where(inArray(schema.jobs.state, ['queued', 'running']))
    .groupBy(schema.jobs.kind, schema.jobs.state);
  const [emails] = await system
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.emailOutbox)
    .where(isNull(schema.emailOutbox.sentAt));
  return [
    {
      name: 'pixlova_players',
      help: 'Players appairés par présence vue du serveur.',
      samples: players.map((r) => ({ labels: { presence: r.presence }, value: r.n })),
    },
    {
      name: 'pixlova_alerts_open',
      help: 'Incidents ouverts par règle et sévérité.',
      samples: alerts.map((r) => ({ labels: { rule: r.rule, severity: r.severity }, value: r.n })),
    },
    {
      name: 'pixlova_commands_in_flight',
      help: 'Commandes distantes non terminées par état.',
      samples: commands.map((r) => ({ labels: { status: r.status }, value: r.n })),
    },
    {
      name: 'pixlova_jobs',
      help: 'Tâches du worker en attente ou en cours par type.',
      samples: jobs.map((r) => ({ labels: { kind: r.kind, state: r.state }, value: r.n })),
    },
    {
      name: 'pixlova_email_outbox_pending',
      help: 'Emails en attente d’envoi.',
      samples: [{ labels: {}, value: emails?.n ?? 0 }],
    },
  ];
}
