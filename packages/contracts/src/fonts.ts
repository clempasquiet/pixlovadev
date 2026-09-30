/**
 * Polices qualifiées (CMP-003, REN-002, ADR-010) : familles sous licence SIL OFL 1.1,
 * empaquetées avec le moteur de rendu (fichiers variables WOFF2 Fontsource). Le rendu
 * d’une composition n’utilise jamais une police système.
 */
export interface QualifiedFont {
  /** Nom de famille CSS déclaré par le paquet de police empaqueté. */
  css: string;
  minWeight: number;
  maxWeight: number;
  /** Paquet npm qui fournit les fichiers (licence OFL-1.1). */
  package: string;
}

export const QUALIFIED_FONTS = {
  Inter: {
    css: 'Inter Variable',
    minWeight: 100,
    maxWeight: 900,
    package: '@fontsource-variable/inter',
  },
  Roboto: {
    css: 'Roboto Variable',
    minWeight: 100,
    maxWeight: 900,
    package: '@fontsource-variable/roboto',
  },
  'Open Sans': {
    css: 'Open Sans Variable',
    minWeight: 300,
    maxWeight: 800,
    package: '@fontsource-variable/open-sans',
  },
  Montserrat: {
    css: 'Montserrat Variable',
    minWeight: 100,
    maxWeight: 900,
    package: '@fontsource-variable/montserrat',
  },
  'Playfair Display': {
    css: 'Playfair Display Variable',
    minWeight: 400,
    maxWeight: 900,
    package: '@fontsource-variable/playfair-display',
  },
  'Roboto Mono': {
    css: 'Roboto Mono Variable',
    minWeight: 100,
    maxWeight: 700,
    package: '@fontsource-variable/roboto-mono',
  },
} as const satisfies Record<string, QualifiedFont>;

export type QualifiedFontName = keyof typeof QUALIFIED_FONTS;
export const QUALIFIED_FONT_NAMES = Object.keys(QUALIFIED_FONTS) as QualifiedFontName[];

export function isQualifiedFont(name: string): name is QualifiedFontName {
  return Object.hasOwn(QUALIFIED_FONTS, name);
}

/** Pile CSS d’une famille : la police empaquetée, puis un repli générique signalé. */
export function fontStack(name: string): string {
  const font = isQualifiedFont(name) ? QUALIFIED_FONTS[name] : null;
  return font ? `"${font.css}", sans-serif` : `"${name}", sans-serif`;
}
