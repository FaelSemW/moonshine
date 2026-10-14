// Cliente web Moonshine (também usado como PWA no Android e desktop).
//
// O plano de controle (autenticação, estado, reserva, encerramento) é 100% da
// nossa plataforma. O VÍDEO/ÁUDIO/ENTRADA real é transmitido pelo Moonlight
// (projeto oficial), que conecta direto no Sunshine do HOST. Este app NÃO
// simula streaming: ele reserva a máquina e então orienta/abre o Moonlight com
// o endereço correto. Em Android, usa o deep-link do Moonlight (moonlight://).
// Em desktop, fornece o endereço para o Moonlight-Qt pareado.

const api = {
  token: localStorage.getItem('ms_token') || null,
  user: JSON.parse(localStorage.getItem('ms_user') || 'null'),
};

const el = (id) => document.getElementById(id);
const view = el('view');

let pollTimer = null;
let currentSession = null;
let phase = 'idle'; // idle | connecting | preparing | streaming | ending

// ---- util -------------------------------------------------------------------
function toast(msg, kind = '') {
  const t = el('toast');
  t.textContent = msg;
  t.className = `toast ${kind}`;
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add('hidden'), 3600);
}

async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(api.token ? { authorization: `Bearer ${api.token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { /* vazio */ }
  if (res.status === 401 && path !== '/api/login' && path !== '/api/redeem') {
    logoutLocal();
    throw new Error('Sessão expirada. Entre novamente.');
  }
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data;
}

function setBadge(state, label) {
  const b = el('machineBadge');
  const map = {
    available: 'badge-available',
    'in-use': 'badge-active',
    preparing: 'badge-busy',
    cleaning: 'badge-busy',
    unavailable: 'badge-idle',
    locked: 'badge-locked',
    error: 'badge-error',
  };
  b.className = `badge ${map[state] || 'badge-idle'}`;
  b.textContent = label || state;
}

function logoutLocal() {
  api.token = null; api.user = null; currentSession = null; phase = 'idle';
  localStorage.removeItem('ms_token'); localStorage.removeItem('ms_user');
  stopPoll();
}

function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

// ---- telas ------------------------------------------------------------------

function render(html) { view.innerHTML = html; }

function screenSetup() {
  render(`
    <div class="card">
      <h2>Configuração inicial</h2>
      <p class="sub">Crie a conta administradora do seu PC de jogos. Ela gerencia jogadores, estado e registros.</p>
      <form id="setupForm" class="stack">
        <label for="su">Usuário administrador</label>
        <input id="su" autocomplete="username" required minlength="3" maxlength="32" pattern="[a-zA-Z0-9._-]+" />
        <label for="sp">Senha (mínimo 8 caracteres)</label>
        <input id="sp" type="password" autocomplete="new-password" required minlength="8" />
        <label for="sp2">Repita a senha</label>
        <input id="sp2" type="password" autocomplete="new-password" required minlength="8" />
        <button class="btn" style="margin-top:18px">Criar administrador</button>
      </form>
    </div>`);
  el('setupForm').onsubmit = async (e) => {
    e.preventDefault();
    if (el('sp').value !== el('sp2').value) return toast('As senhas não coincidem.', 'error');
    try {
      await call('/api/setup', { method: 'POST', body: { username: el('su').value.trim(), password: el('sp').value, role: 'admin' } });
      toast('Administrador criado. Entre para continuar.', 'ok');
      screenLogin();
    } catch (err) { toast(err.message, 'error'); }
  };
}

function screenLogin() {
  render(`
    <div class="card">
      <h2>Entrar</h2>
      <p class="sub">Use sua conta da plataforma ou um código de convite. <strong>Sua senha da Steam não é usada aqui.</strong></p>
      <form id="loginForm" class="stack">
        <label for="lu">Usuário</label>
        <input id="lu" autocomplete="username" required />
        <label for="lp">Senha</label>
        <input id="lp" type="password" autocomplete="current-password" required />
        <button class="btn" style="margin-top:18px">Entrar</button>
      </form>
      <div class="sub" style="margin:18px 0 8px;opacity:.7">— ou —</div>
      <form id="redeemForm" class="stack">
        <label for="lc">Código de convite</label>
        <input id="lc" placeholder="XXXXX-XXXXX" autocomplete="off" spellcheck="false" />
        <button class="btn secondary">Entrar com código</button>
      </form>
    </div>`);
  el('loginForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await call('/api/login', { method: 'POST', body: { username: el('lu').value.trim(), password: el('lp').value } });
      api.token = r.token; api.user = r.user;
      localStorage.setItem('ms_token', r.token);
      localStorage.setItem('ms_user', JSON.stringify(r.user));
      toast(`Bem-vindo, ${r.user.username}.`, 'ok');
      if (r.user.role === 'admin') screenAdmin(); else screenClient();
    } catch (err) { toast(err.message, 'error'); }
  };
  el('redeemForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await call('/api/redeem', { method: 'POST', body: { code: el('lc').value.trim() } });
      api.token = r.token; api.user = r.user; api.mode = r.mode;
      localStorage.setItem('ms_token', r.token);
      localStorage.setItem('ms_user', JSON.stringify(r.user));
      localStorage.setItem('ms_mode', r.mode || 'game');
      toast(`Bem-vindo, ${r.user.username}.`, 'ok');
      if (r.user.role === 'admin') screenAdmin(); else screenClient();
    } catch (err) { toast(err.message, 'error'); }
  };
}

// ---- tela do jogador --------------------------------------------------------

const STATE_COPY = {
  available: { glyph: '🟢', title: 'PC disponível', desc: 'Seu computador está pronto para uma sessão.' },
  preparing: { glyph: '⏳', title: 'Preparando sessão', desc: 'Criando seu ambiente temporário isolado…' },
  'in-use': { glyph: '🎮', title: 'Sessão ativa', desc: 'Streaming em andamento. Boa diversão!' },
  cleaning: { glyph: '🧹', title: 'Encerrando', desc: 'Limpando seu ambiente temporário com segurança…' },
  unavailable: { glyph: '🔌', title: 'Indisponível', desc: 'O servidor de streaming não respondeu.' },
  locked: { glyph: '🔒', title: 'Bloqueado', desc: 'Uma limpeza incompleta bloqueou o PC. O administrador foi notificado.' },
  error: { glyph: '⚠️', title: 'Erro', desc: 'Algo deu errado. Veja o painel do administrador.' },
};

async function screenClient() {
  render(`<div class="card" id="clientCard"><div class="spinner"></div><p class="sub" style="text-align:center">Consultando estado…</p></div>`);
  try {
    await refreshClient();
    startPoll();
  } catch (err) { toast(err.message, 'error'); }
}

async function refreshClient() {
  const st = await call('/api/state');
  const s = st.machine.state;
  setBadge(s, STATE_COPY[s]?.title || s);
  const c = STATE_COPY[s] || STATE_COPY.unavailable;
  const busy = ['preparing', 'in-use', 'cleaning', 'locked'].includes(s) && !currentSession;
  render(`
    <div class="card">
      <div class="hero">
        <div class="glyph">${c.glyph}</div>
        <h1>${c.title}</h1>
        <p>${c.desc}</p>
      </div>
      <div id="actions" style="margin-top:20px"></div>
    </div>
    <div class="card">
      <div class="kv">
        <span class="k">Sessão aberta</span><span class="v">${st.hasOpenSession ? 'Sim' : 'Não'}</span>
        <span class="k">Atualizado</span><span class="v">${new Date(st.machine.updatedAt).toLocaleTimeString()}</span>
      </div>
    </div>`);
  const a = el('actions');
  a.innerHTML = '';
  if (currentSession && ['active'].includes(currentSession.state)) {
    a.appendChild(actionBtn('Abrir Moonlight e jogar', 'btn', launchStream));
    a.appendChild(actionBtn('Encerrar sessão', 'btn danger', endSession));
  } else if (s === 'available') {
    a.appendChild(actionBtn('Iniciar sessão', 'btn', startSession));
  } else if (busy) {
    a.innerHTML = `<p class="sub" style="text-align:center">O PC está ocupado. Aguarde ficar livre.</p>`;
  }
}

function actionBtn(label, cls, fn) {
  const b = document.createElement('button');
  b.className = cls; b.textContent = label; b.style.marginTop = '10px';
  b.onclick = fn; return b;
}

function startPoll() {
  stopPoll();
  pollTimer = setInterval(async () => {
    try {
      const st = await call('/api/state');
      setBadge(st.machine.state, STATE_COPY[st.machine.state]?.title || st.machine.state);
      if (currentSession) {
        const hb = await call('/api/session/heartbeat', { method: 'POST', body: { sessionId: currentSession.id } });
        if (hb.state !== currentSession.state) {
          currentSession.state = hb.state;
          if (['closed', 'failed'].includes(hb.state)) {
            currentSession = null; phase = 'idle';
          }
        }
      }
      // Re-renderiza se o estado geral mudou.
      if (screenClient._last !== st.machine.state) {
        screenClient._last = st.machine.state;
        if (!currentSession) await refreshClient();
      }
    } catch { /* silencioso em polling */ }
  }, 2000);
}

async function startSession() {
  try {
    setPhase('connecting', 'Conectando ao PC…');
    const r = await call('/api/session/reserve', { method: 'POST' });
    currentSession = { id: r.sessionId, state: r.state, mode: r.mode };
    setPhase(
      'preparing',
      r.mode === 'full' ? 'Preparando o PC completo…' : 'Preparando seu ambiente isolado…'
    );
    const p = await call('/api/session/prepare', { method: 'POST', body: { sessionId: r.sessionId } });
    currentSession.state = p.state;
    currentSession.streamTarget = p.streamTarget;
    currentSession.mode = p.mode;
    phase = 'idle';
    toast('Sessão pronta! Abra o Moonlight para jogar.', 'ok');
    await refreshClient();
    launchStream();
  } catch (err) {
    phase = 'idle'; currentSession = null;
    toast(err.message, 'error');
    await refreshClient();
  }
}

function setPhase(p, msg) {
  phase = p;
  render(`<div class="card"><div class="spinner"></div><p class="sub" style="text-align:center">${msg}</p></div>`);
}

// Abre o Moonlight real. Em Android usa deep-link; em desktop mostra o endereço
// e tenta abrir o esquema moonlight://. NÃO simula o vídeo aqui.
function launchStream() {
  if (!currentSession?.streamTarget) return toast('Sessão sem alvo de streaming.', 'error');
  const host = currentSession.streamTarget.split(':')[0];
  const full = currentSession.mode === 'full';
  const step4 = full
    ? '4. No Moonlight, abra o host e escolha o app <strong>Desktop</strong> — você controla o PC inteiro.'
    : '4. Escolha o jogo que quer jogar e toque nele para iniciar o streaming.';
  render(`
    <div class="card">
      <h2>Streaming real via Moonlight</h2>
      <p class="sub">O vídeo, áudio e controles são transmitidos pelo <strong>Moonlight</strong> (projeto oficial), que conecta direto ao seu PC. O Moonshine reserva a sessão e libera o PC ao final.</p>
      <div class="kv" style="margin:14px 0">
        <span class="k">Modo</span><span class="v" style="font-weight:700">${full ? 'PC completo (desktop do dono)' : 'Jogo isolado (sessão descartável)'}</span>
        <span class="k">Host Sunshine</span><span class="v" style="font-weight:700">${host}</span>
        <span class="k">Porta GameStream</span><span class="v">47984 / 47989</span>
      </div>
      <div class="kv" style="margin:6px 0 14px;padding:12px;border:1px solid var(--line);border-radius:12px">
        <span class="k" style="line-height:1.5">Como jogar:<br>1. Abra o app <strong>Moonlight</strong>.<br>2. Adicione o host <strong>${host}</strong> (descoberta automática ou "Add computer" manual).<br>3. Se pedir PIN, use o pareador do painel admin (nos apps Moonshine isso é automático).<br>${step4}</span>
      </div>
      <button class="btn" id="copyHost">Copiar endereço do host</button>
      <button class="btn danger" id="endMl" style="margin-top:10px">Encerrar sessão</button>
      <p class="sub" style="margin-top:14px">Nota: o app Moonlight oficial não expõe um esquema <code>moonlight://</code> registrado, então a abertura automática não é garantida — por isso o passo a passo acima. O streaming em si é 100% real (Sunshine + Moonlight).</p>
    </div>`);
  el('copyHost').onclick = async () => {
    try { await navigator.clipboard.writeText(host); toast('Host copiado.', 'ok'); }
    catch { toast('Copie manualmente: ' + host, 'error'); }
  };
  el('endMl').onclick = endSession;
}

async function endSession() {
  if (!currentSession) return;
  phase = 'ending';
  setPhase('ending', 'Encerrando e limpando seu ambiente…');
  try {
    await call('/api/session/end', { method: 'POST', body: { sessionId: currentSession.id } });
    currentSession = null; phase = 'idle';
    toast('Sessão encerrada e ambiente descartado.', 'ok');
    await refreshClient();
  } catch (err) {
    toast(err.message, 'error');
    currentSession = null; phase = 'idle';
    await refreshClient();
  }
}

// ---- painel administrativo ---------------------------------------------------

async function screenAdmin() {
  render(`
    <div class="wide">
      <div class="tabs">
        <button class="tab active" data-t="status">Estado</button>
        <button class="tab" data-t="setup">Configuração</button>
        <button class="tab" data-t="users">Jogadores</button>
        <button class="tab" data-t="invites">Convites</button>
        <button class="tab" data-t="sunshine">Sunshine</button>
        <button class="tab" data-t="logs">Registros</button>
        <button class="tab" data-t="compat">Sistema</button>
        <button class="tab ghost" data-t="out" style="margin-left:auto">Sair</button>
      </div>
      <div id="tabBody"><div class="spinner"></div></div>
    </div>`);
  const tabs = view.querySelectorAll('.tab');
  tabs.forEach((t) => (t.onclick = () => {
    tabs.forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    adminTab(t.dataset.t);
  }));
  adminTab('status');
}

async function adminTab(t) {
  const body = el('tabBody');
  body.innerHTML = '<div class="spinner"></div>';
  try {
    if (t === 'status') return renderAdminStatus(body);
    if (t === 'setup') return renderAdminSetup(body);
    if (t === 'users') return renderAdminUsers(body);
    if (t === 'invites') return renderAdminInvites(body);
    if (t === 'sunshine') return renderAdminSunshine(body);
    if (t === 'logs') return renderAdminLogs(body);
    if (t === 'compat') return renderAdminCompat(body);
    if (t === 'out') { logoutLocal(); return screenLogin(); }
  } catch (err) { body.innerHTML = `<div class="card"><p class="sub">${err.message}</p></div>`; }
}

// Assistente de configuração completo — tudo no app do HOST (sem CLI/docs).
// Passos: ambiente → Sunshine → rede/Tailscale → teste.
async function renderAdminSetup(body) {
  let compat, net, sun = null;
  try {
    [compat, net] = await Promise.all([
      call('/api/admin/compatibility'),
      call('/api/admin/network'),
    ]);
    sun = (await call('/api/admin/sunshine')).sunshine;
  } catch (e) {
    body.innerHTML = `<div class="card"><p class="sub">${e.message}</p></div>`;
    return;
  }
  const ts = net.tailscale;
  const step = (n, title, inner) => `
    <div class="card">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
        <span class="chip ${n ? 'on' : 'warn'}">${n ? '✓' : '!'}</span>
        <h2 style="margin:0;font-size:17px">${title}</h2>
      </div>
      ${inner}
    </div>`;
  const gpuOk = compat.gpu.vendor !== 'unknown';
  body.innerHTML = `
    ${step(compat.ok, '1 · Ambiente', `
      <div class="kv">
        <span class="k">Sistema</span><span class="v">${compat.os.platform} ${compat.os.osRelease?.pretty || compat.os.release}</span>
        <span class="k">Bazzite</span><span class="v">${compat.os.osRelease?.isBazzite ? 'sim' : 'não'}</span>
        <span class="k">GPU</span><span class="v">${gpuOk ? compat.gpu.gpus.join(', ') : '<span class="chip off">não detectada</span>'}</span>
        <span class="k">RAM</span><span class="v">${compat.resources.memTotalGb} GB</span>
      </div>
      ${compat.issues.map((i) => `<p class="sub" style="color:var(--red);margin:8px 0 0">• ${i}</p>`).join('')}
      ${compat.notes.map((n) => `<p class="sub" style="margin:6px 0 0">• ${n}</p>`).join('')}`)}

    ${step(!!sun?.reachable, '2 · Sunshine (streaming)', `
      <div class="kv">
        <span class="k">Alcançável</span><span class="v">${sun?.reachable ? '<span class="chip on">sim</span>' : '<span class="chip off">não</span>'}</span>
        <span class="k">Hostname</span><span class="v">${sun?.hostname || '—'}</span>
        <span class="k">Ocupado</span><span class="v">${sun?.busy ? 'sim' : 'não'}</span>
      </div>
      <div class="row" style="margin-top:12px">
        <button class="btn secondary" id="suSync">Sincronizar</button>
        <button class="btn secondary" id="suDesk">App "Desktop"</button>
      </div>
      ${!sun?.reachable ? '<p class="sub" style="color:var(--red);margin:8px 0 0">Abra o Sunshine (Flatpak) e clique em Sincronizar.</p>' : ''}`)}

    ${step(ts.running && ts.ip, '3 · Rede para amigos (Tailscale)', `
      <p class="sub" style="margin:0 0 8px">Para amigos jogarem de fora, exponha o painel e o Sunshine por uma rede privada. Nada fica na internet pública.</p>
      <div class="kv">
        <span class="k">Tailscale instalado</span><span class="v">${ts.installed ? '<span class="chip on">sim</span>' : '<span class="chip off">não</span>'}</span>
        <span class="k">Rede ativa</span><span class="v">${ts.running ? '<span class="chip on">sim</span>' : '<span class="chip off">não</span>'}</span>
        <span class="k">IP privado</span><span class="v">${ts.ip || '—'}</span>
        <span class="k">Painel escutando em</span><span class="v">${net.bindHost}:${net.port}</span>
      </div>
      ${!ts.installed ? `<p class="sub" style="margin:10px 0 4px">Instale (Bazzite):</p><code style="display:block;background:var(--bg);padding:10px;border-radius:8px;font-size:12px">flatpak install -y flathub com.tailscale.tailscale</code>` : ''}
      ${ts.running && ts.ip && net.bindHost === '127.0.0.1' ? `
        <button class="btn" id="bindTs" style="margin-top:14px">Expor painel no IP Tailscale (${ts.ip})</button>` : ''}
      ${ts.running ? `<p class="sub" style="margin:12px 0 0">Depois, no terminal do Bazzite, termine o HTTPS:</p><code style="display:block;background:var(--bg);padding:10px;border-radius:8px;font-size:12px">${ts.cliPrefix || 'tailscale'} serve --bg --https=443 http://127.0.0.1:${net.port}</code><p class="sub" style="margin:6px 0 0">Amigos instalam Tailscale e você os convida. Depois abrem <strong>https://${ts.ip}</strong> (painel) — e no app Moonshine informam <strong>http://${ts.ip}:${net.port}</strong> — entrando com o <strong>código de convite</strong> gerado em "Convites".</p>` : ''}`)}

    <div class="card">
      <h2>4 · Amigos (código de convite)</h2>
      <p class="sub" style="margin:0 0 8px">Na aba <strong>Convites</strong>, gere um código por amigo e escolha o modo concedido: <strong>game</strong> (sessão isolada, sem seus arquivos) ou <strong>full</strong> (PC completo). Ele informa <code>${ts.ip ? `http://${ts.ip}:${net.port}` : 'o endereço do HOST'}</code> no app Moonshine e entra com o <strong>código</strong> — sem senha. Revogar o código corta o acesso. Só um jogador por vez.</p>
      <div class="row">
        <button class="btn" id="goInvites">Ir para Convites</button>
        <button class="btn secondary" id="goUsers">Ir para Jogadores</button>
      </div>
    </div>`;

  const b = (id, fn) => { const e = el(id); if (e) e.onclick = fn; };
  b('suSync', async () => {
    const r = await call('/api/admin/sunshine/sync', { method: 'POST' });
    toast(r.sunshine.reachable ? 'Sunshine OK.' : 'Sunshine indisponível.', r.sunshine.reachable ? 'ok' : 'error');
    renderAdminSetup(body);
  });
  b('suDesk', async () => {
    const r = await call('/api/admin/sunshine/desktop-app', { method: 'POST' });
    toast(r.ok ? 'App Desktop garantido.' : 'Falha: ' + (r.error || ''), r.ok ? 'ok' : 'error');
  });
  b('bindTs', async () => {
    // Além de expor o painel, aponta o Sunshine ao IP Tailscale: é de lá que sai
    // o streamTarget entregue aos jogadores (sem isso viraria 127.0.0.1 — o PC
    // do próprio jogador).
    await call('/api/admin/network', {
      method: 'POST',
      body: { bindHost: ts.ip, sunshineAddress: `${ts.ip}:47989` },
    });
    toast('Painel e Sunshine apontados para o Tailscale. Reinicie o serviço para aplicar.', 'ok');
    renderAdminSetup(body);
  });
  b('goInvites', () => {
    view.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.t === 'invites'));
    adminTab('invites');
  });
  b('goUsers', () => {
    view.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.t === 'users'));
    adminTab('users');
  });
}

async function renderAdminStatus(body) {  const st = await call('/api/state');
  const sessions = await call('/api/admin/sessions');
  const s = st.machine.state;
  body.innerHTML = `
    <div class="card">
      <h2>Estado do PC</h2>
      <div class="kv" style="margin-top:8px">
        <span class="k">Estado</span><span class="v">${s}</span>
        <span class="k">Detalhe</span><span class="v">${st.machine.detail || '—'}</span>
        <span class="k">Sessão atual</span><span class="v">${st.machine.sessionId || '—'}</span>
        <span class="k">Atualizado</span><span class="v">${new Date(st.machine.updatedAt).toLocaleString()}</span>
      </div>
      <div class="row" style="margin-top:16px">
        <button class="btn secondary" id="syncSun">Sincronizar Sunshine</button>
        ${['locked', 'error'].includes(s) ? '<button class="btn danger" id="unlock">Liberar máquina</button>' : ''}
      </div>
    </div>
    <div class="card">
      <h2>Sessões recentes</h2>
      <table class="table"><thead><tr><th>#</th><th>Usuário</th><th>Estado</th><th>Limpeza</th><th>Criada</th></tr></thead>
      <tbody>${sessions.sessions.slice(0, 10).map((x) => `
        <tr><td class="num">${x.id}</td><td>${x.user_id}</td><td>${x.state}</td>
        <td>${x.cleanup_ok === 1 ? '<span class="chip on">ok</span>' : x.cleanup_ok === 0 ? '<span class="chip off">falhou</span>' : '<span class="chip warn">—</span>'}</td>
        <td>${new Date(x.created_at).toLocaleString()}</td></tr>`).join('') || '<tr><td colspan=5>Nenhuma sessão.</td></tr>'}</tbody></table>
    </div>`;
  el('syncSun').onclick = async () => {
    const r = await call('/api/admin/sunshine/sync', { method: 'POST' });
    toast(r.sunshine.reachable ? 'Sunshine alcançável.' : 'Sunshine inacessível.', r.sunshine.reachable ? 'ok' : 'error');
    renderAdminStatus(body);
  };
  const un = el('unlock');
  if (un) un.onclick = async () => {
    if (!confirm('Liberar a máquina? Confirme que verificou que nenhum dado sensível restou.')) return;
    await call('/api/admin/machine/unlock', { method: 'POST' });
    toast('Máquina liberada.', 'ok'); renderAdminStatus(body);
  };
}

async function renderAdminUsers(body) {
  const r = await call('/api/admin/users');
  body.innerHTML = `
    <div class="card">
      <h2>Jogadores e administradores</h2>
      <p class="sub">Cada jogador tem uma senha da plataforma (não da Steam). Desativar revoga o acesso e as sessões.</p>
      <table class="table"><thead><tr><th>Usuário</th><th>Papel</th><th>Ativo</th><th></th></tr></thead>
      <tbody>${r.users.map((u) => `
        <tr><td>${u.username}</td><td>${u.role}</td>
        <td>${u.active ? '<span class="chip on">ativo</span>' : '<span class="chip off">inativo</span>'}</td>
        <td style="text-align:right">
          <button class="btn ghost" data-toggle="${u.id}" data-active="${u.active}">${u.active ? 'Desativar' : 'Ativar'}</button>
          <button class="btn ghost" data-del="${u.id}">Excluir</button>
        </td></tr>`).join('') || '<tr><td colspan=4>Nenhum usuário.</td></tr>'}</tbody></table>
    </div>
    <div class="card">
      <h2>Adicionar jogador</h2>
      <form id="addForm" class="stack">
        <label>Usuário</label><input id="nu" required pattern="[a-zA-Z0-9._-]{3,32}" />
        <label>Senha (mín. 8)</label><input id="np" type="password" required minlength="8" />
        <label>Papel</label><select id="nr"><option value="player">Jogador</option><option value="admin">Administrador</option></select>
        <button class="btn" style="margin-top:14px">Adicionar</button>
      </form>
    </div>`;
  body.querySelectorAll('[data-toggle]').forEach((b) => (b.onclick = async () => {
    await call(`/api/admin/users/${b.dataset.toggle}`, { method: 'PUT', body: { active: b.dataset.active !== 'true' } });
    renderAdminUsers(body);
  }));
  body.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
    if (!confirm('Excluir este usuário?')) return;
    await call(`/api/admin/users/${b.dataset.del}`, { method: 'DELETE' });
    renderAdminUsers(body);
  }));
  el('addForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await call('/api/admin/users', { method: 'POST', body: { username: el('nu').value.trim(), password: el('np').value, role: el('nr').value } });
      toast('Usuário criado.', 'ok'); renderAdminUsers(body);
    } catch (err) { toast(err.message, 'error'); }
  };
}

// Copiar para a área de transferência (com fallback: a API de clipboard exige
// contexto seguro/HTTPS — em HTTP na rede local usamos o método legado).
function copyText(txt) {
  const fallback = () => {
    try {
      const ta = document.createElement('textarea');
      ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch { return false; }
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(txt)
      .then(() => toast('Copiado.', 'ok'))
      .catch(() => toast(fallback() ? 'Copiado.' : 'Não foi possível copiar.', fallback() ? 'ok' : 'error'));
    return;
  }
  toast(fallback() ? 'Copiado.' : 'Não foi possível copiar.', fallback() ? 'ok' : 'error');
}

async function renderAdminInvites(body) {
  const [r, u] = await Promise.all([call('/api/admin/invites'), call('/api/admin/users')]);
  const players = u.users.filter((x) => x.role === 'player' && x.active);
  const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString() : 'nunca');
  body.innerHTML = `
    <div class="card">
      <h2>Códigos de convite</h2>
      <p class="sub">Gere um código e envie ao jogador — ele entra com o código, sem senha.
        O <strong>modo</strong> é decidido aqui: <em>game</em> (sessão isolada, sem seus arquivos) ou
        <em>full</em> (PC completo, a pessoa controla o desktop). Revogar o código corta o acesso.</p>
      <form id="invForm" class="stack" style="margin-top:10px">
        <label>Modo concedido</label>
        <select id="im">
          <option value="game">Game — sessão isolada (recomendado)</option>
          <option value="full">PC completo — acesso total ao desktop</option>
        </select>
        <label>Vincular a jogador (opcional)</label>
        <select id="iu">
          <option value="">Criar jogador automaticamente</option>
          ${players.map((p) => `<option value="${p.id}">${p.username}</option>`).join('')}
        </select>
        <div class="row">
          <div style="flex:1"><label>Validade em minutos (vazio = nunca)</label><input id="ie" type="number" min="1" placeholder="nunca" /></div>
          <div style="flex:1"><label>Usos máximos</label><input id="ix" type="number" min="1" max="1000" value="1" /></div>
        </div>
        <label>Nota (opcional)</label><input id="inote" maxlength="200" placeholder="ex.: aluno da turma B" />
        <button class="btn" style="margin-top:14px">Gerar código</button>
      </form>
      <div id="newCode"></div>
    </div>

    <div class="card">
      <h2>Códigos emitidos</h2>
      <table class="table"><thead><tr><th>Código</th><th>Modo</th><th>Jogador</th><th>Usos</th><th>Validade</th><th>Status</th><th></th></tr></thead>
      <tbody>${r.invites
        .map((i) => {
          const expired = i.expires_at != null && i.expires_at <= Date.now();
          const used = i.uses >= i.max_uses;
          const status = !i.active
            ? '<span class="chip off">revogado</span>'
            : expired
              ? '<span class="chip off">expirado</span>'
              : used
                ? '<span class="chip off">esgotado</span>'
                : '<span class="chip on">ativo</span>';
          return `<tr>
            <td><code>${i.code}</code></td>
            <td>${i.mode === 'full' ? 'PC completo' : 'game'}</td>
            <td>${i.username || '—'}</td>
            <td>${i.uses}/${i.max_uses}</td>
            <td>${fmtDate(i.expires_at)}</td>
            <td>${status}</td>
            <td style="text-align:right;white-space:nowrap">
              <button class="btn ghost" data-copy="${i.code}">Copiar</button>
              <button class="btn ghost" data-revoke="${i.id}" ${i.active ? '' : 'disabled'}>Revogar</button>
            </td>
          </tr>`;
        })
        .join('') || '<tr><td colspan="7">Nenhum convite emitido.</td></tr>'}</tbody></table>
    </div>`;

  body.querySelectorAll('[data-copy]').forEach((b) => (b.onclick = () => copyText(b.dataset.copy)));
  body.querySelectorAll('[data-revoke]').forEach((b) => (b.onclick = async () => {
    try {
      await call('/api/admin/invites/revoke', { method: 'POST', body: { id: Number(b.dataset.revoke) } });
      toast('Convite revogado.', 'ok');
      renderAdminInvites(body);
    } catch (err) { toast(err.message, 'error'); }
  }));

  el('invForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const payload = {
        mode: el('im').value,
        maxUses: Number(el('ix').value) || 1,
        note: el('inote').value.trim() || null,
      };
      const uid = el('iu').value;
      if (uid) payload.userId = Number(uid);
      const mins = el('ie').value;
      if (mins) payload.expiresInMin = Number(mins);
      const c = await call('/api/admin/invites', { method: 'POST', body: payload });
      await renderAdminInvites(body); // atualiza a lista (já inclui o novo)
      el('newCode').innerHTML = `
        <div class="card" style="border-color:var(--accent);margin-top:14px">
          <p class="sub">Código gerado — <strong>envie ao jogador</strong>:</p>
          <p style="font-family:monospace;font-size:22px;letter-spacing:2px;margin:8px 0"><code>${c.code}</code></p>
          <p class="sub">Modo: <strong>${c.mode === 'full' ? 'PC completo' : 'game'}</strong> · Jogador: ${c.username} · Usos: ${c.maxUses}${c.expiresAt ? ` · expira ${fmtDate(c.expiresAt)}` : ''}</p>
          <button class="btn" id="copyNew">Copiar código</button>
        </div>`;
      el('copyNew').onclick = () => copyText(c.code);
      toast('Convite criado.', 'ok');
    } catch (err) { toast(err.message, 'error'); }
  };
}

async function renderAdminSunshine(body) {
  const info = await call('/api/admin/sunshine');
  const s = info.sunshine;
  let pairing = { clients: null, pending: null };
  try { pairing = (await call('/api/admin/sunshine/pairing')).pairing; } catch { /* sem creds */ }
  const clients = pairing.clients?.named_certs || [];
  const pending = pairing.pending?.pairings || [];
  body.innerHTML = `
    <div class="card">
      <h2>Sunshine (servidor de streaming)</h2>
      <p class="sub">O Moonlight conecta diretamente no Sunshine para transmitir. O Moonshine gerencia a sessão ao redor disso.</p>
      <div class="kv" style="margin-top:8px">
        <span class="k">Alcançável</span><span class="v">${s.reachable ? '<span class="chip on">sim</span>' : '<span class="chip off">não</span>'}</span>
        <span class="k">Hostname</span><span class="v">${s.hostname || '—'}</span>
        <span class="k">Ocupado</span><span class="v">${s.busy ? 'sim' : 'não'}</span>
        <span class="k">Jogo atual</span><span class="v">${s.currentGame || '—'}</span>
      </div>
      <button class="btn secondary" id="deskApp" style="margin-top:14px">Garantir app "Desktop"</button>
    </div>
    <div class="card">
      <h2>Pareamento Moonlight ↔ Sunshine</h2>
      <p class="sub">Adicione o host no Moonlight, aguarde o PIN e digite abaixo para concluir o pareamento (fluxo oficial do Sunshine).</p>
      <div class="kv" style="margin:10px 0">
        <span class="k">Clientes pareados</span><span class="v">${clients.length}</span>
        <span class="k">Pareamentos pendentes</span><span class="v">${pending.length}</span>
      </div>
      ${clients.map((c) => `<div class="kv"><span class="k">${c.name || c.uuid}</span><span class="v">${c.enabled ? '<span class="chip on">ativo</span>' : '<span class="chip off">inativo</span>'}</span></div>`).join('')}
      ${pending.map((p) => `
        <div style="margin-top:12px;padding:12px;border:1px solid var(--line);border-radius:12px">
          <div class="kv"><span class="k">Dispositivo</span><span class="v">${p.name || p.address || '—'}</span></div>
          <div class="kv"><span class="k">ID</span><span class="v" style="font-size:11px">${p.id}</span></div>
          <label>PIN (4 dígitos)</label>
          <div class="row"><input id="pin-${p.id}" maxlength="4" inputmode="numeric" placeholder="0000" /><button class="btn" data-pin="${p.id}" style="flex:0 0 auto;width:auto;padding:0 18px">Enviar</button></div>
        </div>`).join('') || '<p class="sub">Nenhum pareamento pendente no momento.</p>'}
    </div>
    <div class="card">
      <h2>Credenciais da Web UI do Sunshine</h2>
      <p class="sub">Persistidas no config do HOST (0600) para falar a API. Não são credenciais da Steam nem do jogador.</p>
      <form id="credForm" class="stack">
        <label>Usuário Sunshine</label><input id="cu" autocomplete="off" />
        <label>Senha Sunshine</label><input id="cp" type="password" autocomplete="off" />
        <button class="btn secondary" style="margin-top:14px">Salvar</button>
      </form>
    </div>`;
  el('deskApp').onclick = async () => {
    const r = await call('/api/admin/sunshine/desktop-app', { method: 'POST' });
    toast(r.ok ? 'App Desktop garantido.' : 'Falha: ' + (r.error || r.status), r.ok ? 'ok' : 'error');
  };
  body.querySelectorAll('[data-pin]').forEach((b) => (b.onclick = async () => {
    const pin = el('pin-' + b.dataset.pin).value;
    try {
      const r = await call('/api/admin/sunshine/pairing', { method: 'POST', body: { pairingId: b.dataset.pin, pin } });
      toast(r.ok ? 'Pareamento concluído!' : 'Falha no pareamento.', r.ok ? 'ok' : 'error');
      renderAdminSunshine(body);
    } catch (err) { toast(err.message, 'error'); }
  }));
  el('credForm').onsubmit = async (e) => {
    e.preventDefault();
    await call('/api/admin/sunshine/credentials', { method: 'POST', body: { username: el('cu').value, password: el('cp').value } });
    toast('Credenciais do Sunshine salvas.', 'ok');
    renderAdminSunshine(body);
  };
}

async function renderAdminLogs(body) {
  const [ev, at] = await Promise.all([call('/api/admin/events'), call('/api/admin/attempts')]);
  body.innerHTML = `
    <div class="card">
      <h2>Registros de eventos</h2>
      <table class="table"><thead><tr><th>Quando</th><th>Nível</th><th>Mensagem</th></tr></thead>
      <tbody>${ev.events.slice(0, 30).map((e) => `
        <tr><td class="num">${new Date(e.at).toLocaleTimeString()}</td>
        <td><span class="chip ${e.level === 'error' ? 'off' : e.level === 'warn' ? 'warn' : 'on'}">${e.level}</span></td>
        <td>${e.message}${e.ctx ? ` <span class="k">${e.ctx}</span>` : ''}</td></tr>`).join('') || '<tr><td colspan=3>Nenhum evento.</td></tr>'}</tbody></table>
    </div>
    <div class="card">
      <h2>Tentativas de login</h2>
      <table class="table"><thead><tr><th>Usuário</th><th>IP</th><th>Resultado</th><th>Quando</th></tr></thead>
      <tbody>${at.attempts.slice(0, 20).map((a) => `
        <tr><td>${a.username}</td><td>${a.ip}</td>
        <td>${a.ok ? '<span class="chip on">ok</span>' : '<span class="chip off">falhou</span>'}</td>
        <td class="num">${new Date(a.at).toLocaleString()}</td></tr>`).join('') || '<tr><td colspan=4>Nenhuma tentativa.</td></tr>'}</tbody></table>
    </div>`;
}

async function renderAdminCompat(body) {
  const c = await call('/api/admin/compatibility');
  body.innerHTML = `
    <div class="card">
      <h2>Diagnóstico do sistema</h2>
      <div class="kv" style="margin-top:8px">
        <span class="k">Plataforma</span><span class="v">${c.os.platform} ${c.os.release}</span>
        <span class="k">Bazzite</span><span class="v">${c.os.osRelease?.isBazzite ? 'sim' : 'não'}</span>
        <span class="k">GPU</span><span class="v">${c.gpu.gpus.join(', ') || '—'}</span>
        <span class="k">Fornecedor</span><span class="v">${c.gpu.vendor}</span>
        <span class="k">CPU</span><span class="v">${c.resources.cpuModel} (${c.resources.cpuCount})</span>
        <span class="k">RAM</span><span class="v">${c.resources.memTotalGb} GB</span>
      </div>
    </div>
    <div class="card">
      <h2>Compatibilidade</h2>
      ${c.issues.map((i) => `<p class="sub" style="color:var(--red)">• ${i}</p>`).join('')}
      ${c.notes.map((n) => `<p class="sub">• ${n}</p>`).join('')}
      ${!c.issues.length ? '<p class="sub" style="color:var(--green)">Nenhum problema bloqueante detectado.</p>' : ''}
    </div>`;
}

// ---- boot --------------------------------------------------------------------

async function boot() {
  el('accountBtn').onclick = async () => {
    if (api.token) { try { await call('/api/logout', { method: 'POST' }); } catch { /* ignora */ } }
    logoutLocal(); screenLogin();
  };
  try {
    const setup = await call('/api/setup-required');
    if (setup.required) return screenSetup();
    if (api.token && api.user) {
      el('accountBtn').classList.remove('hidden');
      return api.user.role === 'admin' ? screenAdmin() : screenClient();
    }
    screenLogin();
  } catch (err) {
    render(`<div class="card"><h2>Sem conexão com o HOST</h2><p class="sub">${err.message}</p></div>`);
  }
}
boot();
