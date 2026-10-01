import type { ReactNode } from 'react';

/**
 * Textes légaux génériques (L09-M). Ce sont des modèles : l’identité de l’éditeur, les
 * hébergeurs et les durées propres au service sont des champs à compléter, signalés
 * visuellement. Aucune identité juridique n’est inventée ; les pages restent `noindex`
 * jusqu’à la validation des textes définitifs par le responsable produit.
 */
export interface LegalDocument {
  readonly path: string;
  readonly title: string;
  readonly description: string;
  readonly sections: readonly { readonly title: string; readonly body: ReactNode }[];
}

/** Champ à compléter, visible dans la page tant que le texte n’est pas finalisé. */
function Todo(props: { children: string }) {
  return <mark className="todo">[{props.children}]</mark>;
}

const EDITOR = <Todo>Raison sociale</Todo>;
const CONTACT = <Todo>adresse e-mail de contact</Todo>;
const PRIVACY_CONTACT = <Todo>adresse e-mail dédiée aux données personnelles</Todo>;

export const LEGAL_DOCUMENTS: readonly LegalDocument[] = [
  {
    path: '/mentions-legales/',
    title: 'Mentions légales',
    description: 'Éditeur, hébergement et propriété intellectuelle du site et du service pixlova.',
    sections: [
      {
        title: 'Éditeur',
        body: (
          <>
            <p>
              Le site et le service pixlova sont édités par {EDITOR}, <Todo>forme juridique</Todo>{' '}
              au capital de <Todo>montant</Todo>, immatriculée au RCS de <Todo>ville</Todo> sous le
              numéro <Todo>SIREN</Todo>, dont le siège est situé <Todo>adresse du siège</Todo>.
            </p>
            <p>
              Numéro de TVA intracommunautaire : <Todo>numéro de TVA</Todo>. Directeur de la
              publication : <Todo>nom du directeur de la publication</Todo>. Contact : {CONTACT}.
            </p>
          </>
        ),
      },
      {
        title: 'Hébergement',
        body: (
          <p>
            Le site et le service sont hébergés par <Todo>nom de l’hébergeur</Todo>,{' '}
            <Todo>adresse et téléphone de l’hébergeur</Todo>.
          </p>
        ),
      },
      {
        title: 'Propriété intellectuelle',
        body: (
          <p>
            La marque pixlova, son logo, les textes, visuels et logiciels présentés sur ce site sont
            protégés. Toute reproduction ou représentation, totale ou partielle, sans autorisation
            écrite de l’éditeur est interdite. Les contenus que les clients diffusent avec pixlova
            restent leur propriété.
          </p>
        ),
      },
      {
        title: 'Données personnelles',
        body: (
          <p>
            Le traitement des données personnelles est décrit dans la{' '}
            <a href="/confidentialite/">politique de confidentialité</a>.
          </p>
        ),
      },
    ],
  },
  {
    path: '/cgv/',
    title: 'Conditions générales de vente',
    description:
      'Conditions d’abonnement, de paiement, de changement d’offre et de résiliation du service pixlova.',
    sections: [
      {
        title: 'Objet',
        body: (
          <p>
            Les présentes conditions régissent l’accès au service pixlova, logiciel d’affichage
            dynamique proposé par {EDITOR} sous forme d’abonnement, à des clients professionnels. La
            création d’un compte ou la souscription d’une offre vaut acceptation de ces conditions.
          </p>
        ),
      },
      {
        title: 'Offres',
        body: (
          <p>
            Le service est proposé selon plusieurs offres, dont une offre gratuite. Chaque offre
            fixe notamment le nombre d’écrans actifs, l’espace de stockage et le nombre
            d’utilisateurs. Le contenu et le prix des offres en vigueur sont indiqués sur la{' '}
            <a href="/tarifs/">page Tarifs</a> et rappelés avant toute souscription.
          </p>
        ),
      },
      {
        title: 'Prix et paiement',
        body: (
          <p>
            Les prix sont exprimés en euros hors taxes ; les taxes applicables, la périodicité et le
            montant total sont affichés avant validation. Le paiement est réalisé par carte bancaire
            via le prestataire de paiement Stripe. L’abonnement est renouvelé automatiquement à
            chaque échéance, sauf résiliation.
          </p>
        ),
      },
      {
        title: 'Changement d’offre',
        body: (
          <p>
            Le client peut passer à une offre supérieure à tout moment ; la différence est facturée
            au prorata de la période en cours. Une diminution prend effet à la fin de la période
            payée. Un changement d’offre ne supprime ni médias ni programmation : les écrans ou
            l’espace au-delà des nouvelles limites cessent d’être utilisables jusqu’à un nouveau
            choix du client.
          </p>
        ),
      },
      {
        title: 'Résiliation',
        body: (
          <p>
            Le client peut résilier depuis son espace de facturation. La résiliation arrête le
            renouvellement et ramène le compte à l’offre gratuite à la fin de la période payée, sans
            remboursement de la période en cours. Elle n’entraîne pas la suppression des données ;
            la suppression du compte est une démarche distincte, réservée au propriétaire de
            l’organisation.
          </p>
        ),
      },
      {
        title: 'Disponibilité et responsabilité',
        body: (
          <p>
            L’éditeur met en œuvre des moyens raisonnables pour assurer la disponibilité du service,
            sans garantie de disponibilité continue. Le Player natif continue de diffuser son
            dernier contenu valide en cas de coupure du service en ligne ; le Player Web dépend du
            navigateur qui l’exécute. Le client reste responsable des contenus qu’il diffuse et du
            matériel qu’il utilise. La responsabilité de l’éditeur est limitée aux dommages directs
            et plafonnée à <Todo>plafond de responsabilité</Todo>.
          </p>
        ),
      },
      {
        title: 'Droit applicable',
        body: (
          <p>
            Les présentes conditions sont soumises au droit français. À défaut d’accord amiable,
            tout litige relève des tribunaux compétents de <Todo>ville</Todo>.
          </p>
        ),
      },
    ],
  },
  {
    path: '/confidentialite/',
    title: 'Politique de confidentialité',
    description:
      'Données personnelles traitées par pixlova, finalités, durées de conservation et exercice de vos droits.',
    sections: [
      {
        title: 'Responsable du traitement',
        body: (
          <p>
            {EDITOR} est responsable des traitements décrits ici, liés à ce site et à la gestion des
            comptes clients. Pour les contenus et données que les clients gèrent dans pixlova,
            l’éditeur agit en sous-traitant : voir l’
            <a href="/traitement-des-donnees/">accord de traitement des données</a>.
          </p>
        ),
      },
      {
        title: 'Données traitées et finalités',
        body: (
          <ul>
            <li>
              Compte et membres (nom, adresse e-mail, rôle) : création et sécurité du compte,
              gestion des accès. Base légale : exécution du contrat.
            </li>
            <li>
              Facturation (coordonnées de facturation, historique des paiements) : gestion de
              l’abonnement et obligations comptables. Les données de carte sont traitées par Stripe
              et ne sont pas conservées par pixlova.
            </li>
            <li>
              Journaux techniques et d’audit : sécurité du service et traçabilité des actions
              sensibles. Base légale : intérêt légitime.
            </li>
            <li>Échanges avec le support : réponse aux demandes.</li>
          </ul>
        ),
      },
      {
        title: 'Cookies',
        body: (
          <p>
            Ce site ne dépose aucun cookie et n’utilise aucun outil de mesure d’audience. Le
            dashboard utilise uniquement les cookies nécessaires à la connexion.
          </p>
        ),
      },
      {
        title: 'Destinataires',
        body: (
          <p>
            Les données sont accessibles aux seules personnes habilitées de l’éditeur et à ses
            sous-traitants techniques : <Todo>hébergeur</Todo>, Cloudflare (réseau et sécurité),
            Stripe (paiement), <Todo>prestataire d’envoi des e-mails</Todo>. Aucune donnée n’est
            vendue.
          </p>
        ),
      },
      {
        title: 'Durées de conservation',
        body: (
          <p>
            Les données de compte sont conservées pendant la relation contractuelle, puis supprimées
            ou anonymisées, sauf les éléments que la loi impose de garder (pièces comptables
            notamment). Les journaux sont conservés <Todo>durée des journaux</Todo>.
          </p>
        ),
      },
      {
        title: 'Vos droits',
        body: (
          <p>
            Vous disposez d’un droit d’accès, de rectification, d’effacement, de limitation,
            d’opposition et de portabilité. Écrivez à {PRIVACY_CONTACT}. Vous pouvez aussi
            introduire une réclamation auprès de la CNIL (cnil.fr).
          </p>
        ),
      },
    ],
  },
  {
    path: '/traitement-des-donnees/',
    title: 'Accord de traitement des données',
    description:
      'Engagements de pixlova en tant que sous-traitant des données personnelles traitées pour ses clients.',
    sections: [
      {
        title: 'Rôles',
        body: (
          <p>
            Pour les données que le client gère dans pixlova (membres invités, médias,
            programmation, captures d’écran), le client est responsable du traitement et {EDITOR}{' '}
            agit en sous-traitant, au sens de l’article 28 du RGPD. Le présent accord fait partie
            des <a href="/cgv/">conditions générales de vente</a>.
          </p>
        ),
      },
      {
        title: 'Instructions et confidentialité',
        body: (
          <p>
            L’éditeur traite ces données uniquement pour fournir le service et selon les
            instructions documentées du client. Les personnes autorisées à y accéder sont soumises à
            une obligation de confidentialité.
          </p>
        ),
      },
      {
        title: 'Sécurité',
        body: (
          <p>
            L’éditeur met en œuvre des mesures techniques et organisationnelles adaptées : isolement
            des données de chaque organisation, contrôle des accès par rôle, chiffrement des
            échanges, journal des actions sensibles et sauvegardes.
          </p>
        ),
      },
      {
        title: 'Sous-traitants ultérieurs',
        body: (
          <p>
            Le client autorise le recours aux sous-traitants listés dans la{' '}
            <a href="/confidentialite/">politique de confidentialité</a>. Il est informé de tout
            ajout ou remplacement et peut s’y opposer.
          </p>
        ),
      },
      {
        title: 'Assistance et violations',
        body: (
          <p>
            L’éditeur aide le client à répondre aux demandes d’exercice des droits et l’informe dans
            les meilleurs délais de toute violation de données le concernant.
          </p>
        ),
      },
      {
        title: 'Fin du contrat',
        body: (
          <p>
            À la suppression de l’organisation, les données sont effacées à l’issue d’un délai de{' '}
            <Todo>délai avant suppression</Todo>, sauf obligation légale de conservation. Le client
            peut récupérer ses médias avant cette suppression.
          </p>
        ),
      },
    ],
  },
];
