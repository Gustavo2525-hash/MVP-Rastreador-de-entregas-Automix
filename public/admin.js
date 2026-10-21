const formularioUsuario = document.getElementById('form-usuario');
const mensagemAdmin = document.getElementById('mensagem-admin');
const listaUsuarios = document.getElementById('lista-usuarios');
const totalUsuarios = document.getElementById('total-usuarios');

const rotulosPapel = {
  master: 'Master',
  roteirizador: 'Roteirizador',
  motorista: 'Motorista',
};

async function lerJson(resposta) {
  const texto = await resposta.text();
  try { return texto ? JSON.parse(texto) : {}; }
  catch { throw new Error(`Resposta inesperada do servidor (HTTP ${resposta.status}).`); }
}

async function iniciarAdmin() {
  try {
    const resposta = await fetch('/api/auth/session', { cache: 'no-store' });
    const dados = await lerJson(resposta);
    if (!dados.usuario) return window.location.replace('/login.html');
    if (dados.usuario.papel !== 'master') return window.location.replace('/');
    document.getElementById('saudacao-admin').textContent = `Olá, ${dados.usuario.nome}`;
    await carregarUsuarios();
  } catch (erro) {
    mensagemAdmin.textContent = erro.message;
    mensagemAdmin.dataset.tipo = 'erro';
  }
}

async function carregarUsuarios() {
  listaUsuarios.setAttribute('aria-busy', 'true');
  try {
    const resposta = await fetch('/api/usuarios', { cache: 'no-store' });
    const usuarios = await lerJson(resposta);
    if (!resposta.ok) throw new Error(usuarios.erro || 'Não foi possível carregar os usuários.');
    totalUsuarios.textContent = String(usuarios.length);
    listaUsuarios.replaceChildren();
    for (const usuario of usuarios) {
      const linha = document.createElement('article');
      linha.className = 'usuario-admin';
      const dados = document.createElement('div');
      const nome = document.createElement('strong');
      nome.textContent = usuario.nome;
      const identificador = document.createElement('p');
      identificador.textContent = `Usuário: ${usuario.usuario}`;
      dados.append(nome, identificador);
      const papel = document.createElement('span');
      papel.className = `papel-admin ${usuario.papel}`;
      papel.textContent = rotulosPapel[usuario.papel] || usuario.papel;
      const estado = document.createElement('span');
      estado.className = 'estado-admin';
      estado.textContent = usuario.ativo ? 'Acesso ativo' : 'Acesso desativado';
      linha.append(dados, papel, estado);
      listaUsuarios.appendChild(linha);
    }
  } catch (erro) {
    totalUsuarios.textContent = '—';
    listaUsuarios.textContent = erro.message;
  } finally {
    listaUsuarios.setAttribute('aria-busy', 'false');
  }
}

document.getElementById('papel-usuario').addEventListener('change', (evento) => {
  document.getElementById('ajuda-motorista').hidden = evento.target.value !== 'motorista';
});

formularioUsuario.addEventListener('submit', async (evento) => {
  evento.preventDefault();
  const botao = document.getElementById('criar-usuario');
  botao.disabled = true;
  botao.textContent = 'Criando acesso…';
  mensagemAdmin.textContent = '';
  try {
    const resposta = await fetch('/api/usuarios', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.fromEntries(new FormData(formularioUsuario))),
    });
    const dados = await lerJson(resposta);
    if (!resposta.ok) throw new Error(dados.erro || 'Não foi possível criar o acesso.');
    formularioUsuario.reset();
    document.getElementById('ajuda-motorista').hidden = true;
    mensagemAdmin.textContent = `Acesso de ${dados.nome} criado. Compartilhe o usuário e a senha inicial diretamente com essa pessoa.`;
    mensagemAdmin.dataset.tipo = 'sucesso';
    await carregarUsuarios();
  } catch (erro) {
    mensagemAdmin.textContent = erro.message;
    mensagemAdmin.dataset.tipo = 'erro';
  } finally {
    botao.disabled = false;
    botao.textContent = 'Criar acesso';
  }
});

document.getElementById('sair-admin').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.replace('/login.html');
});

iniciarAdmin();
