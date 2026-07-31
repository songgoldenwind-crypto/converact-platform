import { resolveBrandEnv } from '../config/converact-env.js';
export interface S3ConnectionConfig {
  bucket: string;
  region: string;
  endpoint: string | undefined;
  forcePathStyle: boolean;
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
  };
  source: 'aws' | 's3' | 'minio';
}

interface CredentialFamily {
  source: S3ConnectionConfig['source'];
  accessKeyName: string;
  secretAccessKeyName: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export function resolveS3ConnectionConfig(
  env: NodeJS.ProcessEnv
): S3ConnectionConfig | null {
  const bucketSelection = firstValue([
    ['s3', env.S3_BUCKET],
    ['s3', resolveBrandEnv(env, 'S3_BUCKET')],
    ['minio', env.MINIO_BUCKET]
  ]);
  if (!bucketSelection) return null;

  const endpoint = clean(env.S3_ENDPOINT) || clean(env.MINIO_ENDPOINT) || undefined;
  const credentials = resolveCredentialFamily(env);
  return {
    bucket: bucketSelection.value,
    region: clean(env.S3_REGION) || clean(env.AWS_REGION) || 'us-east-1',
    endpoint,
    forcePathStyle: parseForcePathStyle(env.S3_FORCE_PATH_STYLE, Boolean(endpoint)),
    ...(credentials
      ? {
          credentials: {
            accessKeyId: credentials.accessKeyId,
            secretAccessKey: credentials.secretAccessKey
          }
        }
      : {}),
    source: credentials?.source || bucketSelection.source
  };
}

function resolveCredentialFamily(env: NodeJS.ProcessEnv): CredentialFamily | null {
  const families: CredentialFamily[] = [
    {
      source: 'aws',
      accessKeyName: 'AWS_ACCESS_KEY_ID',
      secretAccessKeyName: 'AWS_SECRET_ACCESS_KEY',
      accessKeyId: clean(env.AWS_ACCESS_KEY_ID),
      secretAccessKey: clean(env.AWS_SECRET_ACCESS_KEY)
    },
    {
      source: 's3',
      accessKeyName: 'S3_ACCESS_KEY_ID',
      secretAccessKeyName: 'S3_SECRET_ACCESS_KEY',
      accessKeyId: clean(env.S3_ACCESS_KEY_ID),
      secretAccessKey: clean(env.S3_SECRET_ACCESS_KEY)
    },
    {
      source: 'minio',
      accessKeyName: 'MINIO_ACCESS_KEY',
      secretAccessKeyName: 'MINIO_SECRET_KEY',
      accessKeyId: clean(env.MINIO_ACCESS_KEY),
      secretAccessKey: clean(env.MINIO_SECRET_KEY)
    }
  ];
  const selected = families.find((family) => family.accessKeyId || family.secretAccessKey);
  if (!selected) return null;
  if (!selected.accessKeyId || !selected.secretAccessKey) {
    throw new Error(
      `${selected.accessKeyName} and ${selected.secretAccessKeyName} must be configured together`
    );
  }
  return selected;
}

function parseForcePathStyle(value: string | undefined, fallback: boolean): boolean {
  const normalized = clean(value).toLowerCase();
  if (!normalized) return fallback;
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error('S3_FORCE_PATH_STYLE must be true or false');
}

function firstValue(
  candidates: Array<[S3ConnectionConfig['source'], string | undefined]>
): { source: S3ConnectionConfig['source']; value: string } | null {
  for (const [source, value] of candidates) {
    const normalized = clean(value);
    if (normalized) return { source, value: normalized };
  }
  return null;
}

function clean(value: string | undefined): string {
  return String(value || '').trim();
}
