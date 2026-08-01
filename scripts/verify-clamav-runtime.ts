import { pathToFileURL } from 'node:url';

import { createClamdFileThreatScanner } from '../src/agent-runtime/collaboration/file-threat-scanner.js';

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

export async function verifyClamavRuntime(
  env: NodeJS.ProcessEnv = process.env
): Promise<{ engine: string; threat_code: string }> {
  const host = String(env.CLAMD_HOST || '').trim();
  if (!host) throw new Error('CLAMD_HOST is required');
  const port = Number(env.CLAMD_PORT || 3310);
  const scanner = createClamdFileThreatScanner({
    host,
    port,
    timeoutMs: 30_000,
    maxBytes: 1024 * 1024
  });
  const common = {
    tenant_id: 'clamav-runtime-acceptance',
    secure_file_id: 'clamav-runtime-acceptance',
    detected_mime: 'text/plain'
  };
  const clean = await scanner.scan({
    ...common,
    filename: 'clean.txt',
    content: Buffer.from('Converact Fabric ClamAV runtime acceptance', 'utf8')
  });
  if (clean.status !== 'clean') throw new Error('clean fixture was not accepted');

  const infected = await scanner.scan({
    ...common,
    filename: 'eicar.txt',
    content: Buffer.from(EICAR, 'ascii')
  });
  if (infected.status !== 'infected' || !infected.threat_code) {
    throw new Error('EICAR fixture was not quarantined');
  }
  return { engine: infected.engine, threat_code: infected.threat_code };
}

async function main(): Promise<void> {
  const result = await verifyClamavRuntime();
  console.log(JSON.stringify({ status: 'passed', ...result }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : 'ClamAV runtime acceptance failed';
    console.error(JSON.stringify({ status: 'failed', message: message.slice(0, 300) }));
    process.exitCode = 1;
  });
}
