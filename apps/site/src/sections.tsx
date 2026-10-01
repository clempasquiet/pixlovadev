import type { ReactNode } from 'react';
import type { Catalog } from './catalog.js';
import { cheapestQuote, euros, formula } from './catalog.js';
import type { SiteConfig } from './config.js';
import { appLinks, SectionHead } from './layout.js';

export function Hero(props: { config: SiteConfig }) {
  const app = appLinks(props.config);
  return (
    <section className="hero" aria-labelledby="titre">
      <div className="wrap hero-grid">
        <h1 id="titre">
          Vos écrans diffusent. <em>Même quand Internet&nbsp;lâche.</em>
        </h1>
        <div>
          <p className="lede">
            pixlova pilote vos écrans et murs LED depuis un seul tableau de bord&nbsp;: médias,
            playlists, plannings, campagnes. Le Player natif garde la dernière programmation valide
            et continue de la diffuser si le réseau tombe.
          </p>
          <div className="ctas">
            <a className="btn pink" href={app.register}>
              Créer un compte gratuit <span aria-hidden="true">→</span>
            </a>
            <a className="btn" href="/fonctionnalites/">
              Voir les fonctionnalités
            </a>
          </div>
          <p className="fine mono">1 écran gratuit, sans carte bancaire</p>
        </div>
      </div>
    </section>
  );
}

const WALL_TEXT = 'Service du midi, 11 h 30 à 14 h 30. Plat du jour : risotto aux cèpes, 14,50 €.';

/** Mur LED illustratif : dessiné par `site.js`, avec un équivalent textuel. */
export function LedWall() {
  return (
    <figure className="wall-sec">
      <div className="wrap">
        <div className="wall">
          <canvas className="led" role="img" aria-label={`Exemple de mur LED. ${WALL_TEXT}`} />
          <p className="wall-fallback">
            <span className="mono">Service du midi · 11:30 – 14:30</span>
            <strong>Plat du jour</strong>
            <span>Risotto aux cèpes · 14,50 €</span>
          </p>
          <dl className="wall-meta mono">
            <div>
              <dt>Display</dt>
              <dd>Façade · Bistrot</dd>
            </div>
            <div>
              <dt>Format</dt>
              <dd>Mur LED 3,84 × 0,88 m</dd>
            </div>
            <div>
              <dt>Player</dt>
              <dd>Natif · Linux</dd>
            </div>
            <div>
              <dt>Programmation</dt>
              <dd>Planning « Service midi »</dd>
            </div>
            <div>
              <dt>Réseau</dt>
              <dd className="pk">Hors ligne · diffusion maintenue</dd>
            </div>
          </dl>
        </div>
        <figcaption className="caption mono">
          <span>Exemple — contenu du service de midi, diffusé depuis le cache local du Player</span>
        </figcaption>
      </div>
    </figure>
  );
}

const STEPS = [
  {
    title: 'Médias',
    text: 'Images et vidéos importées, converties, puis contrôlées. Un fichier corrompu n’atteint jamais un écran.',
    tag: 'Contrôle d’intégrité',
  },
  {
    title: 'Compositions',
    text: 'Paysage, portrait ou formats LED hors norme : la mise en page suit la résolution réelle de l’écran.',
    tag: 'Formats libres',
  },
  {
    title: 'Programmation',
    text: 'Playlists, plannings horaires, campagnes datées et messages urgents, avec des priorités claires.',
    tag: 'Aperçu avant diffusion',
  },
  {
    title: 'Publication',
    text: 'Un programme signé par écran. Un programme incomplet ou destiné à une autre organisation est refusé.',
    tag: 'Programme signé',
  },
  {
    title: 'Écran',
    text: 'Le Player prépare tout en arrière-plan, bascule d’un coup et garde la version précédente en secours.',
    tag: 'Retour arrière possible',
  },
] as const;

export function Pipeline(props: { index: string }) {
  return (
    <section className="s" aria-labelledby="fonctionnement">
      <div className="wrap">
        <SectionHead
          index={props.index}
          id="fonctionnement"
          title="De votre clic à l’écran, rien n’est laissé au hasard."
          lede="Chaque écran reçoit un programme complet, vérifié et propre à votre organisation. Il ne bascule dessus qu’une fois tout téléchargé : pas d’écran noir, pas de vidéo à moitié chargée."
        />
        <ol className="pipe">
          {STEPS.map((step, i) => (
            <li key={step.title} className={i === STEPS.length - 1 ? 'st hl' : 'st'}>
              <span className="n mono">Étape {String(i + 1).padStart(2, '0')}</span>
              <h3>{step.title}</h3>
              <p>{step.text}</p>
              <span className="tag mono">{step.tag}</span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

const HOURS = ['08:00', '10:00', '12:00', '14:00', '16:00', '18:00', '20:00'];

export function Offline(props: { index: string }) {
  return (
    <section className="s dark" aria-labelledby="hors-ligne">
      <div className="wrap">
        <SectionHead
          index={props.index}
          id="hors-ligne"
          title="Une coupure de 2 h 23. Vos clients n’ont rien vu."
          lede="Le Player natif lit son programme depuis le disque de l’écran. Quand la connexion revient, il récupère les changements et remonte son état. Votre planning n’attend pas le cloud."
        />
        <figure className="timeline">
          <figcaption className="sr-only">
            Exemple de journée : connexion coupée de 11 h 42 à 14 h 05, diffusion continue du
            petit-déjeuner à l’happy hour.
          </figcaption>
          <div className="tl-row" aria-hidden="true">
            <span className="lbl mono">Connexion cloud</span>
            <div className="track">
              <div className="seg net" style={{ left: 0, width: '30.8%' }}>
                En ligne
              </div>
              <div className="seg gap" style={{ left: '30.8%', width: '19.2%' }}>
                Coupure<span className="hide-m">&nbsp;11:42 → 14:05</span>
              </div>
              <div className="seg net" style={{ left: '50%', width: '50%' }}>
                En ligne<span className="hide-m">&nbsp;· synchronisé à 14:06</span>
              </div>
              <div className="gapmark" style={{ left: '30.8%' }} />
              <div className="gapmark" style={{ left: '50%' }} />
            </div>
          </div>
          <div className="tl-row" aria-hidden="true">
            <span className="lbl mono">Diffusion à l’écran</span>
            <div className="track">
              <div className="seg play" style={{ left: 0, width: '25%' }}>
                Petit-déj<span className="hide-m">euner</span>
              </div>
              <div className="seg play alt" style={{ left: '25%', width: '29%' }}>
                <span className="hide-m">Service&nbsp;</span>midi
                <span className="hide-m">&nbsp;· plat du jour</span>
              </div>
              <div className="seg play" style={{ left: '54%', width: '25%' }}>
                Après-midi
              </div>
              <div className="seg play alt" style={{ left: '79%', width: '21%' }}>
                Happy<span className="hide-m">&nbsp;hour</span>
              </div>
            </div>
          </div>
          <div className="axis" aria-hidden="true">
            <div />
            <div className="ticks mono">
              {HOURS.map((h) => (
                <span key={h}>{h}</span>
              ))}
            </div>
          </div>
        </figure>
        <div className="off-notes">
          <div />
          <div>
            <h3>Préparé à l’avance</h3>
            <p>Les médias du programme sont téléchargés et vérifiés avant d’être utilisés.</p>
          </div>
          <div>
            <h3>Activé d’un bloc</h3>
            <p>Le nouveau programme remplace l’ancien en une fois, jamais à moitié.</p>
          </div>
          <div>
            <h3>Toujours un secours</h3>
            <p>La version précédente reste disponible si quelque chose se passe mal.</p>
          </div>
        </div>
        <p className="warn">
          Le fonctionnement hors ligne concerne le Player natif, avec des contenus déjà
          synchronisés. Le Player Web, qui tourne dans un navigateur, dépend des capacités de ce
          navigateur et n’offre pas les mêmes garanties.
        </p>
      </div>
    </section>
  );
}

export function Replace(props: { index: string }) {
  return (
    <section className="s" aria-labelledby="materiel">
      <div className="wrap">
        <SectionHead
          index={props.index}
          id="materiel"
          title="Changez le boîtier. Gardez la programmation."
          lede="Dans pixlova, l’écran que vous programmez et le boîtier qui le fait tourner sont deux choses distinctes. Un Player tombe en panne ? Vous en appairez un nouveau, il reprend exactement là où l’autre s’est arrêté."
        />
        <div className="rep">
          <div className="card">
            <div className="top mono">
              <span>Display</span>
              <span>Licence conservée</span>
            </div>
            <h3>Vitrine · Boutique Lyon 2</h3>
            <dl className="kv">
              <dt>Format</dt>
              <dd>Écran 55″ portrait · 1080 × 1920</dd>
              <dt>Programmation</dt>
              <dd>Playlist « Soldes d’automne » + planning soirée</dd>
              <dt>Campagne</dt>
              <dd>Black Friday · du 24 au 30 nov.</dd>
              <dt>Historique</dt>
              <dd>Conservé</dd>
            </dl>
          </div>
          <div className="arrow mono" aria-hidden="true">
            <span>exécuté par</span>
            <div className="ln" />
          </div>
          <div className="players">
            <div className="pl dead">
              <span>
                <b>Player A · mini-PC</b>
                <span className="mono sub">Retiré le 14/10</span>
              </span>
              <span className="mono">Hors service</span>
            </div>
            <div className="pl">
              <span>
                <b>Player B · mini-PC</b>
                <span className="mono sub">Appairé le 14/10 par code</span>
              </span>
              <span className="mono">
                <span className="dot" aria-hidden="true" />
                Diffuse
              </span>
            </div>
            <p className="mono note">Les autres écrans du magasin ne sont pas interrompus.</p>
          </div>
        </div>
        <div className="rep-foot">
          <div>
            <h3>Une licence par écran</h3>
            Vous payez des emplacements d’écran, pas des boîtiers. Remplacer du matériel ne coûte
            rien.
          </div>
          <div>
            <h3>Appairage par code</h3>
            Le Player affiche un code, vous le saisissez dans le tableau de bord. C’est tout.
          </div>
          <div>
            <h3>Natif ou Web, au choix</h3>
            Le même écran peut tourner sur un Player natif ou dans un navigateur, sans double
            licence.
          </div>
        </div>
      </div>
    </section>
  );
}

const COMPARE: readonly (readonly [string, string, string, boolean, boolean])[] = [
  [
    'Installation',
    'Application pour ordinateur Linux ou Windows relié à l’écran',
    'Une adresse ouverte dans un navigateur',
    false,
    false,
  ],
  [
    'Coupure Internet',
    'Continue avec le dernier programme valide',
    'Dépend du cache du navigateur',
    true,
    false,
  ],
  [
    'Stockage des médias',
    'Cache local vérifié, nettoyé automatiquement',
    'Limité et parfois vidé par le navigateur',
    true,
    false,
  ],
  [
    'Redémarrage après panne',
    'Reprise automatique de la diffusion',
    'À configurer sur l’appareil',
    true,
    false,
  ],
  [
    'Mises à jour',
    'Signées, avec retour à la version précédente',
    'Automatiques au rechargement',
    true,
    true,
  ],
  [
    'Idéal pour',
    'Vitrines, murs LED, écrans sans surveillance',
    'Démarrer vite, écrans d’appoint, essais',
    false,
    false,
  ],
];

export function Compare(props: { index: string }) {
  return (
    <section className="s flush" aria-labelledby="players">
      <div className="wrap">
        <SectionHead
          index={props.index}
          id="players"
          title="Natif ou navigateur : ce que chacun garantit vraiment."
          lede="On préfère vous le dire ici plutôt que vous le laisser découvrir en vitrine."
        />
        <div className="table-scroll">
          <table>
            <caption className="sr-only">Comparaison du Player natif et du Player Web</caption>
            <thead>
              <tr>
                <th scope="col">Critère</th>
                <th scope="col" className="col-native">
                  Player natif
                </th>
                <th scope="col">Player Web</th>
              </tr>
            </thead>
            <tbody>
              {COMPARE.map(([label, native, web, nativeOk, webOk]) => (
                <tr key={label}>
                  <th scope="row">{label}</th>
                  <td className={`col-native${nativeOk ? ' y' : ''}`}>{native}</td>
                  <td
                    className={
                      webOk ? 'y' : label === 'Installation' || label === 'Idéal pour' ? '' : 'p'
                    }
                  >
                    {web}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

export const USE_CASES = [
  {
    sector: 'Restauration',
    title: 'Menus par service',
    text: 'Le petit-déjeuner à 7 h, le plat du jour à 11 h 30, la carte du soir à 18 h. Sans y penser.',
    screen: ['Plat du jour · risotto', '14,50 €'],
    portrait: false,
  },
  {
    sector: 'Commerce',
    title: 'Vitrines et promotions',
    text: 'Une campagne datée pour les soldes, qui s’arrête toute seule à minuit le dernier jour.',
    screen: ['Soldes', '−30 %'],
    portrait: true,
  },
  {
    sector: 'Hôtellerie',
    title: 'Accueil et événements',
    text: 'Le programme du séminaire dans le hall, le message de bienvenue dans les étages.',
    screen: ['Salle Monceau · 14:00', 'Bienvenue'],
    portrait: false,
  },
  {
    sector: 'Immobilier',
    title: 'Annonces en vitrine',
    text: 'Les biens du moment en rotation, mis à jour depuis le bureau sans toucher à l’écran.',
    screen: ['T3 · 68 m² · balcon', '320 000 €'],
    portrait: false,
  },
  {
    sector: 'Événementiel',
    title: 'Signalétique et programme',
    text: 'Un message prioritaire en un clic quand une salle change ou qu’une séance est décalée.',
    screen: ['Message prioritaire', 'Salle B → D'],
    portrait: false,
  },
] as const;

export function UseCases(props: { index: string }) {
  return (
    <section className="s flush" aria-labelledby="cas-usage">
      <div className="wrap">
        <SectionHead
          index={props.index}
          id="cas-usage"
          title="Pour les lieux qui changent de message dans la journée."
          lede="Des modèles prêts à l’emploi par secteur, à dupliquer et adapter avec les offres payantes."
        />
        <ul className="uc">
          {USE_CASES.map((uc) => (
            <li className="uc-row" key={uc.sector}>
              <span className="n mono">{uc.sector}</span>
              <h3>{uc.title}</h3>
              <p>{uc.text}</p>
              <div className={uc.portrait ? 'mini portrait' : 'mini'} aria-hidden="true">
                <span>{uc.screen[0]}</span>
                <span className="big">{uc.screen[1]}</span>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

const CALC_MAX = 60;
const CALC_DEFAULT = 14;

export function Pricing(props: { index: string; catalog: Catalog; config: SiteConfig }) {
  const { catalog } = props;
  const app = appLinks(props.config);
  const table = Array.from({ length: CALC_MAX }, (_, i) => {
    const q = cheapestQuote(catalog, i + 1);
    return q ? `${q.plan.name} · ${formula(q)}` : '';
  });
  const initial = table[CALC_DEFAULT - 1] ?? '';
  return (
    <section className="s flush" aria-labelledby="tarifs">
      <div className="wrap">
        <SectionHead
          index={props.index}
          id="tarifs"
          title="Vous payez des écrans. Rien d’autre."
          lede="Une base mensuelle qui inclut des emplacements d’écran, puis un prix fixe par écran supplémentaire. Aucun écran payant n’est ajouté sans votre confirmation."
        />
        <div className="price-grid">
          {catalog.plans.map((plan, i) => {
            const mid = i === 1;
            return (
              <article
                className={mid ? 'plan mid' : 'plan'}
                key={plan.key}
                aria-labelledby={`offre-${plan.key}`}
              >
                <div className="nm mono">
                  <h3 id={`offre-${plan.key}`}>{plan.name}</h3>
                  <span>{plan.audience}</span>
                </div>
                <p className="amt">
                  {euros(plan.monthlyBaseCents)}
                  <small>{plan.monthlyBaseCents === 0 ? '/ mois' : 'HT / mois'}</small>
                </p>
                <dl>
                  <div>
                    <dt>Écrans inclus</dt>
                    <dd>{plan.includedDisplays}</dd>
                  </div>
                  <div>
                    <dt>Écran supplémentaire</dt>
                    <dd>
                      {plan.extraDisplayCents === null ? (
                        <>
                          <span aria-hidden="true">—</span>
                          <span className="sr-only">non prévu</span>
                        </>
                      ) : (
                        `${euros(plan.extraDisplayCents)} / mois`
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Stockage</dt>
                    <dd>{plan.storageGb} Go</dd>
                  </div>
                  <div>
                    <dt>Utilisateurs</dt>
                    <dd>{plan.users ?? 'À définir'}</dd>
                  </div>
                </dl>
                <a
                  className={plan.monthlyBaseCents === 0 ? 'btn' : mid ? 'btn pink' : 'btn solid'}
                  href={app.register}
                >
                  {plan.monthlyBaseCents === 0 ? 'Commencer gratuitement' : 'Créer un compte'}
                </a>
              </article>
            );
          })}
        </div>
        <div className="calc" data-quotes={JSON.stringify(table)}>
          <label className="mono" htmlFor="ecrans">
            Calculez
          </label>
          <div className="slider mono">
            <span aria-hidden="true">1</span>
            <input
              id="ecrans"
              type="range"
              min="1"
              max={CALC_MAX}
              defaultValue={CALC_DEFAULT}
              aria-describedby="devis"
            />
            <span aria-hidden="true">{CALC_MAX}</span>
            <output htmlFor="ecrans" className="count">
              {CALC_DEFAULT} écrans
            </output>
          </div>
          <output id="devis" className="eq" htmlFor="ecrans" aria-live="polite">
            {initial}
          </output>
        </div>
        <p className="disclaimer mono">
          {catalog.status === 'indicative' ? 'Tarifs indicatifs, en cours de validation · ' : ''}
          Taxes, périodicité et conditions affichées avant tout paiement
        </p>
      </div>
    </section>
  );
}

export interface Question {
  readonly q: string;
  readonly a: ReactNode;
}

export function Faq(props: { index: string; questions: readonly Question[]; title?: string }) {
  return (
    <section className="s flush" aria-labelledby="questions">
      <div className="wrap faq">
        <h2 id="questions" className="idx mono">
          {props.index}
        </h2>
        <div className="faq-list">
          {props.questions.map((item, i) => (
            <details key={item.q} open={i === 0}>
              <summary>
                <span>{item.q}</span>
                <span className="pm mono" aria-hidden="true" />
              </summary>
              <div className="answer">{item.a}</div>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

export function Cta(props: { config: SiteConfig }) {
  const app = appLinks(props.config);
  return (
    <section className="cta" aria-labelledby="commencer">
      <div className="wrap">
        <h2 id="commencer">Branchez un écran. Le reste se programme.</h2>
        <div>
          <p>
            Créez votre compte, appairez votre premier écran avec le code qu’il affiche et publiez
            votre premier contenu.
          </p>
          <div className="ctas">
            <a className="btn solid" href={app.register}>
              Créer un compte gratuit <span aria-hidden="true">→</span>
            </a>
            <a className="btn" href="/tarifs/">
              Voir les tarifs
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}

/** Ouverture des pages intérieures. */
export function PageHero(props: { kicker: string; title: string; lede: string }) {
  return (
    <section className="page-hero" aria-labelledby="titre">
      <div className="wrap">
        <p className="mono kicker">{props.kicker}</p>
        <h1 id="titre">{props.title}</h1>
        <p className="lede">{props.lede}</p>
      </div>
    </section>
  );
}
