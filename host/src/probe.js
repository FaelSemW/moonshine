// Detecção do ambiente do HOST: sistema operacional, GPU, recursos e
// compatibilidade. Usado pelo painel administrativo e pelo instalador para
// orientar o proprietário.
//
// As chamadas de sistema são defensivas: qualquer falha vira um campo de
// diagnóstico, nunca uma exceção que derrube o serviço.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import os from 'node:os';

function run(cmd, args, timeoutMs = 4000) {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
    }).trim();
  } catch {
    return null;
  }
}

export function detectOS() {
  const platform = process.platform; // 'linux' | 'win32' | 'darwin'
  const info = {
    platform,
    release: os.release(),
    arch: process.arch,
    hostname: os.hostname(),
  };
  if (platform === 'linux') {
    // Bazzite é Fedora Atomic (ostree). Detecta por arquivos característicos.
    let osRelease = '';
    try {
      osRelease = readFileSync('/etc/os-release', 'utf8');
    } catch {
      /* sem /etc/os-release */
    }
    const id = /ID="?([\w-]+)"?/.exec(osRelease)?.[1] || '';
    const idLike = /ID_LIKE="?([\w- ]+)"?/.exec(osRelease)?.[1] || '';
    const pretty = /PRETTY_NAME="?([^"\n]+)"?/.exec(osRelease)?.[1] || '';
    const isBazzite =
      /bazzite/i.test(osRelease) ||
      /bazzite/i.test(pretty) ||
      existsSync('/usr/share/bazzite') ||
      existsSync('/etc/deployment/initial-setup');
    const isOstree =
      existsSync('/ostree') || /ostree|atomic/i.test(idLike + id);
    info.osRelease = { id, idLike, pretty, isBazzite, isOstree };
  }
  return info;
}

export function detectGPU() {
  if (process.platform === 'linux') {
    const lspci = run('lspci');
    if (lspci) {
      const gpus = lspci
        .split('\n')
        .filter((l) => /VGA|3D|Display/i.test(l))
        .map((l) => l.trim());
      return { gpus, vendor: guessVendor(gpus.join(' ')) };
    }
  }
  if (process.platform === 'win32') {
    const wmic = run('wmic', [
      'path',
      'win32_VideoController',
      'get',
      'Name',
      '/format:list',
    ]);
    if (wmic) {
      const names = wmic
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.startsWith('Name='))
        .map((l) => l.slice(5).trim())
        .filter(Boolean);
      return { gpus: names, vendor: guessVendor(names.join(' ')) };
    }
  }
  return { gpus: [], vendor: 'unknown' };
}

function guessVendor(text) {
  const t = text.toLowerCase();
  if (/nvidia|geforce|rtx|gtx/.test(t)) return 'nvidia';
  if (/amd|radeon|vega|navi/.test(t)) return 'amd';
  if (/intel|arc/.test(t)) return 'intel';
  return 'unknown';
}

export function systemResources() {
  const cpus = os.cpus();
  return {
    cpuModel: cpus[0]?.model || 'desconhecido',
    cpuCount: cpus.length,
    memTotalGb: +(os.totalmem() / 1024 ** 3).toFixed(1),
    memFreeGb: +(os.freemem() / 1024 ** 3).toFixed(1),
    arch: process.arch,
  };
}

// Verifica presença das ferramentas que o HOST usa no Linux.
export function checkTooling() {
  const tools = ['sunshine', 'tailscale', 'nft', 'pkexec', 'run0', 'useradd'];
  const found = {};
  for (const t of tools) {
    found[t] = run('which', [t]) !== null;
  }
  return found;
}

// Avaliação de compatibilidade para a instalação no Bazzite.
export function compatibilityReport() {
  const osInfo = detectOS();
  const gpu = detectGPU();
  const res = systemResources();
  const tooling = process.platform === 'linux' ? checkTooling() : {};

  const issues = [];
  const notes = [];

  if (osInfo.platform !== 'linux') {
    issues.push(
      'O HOST de produção roda em Linux/Bazzite. Neste SO ele opera em modo de desenvolvimento com isolamento desativado.'
    );
  } else {
    if (!osInfo.osRelease?.isBazzite) {
      notes.push(
        'Este não parece ser um Bazzite; a instalação pode variar conforme a distribuição.'
      );
    }
    if (gpu.vendor === 'amd') {
      notes.push(
        'GPU AMD detectada. Sunshine usa VA-API/AMF; confirme codecs suportados.'
      );
    } else if (gpu.vendor === 'nvidia') {
      notes.push('GPU NVIDIA detectada. Confirme driver proprietário e NVENC.');
    } else if (gpu.vendor === 'intel') {
      notes.push('GPU Intel detectada. Confirme suporte a codificação via VA-API.');
    } else {
      issues.push('Nenhuma GPU reconhecida. Streaming precisa de GPU com codificação.');
    }
    if (res.memTotalGb < 8) {
      issues.push('Memória RAM abaixo de 8 GB; sessões podem ficar instáveis.');
    }
  }

  const ok = issues.length === 0;
  return { ok, os: osInfo, gpu, resources: res, tooling, issues, notes };
}

// Detecta a interface/rede Tailscale e o IP 100.x usado para expor o HOST de
// forma privada. Retorna o estado para o assistente de configuração do painel.
export function detectTailscale() {
  const out = {
    installed: false,
    running: false,
    ip: null,
    iface: null,
    serveConfigured: false,
    error: null,
  };
  const which = run('which', ['tailscale']);
  if (!which) {
    out.error = 'tailscale não encontrado (instale via Flatpak ou binário)';
    return out;
  }
  out.installed = true;
  // IP do tailscale.
  const ip = run('tailscale', ['ip', '-4']);
  if (ip) {
    out.ip = ip.split('\n')[0].trim();
    out.running = true;
  } else {
    out.error = 'tailscale instalado mas sem IP (fora da rede?)';
  }
  // Status.
  const status = run('tailscale', ['status', '--json']);
  if (status) {
    try {
      const j = JSON.parse(status);
      out.running = !!j.Self && j.BackendState === 'Running';
      out.iface = j.Self?.TUN ? 'tailscale0' : null;
    } catch {
      /* melhor esforço */
    }
  }
  // tailscale serve: verifica se há config de serve (HTTPS).
  const serve = run('tailscale', ['serve', 'status', '--json']);
  if (serve) {
    try {
      const s = JSON.parse(serve);
      out.serveConfigured = Array.isArray(s) ? s.length > 0 : Object.keys(s).length > 0;
    } catch {
      /* melhor esforço */
    }
  }
  return out;
}
