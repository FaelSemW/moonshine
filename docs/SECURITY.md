# Modelo de Segurança e Isolamento de Sessões

Este documento descreve as decisões de segurança do Moonshine Cloud Gaming e os
seus limites reais. Não promete proteção que a arquitetura não oferece.

## Princípio central

O jogador recebe um **ambiente temporário isolado** que não expõe os dados
privados do proprietário nem de outros jogadores. O jogador **nunca** roda como
o proprietário e **nunca** recebe acesso administrativo.

## Estratégia de isolamento (Linux/Bazzite)

Para cada sessão o HOST usa um **usuário Linux dedicado** (ex.: `msplayer-a1b2`):

1. O usuário dedicado é criado com `useradd --create-home --shell /usr/sbin/nologin`.
2. O `HOME` desse usuário é um diretório temporário sob
   `/var/tmp/moonshine-sessions/s<id>-<rand>`, com permissões `0700`.
3. O jogador opera **como esse usuário**, não como o proprietário. Os arquivos
   pessoais do proprietário pertencem a outro usuário com permissões que não
   concedem leitura ao jogador.
4. A **biblioteca de jogos permanente** é exposta **somente leitura** (bind
   mount `ro` ou permissão de leitura). O jogador não modifica os jogos.
5. Saves/caches/configurações da sessão são gravados no HOME temporário.

Ao final da sessão (passos 8–12 do ciclo):

6. Os processos do usuário dedicado são terminados (`pkill -u`).
7. O `HOME` temporário é removido (`rm -rf`), **após validação canônica** de que
   o caminho está sob o escopo autorizado.
8. O usuário dedicado é removido (`userdel --remove`).
9. Verifica-se que o diretório não existe mais e que nenhum processo sobreviveu.
10. **Somente após verificação OK** a máquina volta a `available`.

### Por que usuário dedicado e não só um diretório?

Um diretório separado, isolado, **não** é fronteira de segurança: o processo do
jogador ainda rodaria como o proprietário e poderia ler qualquer arquivo legível
pelo proprietário (chaves, saves, navegador, Steam). Usuário dedicado muda a
**identidade de segurança** do processo, que é a fronteira real do SO.

## Se a limpeza falhar

Se a verificação pós-limpeza encontrar diretório remanescente ou processo
sobrevivente, a máquina entra em estado **`locked`** e **não aceita novas
sessões** até o administrador fazer a recuperação manual
(`POST /api/admin/machine/unlock`). O produto prefere ficar indisponível a
arriscar vazar dados entre jogadores.

## Limites honestos desta primeira versão

- **Saves na nuvem (Steam Cloud):** dados sincronizados com serviços externos
  (Steam Cloud, contas de terceiros) **não são apagáveis** pelo HOST. Continuam
  sujeitos aos termos do próprio serviço. O Moonshine não promete o contrário.
- **Steam:** o jogador usa a **interface oficial da Steam** com a **própria
  conta**. O Moonshine **não** coleta, armazena nem transmite credenciais da
  Steam. A senha da plataforma ≠ senha da Steam.
- **Biblioteca compartilhada:** jogos que gravam em diretórios protegidos podem
  ter comportamento variável; quando não é possível garantir segurança, a
  funcionalidade é restrita e documentada (ver `BAZZITE.md`).
- **Windows (desenvolvimento):** o modo `temp-home` usa um diretório temporário
  **sem** isolamento de SO. Não é adequado para jogadores não confiáveis; serve
  apenas para validar o plano de controle.

## Segurança da API de controle

- Escuta em **loopback** por padrão; exposta na rede privada via **Tailscale
  Serve** (HTTPS). Nunca diretamente à internet pública.
- Senhas com **scrypt** (salt por usuário), nunca texto claro.
- Tokens de sessão: 256 bits aleatórios, gravados apenas como **SHA-256** no
  banco; revogáveis a qualquer momento (logout, desativação de usuário).
- **Rate limit** de login: após 5 falhas numa janela de 15 min, bloqueio (429).
- Nenhuma rota executa comando arbitrário vindo da rede. Nenhuma rota aceita
  caminho de arquivo do cliente.
- Cabeçalhos de segurança (`nosniff`, `X-Frame-Options: DENY`, etc.) em toda
  resposta. Corpo limitado a 64 KB.
- Máquina impede **sessão simultânea**: reserva atômica, um jogador por vez.

## Credenciais do Sunshine

O HOST pode guardar, **em memória de processo**, as credenciais da Web UI do
Sunshine para falar a API dele. Isso não são credenciais de jogador nem da Steam.
