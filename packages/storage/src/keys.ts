import { randomBytes } from 'node:crypto';

/**
 * Clés opaques construites par le serveur (ADR-009) : aucun nom ou chemin fourni par le
 * client. Chaque binaire définitif porte un jeton aléatoire, de sorte qu’une écriture
 * tardive ne remplace jamais un objet déjà enregistré sous une autre identité.
 */
export function uploadObjectKey(organizationId: string, uploadId: string): string {
  return `org/${organizationId}/uploads/${uploadId}`;
}

export function mediaObjectKey(
  organizationId: string,
  mediaId: string,
  variant: string,
  extension: string,
): string {
  return `org/${organizationId}/media/${mediaId}/${variant}-${randomBytes(8).toString('hex')}.${extension}`;
}
