// Utilitário de teste: aponta os dados para um diretório temporário único e
// importa os módulos do HOST. Cada arquivo de teste (processo separado do
// runner do Node) usa seu próprio diretório para isolamento total.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function freshDataDir() {
  const dir = mkdtempSync(join(tmpdir(), 'moonshine-test-'));
  process.env.MOONSHINE_DATA_DIR = dir;
  process.env.MOONSHINE_ISOLATION = 'temp-home'; // sem exigir SO durante teste
  process.env.MOONSHINE_SESSION_RUNTIME = join(dir, 'sessions');
  return dir;
}

export function cleanupDataDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignora */
  }
}

// Porta efêmera para testes de servidor.
export function ephemeralPort() {
  return 20000 + Math.floor(Math.random() * 20000);
}
