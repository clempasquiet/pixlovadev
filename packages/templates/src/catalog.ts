import type { CompositionDocument, CompositionTemplate, DocumentElement } from '@pixlova/contracts';
import { clock, image, qr, rect, resetIds, text } from './build.js';

/**
 * Catalogue plateforme V1 (TPL-001, ADR-010). Chaque template est versionné avec le code :
 * une modification publiée incrémente `version` et ne change jamais les compositions déjà
 * créées. Aucun asset plateforme : logos et photos sont des placeholders à remplir avec
 * les médias de l’organisation.
 */
function document(
  width: number,
  height: number,
  background: string,
  elements: DocumentElement[],
  durationMs = 15_000,
): CompositionDocument {
  return {
    schema_version: 1,
    canvas: { width, height, background },
    elements,
    settings: { duration_ms: durationMs, audio_policy: 'muted' },
  };
}

function restaurantMenu(): CompositionTemplate {
  resetIds();
  return {
    key: 'restaurant-menu-du-jour',
    version: 1,
    name: 'Menu du jour',
    category: 'restauration',
    description: 'Menu en trois colonnes avec photo du plat, prix et horloge.',
    required_features: ['templates'],
    placeholders: [
      { key: 'business_name', type: 'text', label: 'Nom du restaurant', default: 'Le Comptoir' },
      { key: 'primary_color', type: 'color', label: 'Couleur principale', default: '#C8553D' },
      { key: 'logo', type: 'image', label: 'Logo' },
      { key: 'dish_photo', type: 'image', label: 'Photo du plat' },
    ],
    document: document(1920, 1080, '#FFF8F0', [
      rect([0, 0, 1920, 160], '#C8553D', {
        id: 'header',
        placeholder: 'primary_color',
        name: 'Bandeau',
      }),
      image([40, 20, 120, 120], 'contain', { id: 'logo', placeholder: 'logo', name: 'Logo' }),
      text(
        [190, 20, 1100, 120],
        'Le Comptoir',
        { font: 'Playfair Display', size: 72, weight: 700, color: '#FFFFFF', valign: 'middle' },
        { id: 'name', placeholder: 'business_name', name: 'Nom' },
      ),
      clock(
        [1480, 20, 400, 120],
        'time_24h',
        { size: 64, color: '#FFFFFF', font: 'Montserrat' },
        { id: 'clock', name: 'Heure' },
      ),
      text(
        [80, 220, 1000, 90],
        'Menu du jour',
        { font: 'Playfair Display', size: 64, weight: 700, color: '#2D1E17' },
        { id: 'title' },
      ),
      text(
        [80, 340, 1000, 560],
        'Entrée · Velouté de saison\nPlat · Filet de cabillaud, légumes rôtis\nDessert · Tarte fine aux pommes',
        { font: 'Montserrat', size: 44, weight: 500, color: '#2D1E17', lineHeight: 1.7 },
        { id: 'menu' },
      ),
      text(
        [80, 900, 1000, 120],
        'Formule 19 €',
        { font: 'Montserrat', size: 72, weight: 800, color: '#C8553D' },
        { id: 'price', placeholder: 'primary_color' },
      ),
      image([1160, 220, 680, 800], 'cover', {
        id: 'photo',
        placeholder: 'dish_photo',
        name: 'Photo du plat',
      }),
    ]),
  };
}

function hotelWelcome(): CompositionTemplate {
  resetIds();
  return {
    key: 'hotel-bienvenue',
    version: 1,
    name: 'Accueil de l’hôtel',
    category: 'hotellerie',
    description: 'Écran d’accueil avec photo, informations pratiques et QR Code Wi-Fi.',
    required_features: ['templates'],
    placeholders: [
      { key: 'business_name', type: 'text', label: 'Nom de l’hôtel', default: 'Hôtel des Arts' },
      { key: 'primary_color', type: 'color', label: 'Couleur principale', default: '#1F4E5F' },
      { key: 'photo', type: 'image', label: 'Photo de l’établissement' },
      {
        key: 'wifi',
        type: 'text',
        label: 'Données Wi-Fi (QR Code)',
        default: 'WIFI:T:WPA;S:Hotel-Guests;P:bienvenue;;',
      },
    ],
    document: document(1920, 1080, '#F4F1EA', [
      image([0, 0, 1100, 1080], 'cover', { id: 'photo', placeholder: 'photo', name: 'Photo' }),
      rect([1100, 0, 820, 1080], '#1F4E5F', {
        id: 'panel',
        placeholder: 'primary_color',
        name: 'Panneau',
      }),
      text(
        [1180, 120, 680, 100],
        'Bienvenue',
        { font: 'Playfair Display', size: 56, weight: 400, color: '#F4F1EA' },
        { id: 'welcome' },
      ),
      text(
        [1180, 220, 680, 200],
        'Hôtel des Arts',
        { font: 'Playfair Display', size: 88, weight: 700, color: '#FFFFFF', lineHeight: 1.1 },
        { id: 'name', placeholder: 'business_name' },
      ),
      text(
        [1180, 470, 680, 260],
        'Petit-déjeuner · 7 h – 10 h 30\nRéception · 24 h/24\nDépart · avant 11 h',
        { font: 'Inter', size: 36, weight: 400, color: '#F4F1EA', lineHeight: 1.6 },
        { id: 'infos' },
      ),
      qr([1180, 780, 220, 220], 'WIFI:T:WPA;S:Hotel-Guests;P:bienvenue;;', {
        id: 'wifi',
        placeholder: 'wifi',
        name: 'QR Wi-Fi',
      }),
      text(
        [1430, 820, 440, 140],
        'Wi-Fi gratuit\nScannez le code',
        { font: 'Inter', size: 32, weight: 600, color: '#FFFFFF', valign: 'middle' },
        { id: 'wifi-label' },
      ),
      clock([1480, 40, 400, 60], 'date_long', { size: 28, color: '#F4F1EA' }, { id: 'date' }),
    ]),
  };
}

function retailPromo(): CompositionTemplate {
  resetIds();
  return {
    key: 'retail-promotion-portrait',
    version: 1,
    name: 'Promotion vitrine (portrait)',
    category: 'retail',
    description:
      'Affiche portrait avec visuel produit, remise et QR Code vers la boutique en ligne.',
    required_features: ['templates'],
    placeholders: [
      { key: 'product_photo', type: 'image', label: 'Visuel produit' },
      { key: 'offer', type: 'text', label: 'Offre', default: '-30 %' },
      { key: 'primary_color', type: 'color', label: 'Couleur principale', default: '#E63946' },
      {
        key: 'shop_url',
        type: 'text',
        label: 'Adresse de la boutique (QR Code)',
        default: 'https://example.com',
      },
    ],
    document: document(1080, 1920, '#FFFFFF', [
      image([0, 0, 1080, 1180], 'cover', {
        id: 'photo',
        placeholder: 'product_photo',
        name: 'Visuel',
      }),
      rect([740, 60, 280, 280], '#E63946', {
        id: 'badge',
        placeholder: 'primary_color',
        ellipse: true,
        z_index: 8,
      }),
      text(
        [740, 60, 280, 280],
        '-30 %',
        {
          font: 'Montserrat',
          size: 84,
          weight: 800,
          color: '#FFFFFF',
          align: 'center',
          valign: 'middle',
        },
        { id: 'offer', placeholder: 'offer', rotation: -8 },
      ),
      text(
        [80, 1240, 920, 220],
        'Collection d’automne',
        { font: 'Montserrat', size: 92, weight: 800, color: '#1D1D1F', lineHeight: 1.05 },
        { id: 'title' },
      ),
      text(
        [80, 1480, 620, 200],
        'En magasin et en ligne jusqu’au 31 octobre.',
        { font: 'Inter', size: 44, weight: 400, color: '#4A4A4F', lineHeight: 1.4 },
        { id: 'subtitle' },
      ),
      qr([760, 1480, 240, 240], 'https://example.com', { id: 'qr', placeholder: 'shop_url' }),
      rect([0, 1800, 1080, 120], '#E63946', { id: 'footer', placeholder: 'primary_color' }),
    ]),
  };
}

function realEstate(): CompositionTemplate {
  resetIds();
  return {
    key: 'immobilier-annonce',
    version: 1,
    name: 'Annonce immobilière',
    category: 'immobilier',
    description: 'Bien à la une : photo, caractéristiques, prix et contact.',
    required_features: ['templates'],
    placeholders: [
      { key: 'agency_name', type: 'text', label: 'Nom de l’agence', default: 'Agence du Centre' },
      { key: 'logo', type: 'image', label: 'Logo de l’agence' },
      { key: 'property_photo', type: 'image', label: 'Photo du bien' },
      { key: 'primary_color', type: 'color', label: 'Couleur principale', default: '#2A9D8F' },
    ],
    document: document(1920, 1080, '#FFFFFF', [
      image([0, 0, 1240, 1080], 'cover', { id: 'photo', placeholder: 'property_photo' }),
      rect([1240, 0, 680, 1080], '#F7F9FA', { id: 'panel' }),
      image([1300, 50, 180, 110], 'contain', { id: 'logo', placeholder: 'logo' }),
      text(
        [1500, 60, 380, 90],
        'Agence du Centre',
        { font: 'Inter', size: 30, weight: 600, color: '#264653', valign: 'middle' },
        { id: 'agency', placeholder: 'agency_name' },
      ),
      text(
        [1300, 240, 580, 180],
        'Appartement T3 lumineux',
        { font: 'Montserrat', size: 56, weight: 700, color: '#264653', lineHeight: 1.15 },
        { id: 'title' },
      ),
      text(
        [1300, 450, 580, 260],
        '72 m² · 2 chambres\nBalcon plein sud\nProche transports',
        { font: 'Inter', size: 36, weight: 400, color: '#4A5A66', lineHeight: 1.6 },
        { id: 'features' },
      ),
      rect([1300, 780, 580, 150], '#2A9D8F', {
        id: 'price-box',
        placeholder: 'primary_color',
        radius: 16,
      }),
      text(
        [1300, 780, 580, 150],
        '315 000 €',
        {
          font: 'Montserrat',
          size: 72,
          weight: 800,
          color: '#FFFFFF',
          align: 'center',
          valign: 'middle',
        },
        { id: 'price' },
      ),
      text(
        [1300, 960, 580, 80],
        'Visite sur rendez-vous',
        { font: 'Inter', size: 30, weight: 500, color: '#4A5A66' },
        { id: 'contact' },
      ),
    ]),
  };
}

function eventAgenda(): CompositionTemplate {
  resetIds();
  return {
    key: 'evenement-programme',
    version: 1,
    name: 'Programme de l’événement',
    category: 'evenementiel',
    description: 'Programme horaire avec heure en direct et QR Code d’inscription.',
    required_features: ['templates'],
    placeholders: [
      {
        key: 'event_name',
        type: 'text',
        label: 'Nom de l’événement',
        default: 'Forum Innovation 2026',
      },
      { key: 'primary_color', type: 'color', label: 'Couleur principale', default: '#6C4AB6' },
      { key: 'logo', type: 'image', label: 'Logo' },
      {
        key: 'register_url',
        type: 'text',
        label: 'Lien d’inscription (QR Code)',
        default: 'https://example.com/inscription',
      },
    ],
    document: document(1920, 1080, '#14111F', [
      rect([0, 0, 24, 1080], '#6C4AB6', { id: 'accent', placeholder: 'primary_color' }),
      image([80, 60, 200, 120], 'contain', { id: 'logo', placeholder: 'logo' }),
      text(
        [320, 60, 1100, 120],
        'Forum Innovation 2026',
        { font: 'Montserrat', size: 64, weight: 800, color: '#FFFFFF', valign: 'middle' },
        { id: 'name', placeholder: 'event_name' },
      ),
      clock(
        [1460, 60, 400, 120],
        'time_24h',
        { size: 80, color: '#B9A6F2', font: 'Roboto Mono' },
        { id: 'clock' },
      ),
      text(
        [80, 260, 1200, 720],
        '09:00  Accueil et café\n09:30  Ouverture\n10:15  Table ronde — l’IA au quotidien\n12:00  Déjeuner\n14:00  Ateliers\n17:30  Clôture',
        { font: 'Roboto Mono', size: 44, weight: 500, color: '#EDEAF7', lineHeight: 1.75 },
        { id: 'agenda' },
      ),
      rect([1440, 300, 400, 520], '#6C4AB6', {
        id: 'qr-box',
        placeholder: 'primary_color',
        radius: 24,
      }),
      qr([1490, 350, 300, 300], 'https://example.com/inscription', {
        id: 'qr',
        placeholder: 'register_url',
      }),
      text(
        [1460, 680, 360, 120],
        'Inscription\nsur place',
        {
          font: 'Inter',
          size: 36,
          weight: 700,
          color: '#FFFFFF',
          align: 'center',
          valign: 'middle',
        },
        { id: 'qr-label' },
      ),
    ]),
  };
}

function ledBanner(): CompositionTemplate {
  resetIds();
  return {
    key: 'bandeau-led-promotion',
    version: 1,
    name: 'Bandeau LED promotion',
    category: 'retail',
    description: 'Bandeau LED 2688×672 : message court, prix et logo, lisible de loin.',
    required_features: ['templates'],
    placeholders: [
      { key: 'message', type: 'text', label: 'Message', default: 'Soldes d’hiver' },
      { key: 'price', type: 'text', label: 'Prix ou remise', default: 'jusqu’à -50 %' },
      { key: 'logo', type: 'image', label: 'Logo' },
      { key: 'primary_color', type: 'color', label: 'Couleur principale', default: '#FFD166' },
    ],
    document: document(
      2688,
      672,
      '#000000',
      [
        image([48, 96, 480, 480], 'contain', { id: 'logo', placeholder: 'logo' }),
        text(
          [600, 60, 1300, 552],
          'Soldes d’hiver',
          {
            font: 'Montserrat',
            size: 200,
            weight: 900,
            color: '#FFFFFF',
            valign: 'middle',
            lineHeight: 1,
          },
          { id: 'message', placeholder: 'message' },
        ),
        rect([1940, 96, 700, 480], '#FFD166', {
          id: 'price-box',
          placeholder: 'primary_color',
          radius: 40,
        }),
        text(
          [1940, 96, 700, 480],
          'jusqu’à -50 %',
          {
            font: 'Montserrat',
            size: 120,
            weight: 900,
            color: '#000000',
            align: 'center',
            valign: 'middle',
            lineHeight: 1,
          },
          { id: 'price', placeholder: 'price' },
        ),
      ],
      10_000,
    ),
  };
}

export const TEMPLATES: readonly CompositionTemplate[] = [
  restaurantMenu(),
  hotelWelcome(),
  retailPromo(),
  realEstate(),
  eventAgenda(),
  ledBanner(),
];

export function findTemplate(key: string): CompositionTemplate | undefined {
  return TEMPLATES.find((template) => template.key === key);
}
