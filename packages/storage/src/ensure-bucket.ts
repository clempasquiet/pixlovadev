/**
 * Étape de déploiement (ADR-015) : crée le bucket privé s’il n’existe pas, avec les mêmes
 * variables que l’API et le worker. Aucune politique publique n’est posée : tout accès
 * passe par une URL présignée.
 */
import { CreateBucketCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} est requis.`);
    process.exit(2);
  }
  return value;
}

const bucket = required('PIXLOVA_S3_BUCKET');
const client = new S3Client({
  region: process.env.PIXLOVA_S3_REGION ?? 'auto',
  forcePathStyle: process.env.PIXLOVA_S3_FORCE_PATH_STYLE === 'true',
  ...(process.env.PIXLOVA_S3_ENDPOINT ? { endpoint: process.env.PIXLOVA_S3_ENDPOINT } : {}),
  credentials: {
    accessKeyId: required('PIXLOVA_S3_ACCESS_KEY_ID'),
    secretAccessKey: required('PIXLOVA_S3_SECRET_ACCESS_KEY'),
  },
});

try {
  await client.send(new HeadBucketCommand({ Bucket: bucket }));
  console.log(`Bucket ${bucket} présent.`);
} catch (error) {
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  if (status !== 404) throw error;
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
  console.log(`Bucket ${bucket} créé (privé).`);
} finally {
  client.destroy();
}
