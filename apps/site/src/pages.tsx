import type { ReactNode } from 'react';
import type { Catalog } from './catalog.js';
import type { SiteConfig } from './config.js';
import type { PageMeta } from './layout.js';
import { LEGAL_DOCUMENTS, type LegalDocument } from './legal.js';
import type { Question } from './sections.js';
import {
  Compare,
  Cta,
  Faq,
  Hero,
  LedWall,
  Offline,
  PageHero,
  Pipeline,
  Pricing,
  Replace,
  UseCases,
} from './sections.js';

export interface PageContext {
  readonly config: SiteConfig;
  readonly catalog: Catalog;
}

export interface Page extends PageMeta {
  readonly render: (ctx: PageContext) => ReactNode;
}

const Q_FREE: Question = {
  q: 'Que se passe-t-il si je repasse en Free ?',
  a: (
    <p>
      Rien n’est supprimé. Vos médias, compositions, playlists et plannings restent là. Si plusieurs
      écrans sont actifs, vous choisissez celui qui continue de diffuser.
    </p>
  ),
};
const Q_HARDWARE: Question = {
  q: 'Quel matériel faut-il ?',
  a: (
    <p>
      Pour le Player natif, un ordinateur sous Linux ou Windows relié à l’écran, par exemple un
      mini-PC. Pour le Player Web, n’importe quel appareil capable d’ouvrir un navigateur récent en
      plein écran. Les différences sont détaillées sur la page{' '}
      <a href="/players/">Player natif &amp; Web</a>.
    </p>
  ),
};
const Q_SITES: Question = {
  q: 'Puis-je gérer plusieurs magasins ?',
  a: (
    <p>
      Oui. Une organisation regroupe vos sites et leurs écrans. Chaque membre reçoit un rôle, sur
      toute l’organisation ou seulement sur certains sites.
    </p>
  ),
};
const Q_TEAM: Question = {
  q: 'Mes collègues peuvent-ils publier sans tout casser ?',
  a: (
    <p>
      Les rôles limitent qui peut modifier, publier ou intervenir sur le matériel. Chaque
      publication est une version que l’on peut prévisualiser, et les actions sensibles sont
      inscrites dans un journal.
    </p>
  ),
};
const Q_EXTRA: Question = {
  q: 'Que se passe-t-il si j’ajoute un écran au-delà de mon offre ?',
  a: (
    <p>
      Rien n’est facturé automatiquement : le coût de l’écran supplémentaire vous est présenté et
      vous devez le confirmer.
    </p>
  ),
};
const Q_REPLACE: Question = {
  q: 'Mon Player tombe en panne : je perds ma programmation ?',
  a: (
    <p>
      Non. La programmation appartient à l’écran, pas au boîtier. Vous appairez un nouveau Player,
      il reçoit le même programme, sans licence supplémentaire.
    </p>
  ),
};
const Q_OFFLINE: Question = {
  q: 'Que voit-on à l’écran si Internet est coupé ?',
  a: (
    <p>
      Avec le Player natif, le dernier programme valide continue, plannings compris, tant que ses
      médias sont déjà sur l’appareil. Avec le Player Web, cela dépend de ce que le navigateur a
      conservé en cache.
    </p>
  ),
};
const Q_LED: Question = {
  q: 'Puis-je piloter un mur LED ?',
  a: (
    <p>
      Oui, lorsqu’il est relié à une sortie d’un Player : c’est un écran à la résolution de votre
      contrôleur, aussi atypique soit-elle. La synchronisation de plusieurs sorties et le découpage
      d’un contenu sur plusieurs écrans ne sont pas proposés aujourd’hui.
    </p>
  ),
};

const HOME_FAQ = [Q_FREE, Q_HARDWARE, Q_SITES, Q_TEAM];
const ALL_FAQ = [Q_FREE, Q_EXTRA, Q_HARDWARE, Q_OFFLINE, Q_REPLACE, Q_LED, Q_SITES, Q_TEAM];

const FEATURES: readonly { title: string; items: readonly string[] }[] = [
  {
    title: 'Créer',
    items: [
      'Bibliothèque d’images et de vidéos : envoi par glisser-déposer, dossiers, tags, recherche, corbeille.',
      'Éditeur de compositions à la résolution exacte de l’écran, avec calques, grille et aperçu fidèle.',
      'Horloge et QR code intégrés aux compositions.',
      'Modèles par secteur, prévisualisables par tous et utilisables avec les offres payantes.',
    ],
  },
  {
    title: 'Programmer',
    items: [
      'Playlists avec durées, périodes de validité et ordre de passage.',
      'Plannings dans le fuseau horaire de chaque écran, exceptions datées comprises.',
      'Campagnes datées sur une sélection d’écrans, avec exclusions.',
      'Diffusion immédiate d’un message prioritaire, avec heure de retour au programme.',
      'Explication, écran par écran, de ce qui passera et pourquoi.',
    ],
  },
  {
    title: 'Diffuser',
    items: [
      'Player natif pour Linux et Windows, ou Player Web dans un navigateur.',
      'Programme signé et vérifié par l’écran avant d’être appliqué.',
      'Lecture locale en cas de coupure réseau avec le Player natif.',
      'Remplacement d’un Player sans toucher à la programmation de l’écran.',
    ],
  },
  {
    title: 'Superviser',
    items: [
      'Présence et état de chaque Player, versions désirée et appliquée.',
      'Capture d’écran à la demande, datée, réservée aux personnes autorisées.',
      'Commandes à distance prévues : resynchroniser, redémarrer l’affichage, mettre à jour.',
      'Alertes lorsqu’un écran ne répond plus ou n’applique pas son programme.',
    ],
  },
  {
    title: 'Travailler à plusieurs',
    items: [
      'Organisations, sites et invitations par email.',
      'Rôles par organisation ou par site : propriétaire, administrateur, contenu, exploitation, technicien, lecture.',
      'Double authentification et gestion des sessions.',
      'Journal des actions sensibles.',
    ],
  },
];

export const PAGES: readonly Page[] = [
  {
    path: '/',
    title: 'pixlova — affichage dynamique pour écrans et murs LED',
    description:
      'Pilotez vos écrans et murs LED depuis un seul tableau de bord. Le Player natif continue de diffuser votre programmation même quand Internet est coupé.',
    render: ({ config, catalog }) => (
      <>
        <Hero config={config} />
        <LedWall />
        <Pipeline index="01 — Fonctionnement" />
        <Offline index="02 — Hors ligne" />
        <Replace index="03 — Matériel" />
        <Compare index="04 — Players" />
        <UseCases index="05 — Cas d’usage" />
        <Pricing index="06 — Tarifs" catalog={catalog} config={config} />
        <Faq index="07 — Questions" questions={HOME_FAQ} />
        <Cta config={config} />
      </>
    ),
  },
  {
    path: '/fonctionnalites/',
    title: 'Fonctionnalités',
    description:
      'Médias, compositions, playlists, plannings, campagnes, supervision et travail en équipe : ce que pixlova fait pour vos écrans.',
    render: ({ config }) => (
      <>
        <PageHero
          kicker="Fonctionnalités"
          title="Tout ce qu’il faut pour qu’un écran affiche le bon message."
          lede="De l’envoi d’une image à la supervision d’un parc d’écrans, sans rien installer d’autre que le Player."
        />
        <section className="s features-sec" aria-label="Liste des fonctionnalités">
          <div className="wrap">
            {FEATURES.map((group, i) => (
              <div className="feature-group" key={group.title}>
                <span className="idx mono">{String(i + 1).padStart(2, '0')}</span>
                <h2>{group.title}</h2>
                <ul>
                  {group.items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
        <Pipeline index="Publication" />
        <Offline index="Hors ligne" />
        <Replace index="Matériel" />
        <Cta config={config} />
      </>
    ),
  },
  {
    path: '/players/',
    title: 'Player natif et Player Web',
    description:
      'Comparez le Player natif (Linux, Windows) et le Player Web avant d’installer : fonctionnement hors ligne, stockage, redémarrage et mises à jour.',
    render: ({ config }) => (
      <>
        <PageHero
          kicker="Player natif & Web"
          title="Deux façons de faire tourner un écran. Des garanties différentes."
          lede="Le Player natif est fait pour les écrans qui doivent tenir seuls. Le Player Web permet de démarrer en quelques secondes. Voici ce que chacun garantit, avant d’installer quoi que ce soit."
        />
        <Compare index="Comparaison" />
        <section className="s flush" aria-labelledby="installer">
          <div className="wrap two-col">
            <div>
              <h2 id="installer">Installer le Player natif</h2>
              <ol className="steps">
                <li>
                  Installez l’application sur l’ordinateur relié à l’écran (Linux ou Windows).
                </li>
                <li>Au premier démarrage, elle affiche un code d’appairage temporaire.</li>
                <li>Saisissez ce code dans le tableau de bord et choisissez l’écran à associer.</li>
              </ol>
            </div>
            <div>
              <h2>Ouvrir le Player Web</h2>
              <ol className="steps">
                <li>Ouvrez l’adresse du Player Web dans le navigateur de l’appareil.</li>
                <li>Le code d’appairage s’affiche ; saisissez-le dans le tableau de bord.</li>
                <li>
                  Laissez le navigateur ouvert en plein écran. Si l’appareil redémarre ou si le
                  navigateur vide son cache, la diffusion peut s’interrompre.
                </li>
              </ol>
            </div>
          </div>
        </section>
        <Offline index="Hors ligne" />
        <Cta config={config} />
      </>
    ),
  },
  {
    path: '/cas-usage/',
    title: 'Cas d’usage',
    description:
      'Restauration, commerce, hôtellerie, immobilier, événementiel : comment pixlova change le message de vos écrans au fil de la journée.',
    render: ({ config }) => (
      <>
        <PageHero
          kicker="Cas d’usage"
          title="Un écran utile, c’est un écran qui change au bon moment."
          lede="Quelques exemples de ce que nos plannings, campagnes et messages prioritaires font pour des lieux qui reçoivent du public."
        />
        <UseCases index="Secteurs" />
        <Cta config={config} />
      </>
    ),
  },
  {
    path: '/tarifs/',
    title: 'Tarifs',
    description:
      'Un écran gratuit, puis une base mensuelle avec des écrans inclus et un prix fixe par écran supplémentaire. Calculez le coût de votre parc.',
    render: ({ config, catalog }) => (
      <>
        <PageHero
          kicker="Tarifs"
          title="Un prix par écran, lisible avant de payer."
          lede="Commencez avec un écran gratuit. Passez à une offre payante quand votre parc grandit ; changer d’offre ne supprime aucune donnée."
        />
        <Pricing index="Offres" catalog={catalog} config={config} />
        <Faq index="Questions" questions={[Q_FREE, Q_EXTRA, Q_REPLACE]} />
        <Cta config={config} />
      </>
    ),
  },
  {
    path: '/faq/',
    title: 'Questions fréquentes',
    description:
      'Matériel, coupure Internet, remplacement d’un Player, changement d’offre, travail en équipe : les réponses aux questions fréquentes sur pixlova.',
    render: ({ config }) => (
      <>
        <PageHero
          kicker="FAQ"
          title="Questions fréquentes."
          lede="Une question qui n’est pas ici ? Créez un compte gratuit et essayez avec un écran."
        />
        <Faq index="Réponses" questions={ALL_FAQ} />
        <Cta config={config} />
      </>
    ),
  },
  ...LEGAL_DOCUMENTS.map((doc): Page => ({
    path: doc.path,
    title: doc.title,
    description: doc.description,
    noindex: true,
    render: () => <LegalPage doc={doc} />,
  })),
];

/**
 * Pages légales : modèles génériques dont les champs à compléter restent visibles. Aucune
 * identité juridique n’est inventée ; les pages restent exclues de l’index jusqu’à la
 * validation des textes définitifs.
 */
function LegalPage(props: { doc: LegalDocument }) {
  const { doc } = props;
  return (
    <>
      <section className="page-hero legal" aria-labelledby="titre">
        <div className="wrap">
          <p className="mono kicker">Informations légales</p>
          <h1 id="titre">{doc.title}</h1>
          <p className="lede">
            Modèle générique en cours de finalisation. Les champs entre crochets seront complétés
            avant l’ouverture commerciale du service.
          </p>
        </div>
      </section>
      <section className="legal-body">
        <div className="wrap">
          {doc.sections.map((section) => (
            <section key={section.title}>
              <h2>{section.title}</h2>
              {section.body}
            </section>
          ))}
        </div>
      </section>
    </>
  );
}

export const NOT_FOUND: Page = {
  path: '/404.html',
  title: 'Page introuvable',
  description: 'Cette page n’existe pas.',
  noindex: true,
  render: () => (
    <section className="page-hero" aria-labelledby="titre">
      <div className="wrap">
        <p className="mono kicker">Erreur 404</p>
        <h1 id="titre">Cette page n’existe pas.</h1>
        <p className="lede">Le lien est peut-être ancien, ou l’adresse mal saisie.</p>
        <p>
          <a className="btn solid" href="/">
            Retour à l’accueil
          </a>
        </p>
      </div>
    </section>
  ),
};
