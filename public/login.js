const areaLogin = document.getElementById('area-login');
const areaBootstrap = document.getElementById('area-bootstrap');
const mensagemAcesso = document.getElementById('mensagem-acesso');

async function lerJson(resposta) {
  const texto = await resposta.text();
  try { return texto ? JSON.parse(texto) : {}; }
  catch { throw new Error(`Resposta inesperada do servidor (HTTP ${resposta.status}).`); }
}

function abrirAreaDoPapel(papel) {
  const destinos = { master: '/admin.html', roteirizador: '/', motorista: '/motorista.html' };
  window.location.replace(destinos[papel] || '/login.html');
}

async function iniciarAcesso() {
  try {
    const sessaoResposta = await fetch('/api/auth/session', { cache: 'no-store' });
    const sessao = await lerJson(sessaoResposta);
    if (sessao.usuario) return abrirAreaDoPapel(sessao.usuario.papel);

    const resposta = await fetch('/api/auth/status', { cache: 'no-store' });
    const estado = await lerJson(resposta);
    if (!resposta.ok) throw new Error(estado.erro || 'Não foi possível verificar o sistema.');
    areaLogin.hidden = estado.precisaConfiguracao;
    areaBootstrap.hidden = !estado.precisaConfiguracao;
    mensagemAcesso.textContent = '';
  } catch (erro) {
    mensagemAcesso.textContent = erro.message;
    mensagemAcesso.dataset.tipo = 'erro';
  }
}

document.getElementById('form-login').addEventListener('submit', async (evento) => {
  evento.preventDefault();
  const botao = evento.currentTarget.querySelector('button[type="submit"]');
  botao.disabled = true;
  botao.textContent = 'Verificando…';
  mensagemAcesso.textContent = '';
  try {
    const resposta = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.fromEntries(new FormData(evento.currentTarget))),
    });
    const dados = await lerJson(resposta);
    if (!resposta.ok) throw new Error(dados.erro || 'Não foi possível entrar.');
    abrirAreaDoPapel(dados.usuario.papel);
  } catch (erro) {
    mensagemAcesso.textContent = erro.message;
    mensagemAcesso.dataset.tipo = 'erro';
  } finally {
    botao.disabled = false;
    botao.textContent = 'Entrar';
  }
});

document.getElementById('form-bootstrap').addEventListener('submit', async (evento) => {
  evento.preventDefault();
  const form = evento.currentTarget;
  const senha = form.elements.namedItem('senha').value;
  const confirmacao = form.elements.namedItem('confirmarSenha').value;
  if (senha !== confirmacao) {
    mensagemAcesso.textContent = 'As senhas não coincidem.';
    mensagemAcesso.dataset.tipo = 'erro';
    return;
  }
  const botao = form.querySelector('button[type="submit"]');
  botao.disabled = true;
  botao.textContent = 'Criando conta…';
  mensagemAcesso.textContent = '';
  try {
    const resposta = await fetch('/api/auth/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ senha }),
    });
    const dados = await lerJson(resposta);
    if (!resposta.ok) throw new Error(dados.erro || 'Não foi possível criar a conta master.');
    abrirAreaDoPapel(dados.usuario.papel);
  } catch (erro) {
    mensagemAcesso.textContent = erro.message;
    mensagemAcesso.dataset.tipo = 'erro';
  } finally {
    botao.disabled = false;
    botao.textContent = 'Criar conta master';
  }
});

iniciarAcesso();
