import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CompositionDocument, DocumentElement } from '@pixlova/contracts';
import { schema, withTenant } from '@pixlova/db';
import { skipDatabaseTests } from '@pixlova/db/testing';
import type { Client } from './support/harness.js';
import { createHarness, createOrganization, signUp, type Harness } from './support/harness.js';

function key(): Record<string, string> {
  return { 'idempotency-key': `test-${randomUUID()}` };
}

const base = { rotation: 0, z_index: 0, opacity: 1, visible: true, locked: false } as const;

function imageElement(id: string, mediaId: string | null): DocumentElement {
  return {
    ...base,
    id,
    type: 'image',
    x: 0,
    y: 0,
    width: 800,
    height: 600,
    props: { media_id: mediaId, fit: 'cover' },
  };
}

function textElement(id: string, value: string): DocumentElement {
  return {
    ...base,
    id,
    type: 'text',
    x: 900,
    y: 100,
    width: 900,
    height: 200,
    props: {
      text: value,
      font_family: 'Montserrat',
      font_size_px: 96,
      font_weight: 800,
      color: '#FFFFFF',
      alignment: 'left',
    },
  };
}

function documentWith(
  elements: DocumentElement[],
  width = 2688,
  height = 672,
): CompositionDocument {
  return {
    schema_version: 1,
    canvas: { width, height, background: '#000000' },
    elements,
    settings: { duration_ms: 10000, audio_policy: 'muted' },
  };
}

describe.skipIf(skipDatabaseTests)('compositions, versions et templates (L04)', () => {
  let h: Harness;
  let owner: Client;
  let org: { id: string; siteId: string };
  let rival: Client;
  let rivalOrg: { id: string; siteId: string };

  /** Média inséré directement (la préparation est couverte par les tests du worker). */
  async function media(
    organizationId: string,
    options: {
      type?: 'image' | 'video';
      status?: 'ready' | 'processing' | 'error';
      siteId?: string | null;
      deleted?: boolean;
    } = {},
  ): Promise<string> {
    const id = randomUUID();
    await withTenant(h.database.app, organizationId, (tx) =>
      tx.insert(schema.media).values({
        id,
        organizationId,
        siteId: options.siteId ?? null,
        name: `média ${id.slice(0, 4)}`,
        type: options.type ?? 'image',
        status: options.status ?? 'ready',
        declaredMimeType: options.type === 'video' ? 'video/mp4' : 'image/png',
        mimeType: options.type === 'video' ? 'video/mp4' : 'image/png',
        originalFilename: 'fichier',
        sizeBytes: 1000,
        checksumSha256: 'a'.repeat(64),
        quotaBytes: 1000,
        ...(options.deleted
          ? { deletedAt: new Date(), purgeAfter: new Date(Date.now() + 86_400_000) }
          : {}),
      }),
    );
    return id;
  }

  async function create(client: Client, name = 'Bandeau', width = 2688, height = 672) {
    const response = await client.request('POST', '/compositions', { name, width, height }, key());
    expect(response.statusCode).toBe(201);
    return response.json() as { id: string; draft_revision: number };
  }

  async function save(client: Client, id: string, revision: number, document: CompositionDocument) {
    return client.request('PUT', `/compositions/${id}/draft`, { revision, document });
  }

  beforeAll(async () => {
    h = await createHarness();
    h.setMaxUsers(10);
    owner = await signUp(h, 'owner@compo.test');
    org = await createOrganization(owner, 'Studio A');
    rival = await signUp(h, 'owner@rival-compo.test');
    rivalOrg = await createOrganization(rival, 'Studio B');
  });
  afterAll(async () => {
    await h?.close();
  });

  describe('brouillon (CMP-007)', () => {
    it('création sur canvas libre, brouillon vide, clé d’idempotence', async () => {
      const created = await create(owner, 'Totem', 768, 2304);
      const detail = (await owner.get(`/compositions/${created.id}`)).json();
      expect(detail).toMatchObject({
        width: 768,
        height: 2304,
        draft_revision: 1,
        published_version: null,
        issues: [],
      });
      expect(detail.document).toMatchObject({ canvas: { width: 768, height: 2304 }, elements: [] });
      expect(
        (await owner.request('POST', '/compositions', { name: 'x', width: 10, height: 10 }))
          .statusCode,
      ).toBe(400);
    });

    it('enregistrement avec révision ; révision périmée ou concurrente refusée sans écrasement', async () => {
      const { id } = await create(owner);
      const first = await save(owner, id, 1, documentWith([textElement('t', 'Première')]));
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({ draft_revision: 2, has_unpublished_changes: true });
      const stale = await save(owner, id, 1, documentWith([textElement('t', 'Écrase')]));
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error).toMatchObject({
        code: 'COMPOSITION_CONFLICT',
        details: { current_revision: 2 },
      });
      const race = await Promise.all([
        save(owner, id, 2, documentWith([textElement('t', 'A')])),
        save(owner, id, 2, documentWith([textElement('t', 'B')])),
      ]);
      expect(race.map((r) => r.statusCode).sort()).toEqual([200, 409]);
      const kept = (await owner.get(`/compositions/${id}`)).json();
      expect(kept.draft_revision).toBe(3);
      const winner = race.find((r) => r.statusCode === 200)!.json();
      expect(['A', 'B']).toContain(kept.document.elements[0].props.text);
      expect(winner.draft_revision).toBe(3);
    });

    it('document invalide refusé : police non qualifiée, propriété inconnue, script', async () => {
      const { id } = await create(owner);
      const badFont = documentWith([textElement('t', 'x')]);
      (badFont.elements[0]!.props as { font_family: string }).font_family = 'Comic Sans MS';
      expect((await save(owner, id, 1, badFont)).statusCode).toBe(400);
      const injected = documentWith([textElement('t', 'x')]) as unknown as {
        elements: Record<string, unknown>[];
      };
      injected.elements[0]!.html = '<script>alert(1)</script>';
      expect(
        (await save(owner, id, 1, injected as unknown as CompositionDocument)).statusCode,
      ).toBe(400);
      expect((await owner.get(`/compositions/${id}`)).json().draft_revision).toBe(1);
    });
  });

  describe('publication (CMP-005, MED-007)', () => {
    it('médias manquants, supprimés, d’un autre tenant, en préparation ou du mauvais type : refus détaillé', async () => {
      const { id } = await create(owner);
      const foreign = await media(rivalOrg.id);
      const deleted = await media(org.id, { deleted: true });
      const processing = await media(org.id, { status: 'processing' });
      const video = await media(org.id, { type: 'video' });
      const lyon = (await owner.post('/sites', { name: 'Lyon' })).json().id;
      const otherSite = await media(org.id, { siteId: lyon });
      const document = documentWith([
        imageElement('vide', null),
        imageElement('etranger', foreign),
        imageElement('corbeille', deleted),
        imageElement('prepa', processing),
        imageElement('video', video),
        imageElement('site', otherSite),
      ]);
      await save(owner, id, 1, document);
      const refused = await owner.post(`/compositions/${id}/publish`, { revision: 2 });
      expect(refused.statusCode).toBe(422);
      expect(refused.json().error.code).toBe('COMPOSITION_INVALID');
      const byElement = Object.fromEntries(
        refused
          .json()
          .error.details.issues.map((i: { element_id: string; code: string }) => [
            i.element_id,
            i.code,
          ]),
      );
      expect(byElement).toEqual({
        vide: 'MEDIA_REQUIRED',
        etranger: 'MEDIA_NOT_FOUND',
        corbeille: 'MEDIA_DELETED',
        prepa: 'MEDIA_NOT_READY',
        video: 'MEDIA_TYPE_MISMATCH',
        site: 'MEDIA_SCOPE_MISMATCH',
      });
      expect((await owner.get(`/compositions/${id}`)).json().published_version).toBeNull();
      // Le média d’un autre tenant n’est jamais décrit (aucune divulgation de son nom).
      expect(JSON.stringify(refused.json())).not.toContain(`média ${foreign.slice(0, 4)}`);
    });

    it('version immuable, historique, restauration en nouvelle version', async () => {
      const photo = await media(org.id);
      const { id } = await create(owner);
      await save(
        owner,
        id,
        1,
        documentWith([imageElement('photo', photo), textElement('titre', 'Version 1')]),
      );
      expect((await owner.post(`/compositions/${id}/publish`, { revision: 1 })).statusCode).toBe(
        409,
      );
      const v1 = await owner.post(`/compositions/${id}/publish`, { revision: 2 });
      expect(v1.statusCode).toBe(201);
      expect(v1.json()).toMatchObject({
        version: 1,
        composition: { published_version: 1, has_unpublished_changes: false },
      });

      await save(owner, id, 2, documentWith([textElement('titre', 'Version 2')]));
      expect((await owner.get(`/compositions/${id}`)).json()).toMatchObject({
        has_unpublished_changes: true,
        published_version: 1,
      });
      // L’édition du brouillon ne modifie pas la version publiée.
      expect(
        (await owner.get(`/compositions/${id}/versions/1`)).json().document.elements[1].props.text,
      ).toBe('Version 1');
      expect(
        (await owner.post(`/compositions/${id}/publish`, { revision: 3 })).json().version,
      ).toBe(2);

      const restored = await owner.post(`/compositions/${id}/restore-version`, { version: 1 });
      expect(restored.statusCode).toBe(201);
      expect(restored.json()).toMatchObject({ version: 3, composition: { published_version: 3 } });
      const versions = (await owner.get(`/compositions/${id}/versions`)).json().items;
      expect(
        versions.map((v: { version: number; restored_from: number | null }) => [
          v.version,
          v.restored_from,
        ]),
      ).toEqual([
        [3, 1],
        [2, null],
        [1, null],
      ]);
      expect((await owner.get(`/compositions/${id}`)).json().document.elements[1].props.text).toBe(
        'Version 1',
      );

      // Le rôle applicatif ne peut ni modifier ni supprimer une version publiée.
      for (const statement of [
        sql`update composition_versions set version = 99 where composition_id = ${id}`,
        sql`delete from composition_versions where composition_id = ${id}`,
      ]) {
        const failure = await withTenant(h.database.app, org.id, (tx) =>
          tx.execute(statement),
        ).catch((error: { cause?: { message?: string } }) => error);
        expect(String((failure as { cause?: { message?: string } }).cause?.message)).toMatch(
          /permission denied/,
        );
      }

      const actions = (await owner.get('/audit?limit=200'))
        .json()
        .items.map((e: { action: string }) => e.action);
      expect(actions).toEqual(
        expect.arrayContaining([
          'composition.created',
          'composition.published',
          'composition.version_restored',
        ]),
      );
    });

    it('usages d’un média : version publiée bloquante, brouillon signalé ; purge refusée', async () => {
      const photo = await media(org.id);
      const { id } = await create(owner, 'Affiche');
      await save(owner, id, 1, documentWith([imageElement('photo', photo)]));
      const draftOnly = (await owner.get(`/media/${photo}/usages`)).json().items;
      expect(draftOnly).toEqual([
        expect.objectContaining({ type: 'composition_draft', id, blocking: false }),
      ]);
      await owner.post(`/compositions/${id}/publish`, { revision: 2 });
      const usages = (await owner.get(`/media/${photo}/usages`)).json().items;
      expect(usages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'composition_version', id, version: 1, blocking: true }),
        ]),
      );
      const refused = await owner.delete(`/media/${photo}`);
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error.code).toBe('MEDIA_IN_USE');
      expect((await owner.request('DELETE', `/media/${photo}?force=true`)).statusCode).toBe(204);
      const purge = await owner.post(`/media/${photo}/purge`);
      expect(purge.statusCode).toBe(409);
      expect(purge.json().error.code).toBe('MEDIA_REFERENCED');
    });
  });

  describe('templates (TPL-001, TPL-002)', () => {
    it('catalogue consultable en Free, instanciation refusée sans droit', async () => {
      const catalog = (await owner.get('/templates')).json().items;
      expect(catalog.length).toBeGreaterThanOrEqual(6);
      expect(catalog.every((t: { available: boolean }) => t.available === false)).toBe(true);
      const refused = await owner.request(
        'POST',
        '/templates/bandeau-led-promotion/instantiate',
        { name: 'Promo' },
        key(),
      );
      expect(refused.statusCode).toBe(403);
      expect(refused.json().error).toMatchObject({
        code: 'ENTITLEMENT_REQUIRED',
        details: { features: ['templates'] },
      });
    });

    it('avec droit : copie indépendante, placeholders remplis, médias du tenant seulement', async () => {
      h.setFeatures(['templates']);
      const logo = await media(org.id);
      const created = await owner.request(
        'POST',
        '/templates/bandeau-led-promotion/instantiate',
        { name: 'Promo hiver', values: { message: 'Grande braderie', logo } },
        key(),
      );
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({
        width: 2688,
        height: 672,
        source_template: { key: 'bandeau-led-promotion', version: 1 },
      });
      const document = (await owner.get(`/compositions/${created.json().id}`)).json().document;
      expect(document.elements.find((e: { id: string }) => e.id === 'message').props.text).toBe(
        'Grande braderie',
      );
      expect(document.elements.find((e: { id: string }) => e.id === 'logo').props.media_id).toBe(
        logo,
      );

      const foreign = await media(rivalOrg.id);
      const stolen = await owner.request(
        'POST',
        '/templates/bandeau-led-promotion/instantiate',
        { name: 'x', values: { logo: foreign } },
        key(),
      );
      expect(stolen.statusCode).toBe(422);
      const unknown = await owner.request(
        'POST',
        '/templates/bandeau-led-promotion/instantiate',
        { name: 'x', values: { inconnu: 'x' } },
        key(),
      );
      expect(unknown.statusCode).toBe(422);
      expect(
        (await owner.request('POST', '/templates/inexistant/instantiate', { name: 'x' }, key()))
          .statusCode,
      ).toBe(404);
      h.setFeatures([]);
    });
  });

  describe('isolation (SEC-003)', () => {
    it('une autre organisation ne voit ni ne modifie aucune composition', async () => {
      const { id } = await create(owner, 'Privée');
      for (const path of [
        `/compositions/${id}`,
        `/compositions/${id}/versions`,
        `/compositions/${id}/versions/1`,
      ]) {
        expect((await rival.get(path)).statusCode).toBe(404);
      }
      expect((await save(rival, id, 1, documentWith([]))).statusCode).toBe(404);
      expect((await rival.post(`/compositions/${id}/publish`, { revision: 1 })).statusCode).toBe(
        404,
      );
      expect(
        (await rival.post(`/compositions/${id}/duplicate`, { name: 'Copie' })).statusCode,
      ).toBe(404);
      expect((await rival.delete(`/compositions/${id}`)).statusCode).toBe(404);
      expect(
        (await rival.get('/compositions')).json().items.map((c: { id: string }) => c.id),
      ).not.toContain(id);
    });

    it('duplication puis suppression logique', async () => {
      const { id } = await create(owner, 'Original');
      const copy = await owner.post(`/compositions/${id}/duplicate`, { name: 'Copie' });
      expect(copy.statusCode).toBe(201);
      expect((await owner.delete(`/compositions/${id}`)).statusCode).toBe(204);
      expect((await owner.get(`/compositions/${id}`)).statusCode).toBe(404);
      expect(
        (await owner.get('/compositions')).json().items.map((c: { name: string }) => c.name),
      ).toContain('Copie');
    });
  });
});
