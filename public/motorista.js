const listaRota = document.getElementById('lista-rota');
const mensagemRota = document.getElementById('mensagem-rota');
const dialogFinalizar = document.getElementById('dialog-finalizar');
const formFinalizar = document.getElementById('form-finalizar');
const mensagemFinalizar = document.getElementById('mensagem-finalizar');
const campoTempoRota = document.getElementById('tempo-rota');
const avisoConexao = document.getElementById('estado-conexao');
const textoEstadoConexao = document.getElementById('texto-estado-conexao');
const botaoTentarSincronizar = document.getElementById('tentar-sincronizar');
const painelInicioRota = document.getElementById('painel-inicio-rota');
const botaoIniciarRota = document.getElementById('botao-iniciar-rota');
const resumoInicioRota = document.getElementById('resumo-inicio-rota');
const nomeMotoristaLocal = 'rastreabilidade_motorista_offline';
const nomeBancoOffline = 'rastreabilidade-motorista-v1';
let motoristaAtual = null;
let dadosRotaAtual = null;
let segundosEmRota = null;
let horaSincronizacao = 0;
let rotaEmAndamento = false;
let rotaIniciadaAtual = false;
let carregandoRota = false;
let sincronizandoFila = false;

function abrirBancoOffline() {
  return new Promise((resolve, reject) => {
    const requisicao = indexedDB.open(nomeBancoOffline, 1);
    requisicao.onupgradeneeded = () => {
      const banco = requisicao.result;
      if (!banco.objectStoreNames.contains('rotas')) banco.createObjectStore('rotas', { keyPath: 'motorista' });
      if (!banco.objectStoreNames.contains('fila')) banco.createObjectStore('fila', { keyPath: 'id' });
    };
    requisicao.onsuccess = () => resolve(requisicao.result);
    requisicao.onerror = () => reject(requisicao.error);
  });
}

async function acessarOffline(nomeLoja, modo, executar) {
  const banco = await abrirBancoOffline();
  return new Promise((resolve, reject) => {
    const transacao = banco.transaction(nomeLoja, modo);
    const requisicao = executar(transacao.objectStore(nomeLoja));
    requisicao.onsuccess = () => resolve(requisicao.result);
    requisicao.onerror = () => reject(requisicao.error);
    transacao.oncomplete = () => banco.close();
    transacao.onerror = () => { banco.close(); reject(transacao.error); };
  });
}

const salvarRotaOffline = (rota) => acessarOffline('rotas', 'readwrite', (loja) => loja.put(rota));
const buscarRotaOffline = (motorista) => acessarOffline('rotas', 'readonly', (loja) => loja.get(motorista));
const salvarNaFilaOffline = (parada) => acessarOffline('fila', 'readwrite', (loja) => loja.put(parada));
const removerDaFilaOffline = (id) => acessarOffline('fila', 'readwrite', (loja) => loja.delete(String(id)));
const listarFilaOffline = () => acessarOffline('fila', 'readonly', (loja) => loja.getAll());

async function respostaJson(resposta) {
  const texto = await resposta.text();
  try { return texto ? JSON.parse(texto) : {}; }
  catch { throw new Error(`O servidor respondeu de forma inesperada (HTTP ${resposta.status}).`); }
}

function definirEstadoConexao(texto, tipo = 'offline', permitirRetentativa = false) {
  avisoConexao.hidden = !texto;
  textoEstadoConexao.textContent = texto || '';
  botaoTentarSincronizar.hidden = !permitirRetentativa;
  avisoConexao.dataset.tipo = tipo;
}

async function atualizarEstadoConexao() {
  const rotaSalva = motoristaAtual ? await obterRotaSalva() : null;
  const inicioPendente = Boolean(rotaSalva?.inicioPendente);
  if (!navigator.onLine) {
    const fila = motoristaAtual ? (await listarFilaOffline()).filter((parada) => parada.motorista === motoristaAtual) : [];
    const textoOffline = inicioPendente && fila.length
      ? `Sem internet. O início da rota e ${fila.length} registro${fila.length === 1 ? '' : 's'} estão salvos neste celular; enviaremos quando a conexão voltar.`
      : inicioPendente
        ? 'Sem internet. O início da rota está salvo neste celular; enviaremos quando a conexão voltar.'
        : fila.length
          ? `Sem internet. ${fila.length} registro${fila.length === 1 ? '' : 's'} salvo${fila.length === 1 ? '' : 's'} neste celular; enviaremos quando a conexão voltar.`
          : 'Sem internet. A rota está salva neste celular.';
    definirEstadoConexao(textoOffline, 'offline');
    return;
  }
  const fila = motoristaAtual ? (await listarFilaOffline()).filter((parada) => parada.motorista === motoristaAtual) : [];
  const comFalha = fila.find((parada) => parada.erroSync);
  definirEstadoConexao(inicioPendente
    ? `O início da rota ainda não foi confirmado pela central${fila.length ? `; ${fila.length} registro${fila.length === 1 ? '' : 's'} também aguardam envio` : ''}.`
    : fila.length
      ? comFalha
      ? `${fila.length} registro${fila.length === 1 ? '' : 's'} ainda não chegou${fila.length === 1 ? '' : 'aram'} à central. ${comFalha.erroSync}`
      : `Enviando ${fila.length} registro${fila.length === 1 ? '' : 's'} pendente${fila.length === 1 ? '' : 's'}…`
      : '', inicioPendente || fila.length ? (comFalha ? 'offline' : 'sync') : 'online', Boolean(inicioPendente || fila.length));
}

function mostrarTempoEmRota() {
  if (segundosEmRota === null) { campoTempoRota.textContent = '00:00:00'; return; }
  const decorrido = segundosEmRota + (rotaEmAndamento ? Math.floor((Date.now() - horaSincronizacao) / 1000) : 0);
  const partes = [Math.floor(decorrido / 3600), Math.floor((decorrido % 3600) / 60), decorrido % 60];
  campoTempoRota.textContent = partes.map((parte) => String(parte).padStart(2, '0')).join(':');
}

function atualizarResumo(resumo, horaDados = Date.now(), fila = [], rotaSalva = dadosRotaAtual) {
  const filaDoMotorista = fila.filter((parada) => parada.motorista === motoristaAtual);
  const idsPendentesLocais = new Set(filaDoMotorista.map((parada) => String(parada.id)));
  const feitas = Number(resumo.feitas || 0) + filaDoMotorista.length;
  const faltam = Math.max(0, Number(resumo.faltam || 0) - filaDoMotorista.length);
  document.getElementById('total-feitas').textContent = String(feitas);
  document.getElementById('total-faltam').textContent = String(faltam);
  const inicioLocalPendente = rotaSalva?.inicioPendente && rotaSalva?.inicioLocalEm;
  rotaIniciadaAtual = Boolean(resumo.rota_iniciada || inicioLocalPendente);
  const tempoBase = resumo.tempo_em_rota_segundos;
  segundosEmRota = inicioLocalPendente
    ? Math.max(0, Math.floor((Date.now() - rotaSalva.inicioLocalEm) / 1000))
    : tempoBase === null || tempoBase === undefined || !rotaIniciadaAtual
      ? null
      : Number(tempoBase) + Math.floor((Date.now() - horaDados) / 1000);
  horaSincronizacao = Date.now();
  rotaEmAndamento = Boolean(resumo.rota_ativa || inicioLocalPendente) && faltam > 0;
  const rotaDisponivel = Boolean(resumo.rota_enviada || Number(resumo.faltam) > 0 || idsPendentesLocais.size > 0);
  painelInicioRota.hidden = !rotaDisponivel || rotaIniciadaAtual;
  botaoIniciarRota.disabled = !rotaDisponivel;
  if (rotaDisponivel && !rotaIniciadaAtual) {
    const totalParadas = Number(resumo.faltam || 0) + idsPendentesLocais.size;
    resumoInicioRota.textContent = `Motorista: ${motoristaAtual}. ${totalParadas} ${totalParadas === 1 ? 'parada' : 'paradas'} na rota. O cronômetro só começa ao tocar em “Iniciar rota”.`;
    botaoIniciarRota.textContent = `▶  Iniciar rota · ${totalParadas}`;
  }
  mostrarTempoEmRota();
  return idsPendentesLocais;
}

function abrirFinalizacao(entrega) {
  formFinalizar.reset();
  document.getElementById('confirmar-finalizacao').textContent = 'Salvar registro';
  formFinalizar.elements.namedItem('id').value = entrega.id;
  document.getElementById('endereco-finalizar').textContent = `${entrega.cliente} — ${entrega.endereco}`;
  document.getElementById('nome-foto').textContent = 'Nenhuma foto selecionada';
  mensagemFinalizar.textContent = '';
  dialogFinalizar.showModal();
}

function criarCartao(entrega) {
  const cartao = document.createElement('article');
  cartao.className = 'cartao-rota';
  const topo = document.createElement('div');
  topo.className = 'topo-cartao-rota';
  const cliente = document.createElement('h3');
  cliente.textContent = entrega.cliente;
  const status = document.createElement('span');
  status.className = 'etiqueta-pendente';
  status.textContent = 'Pendente';
  topo.append(cliente, status);
  cartao.appendChild(topo);
  const endereco = document.createElement('p');
  endereco.className = 'endereco-rota';
  endereco.textContent = entrega.endereco;
  cartao.appendChild(endereco);
  const navegar = document.createElement('a');
  navegar.className = 'botao-navegar-rota';
  navegar.href = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(entrega.endereco)}`;
  navegar.target = '_blank';
  navegar.rel = 'noopener noreferrer';
  navegar.textContent = 'Abrir navegação';
  cartao.appendChild(navegar);
  const botaoRegistrar = document.createElement('button');
  botaoRegistrar.type = 'button';
  botaoRegistrar.className = 'botao-finalizar';
  botaoRegistrar.disabled = !rotaIniciadaAtual;
  botaoRegistrar.textContent = rotaIniciadaAtual ? 'Registrar parada' : 'Inicie a rota para começar';
  if (rotaIniciadaAtual) botaoRegistrar.addEventListener('click', () => abrirFinalizacao(entrega));
  cartao.appendChild(botaoRegistrar);
  return cartao;
}

async function desenharRota(entregas, resumo, horaDados, rotaSalva = dadosRotaAtual) {
  const fila = await listarFilaOffline();
  const idsLocais = atualizarResumo(resumo, horaDados, fila, rotaSalva);
  const pendentesVisiveis = entregas.filter((entrega) => !idsLocais.has(String(entrega.id)));
  listaRota.replaceChildren();
  if (!pendentesVisiveis.length) {
    mensagemRota.textContent = fila.some((parada) => parada.motorista === motoristaAtual)
      ? 'Paradas registradas neste celular. A central será atualizada assim que houver conexão.'
      : resumo.aguardando_envio > 0 ? 'A rota está sendo preparada pela central. Ela aparecerá aqui quando for enviada.'
        : resumo.feitas > 0 ? 'Rota concluída. Todas as paradas foram registradas.' : 'A central ainda não enviou sua rota.';
    listaRota.classList.add('estado-vazio-rota');
    listaRota.textContent = fila.some((parada) => parada.motorista === motoristaAtual)
      ? 'Seus registros estão guardados neste aparelho.'
      : resumo.aguardando_envio > 0 ? 'Aguarde a confirmação da central.'
        : resumo.feitas > 0 ? 'Bom trabalho! A central já recebeu seus registros.'
          : `Se esperava uma rota, peça à central para conferir se o nome “${motoristaAtual}” está no campo Entregador responsável e se ela foi enviada.`;
    return;
  }
  listaRota.classList.remove('estado-vazio-rota');
  mensagemRota.textContent = !rotaIniciadaAtual
    ? 'Confira suas paradas e toque em “Iniciar rota” quando estiver pronto. O GPS não é necessário.'
    : navigator.onLine
      ? 'Toque em “Registrar parada” ao chegar. O GPS não é necessário.'
      : 'Rota salva neste celular. Registre as paradas normalmente; a central sincroniza quando a internet voltar.';
  pendentesVisiveis.forEach((entrega) => listaRota.appendChild(criarCartao(entrega)));
}

async function obterRotaSalva() {
  try { return await buscarRotaOffline(motoristaAtual); }
  catch { return null; }
}

async function sincronizarInicioPendente(rotaConhecida = null) {
  const rota = rotaConhecida || await obterRotaSalva();
  if (!rota?.inicioPendente || !navigator.onLine) return false;
  const resposta = await fetch('/api/minhas-entregas/iniciar', { method: 'POST', cache: 'no-store' });
  const dados = await respostaJson(resposta);
  if (!resposta.ok) throw new Error(dados.erro || 'Não foi possível iniciar a rota.');
  rota.inicioPendente = false;
  delete rota.inicioLocalEm;
  rota.resumo = {
    ...rota.resumo,
    rota_iniciada: true,
    rota_ativa: true,
    tempo_em_rota_segundos: Number(dados.tempo_em_rota_segundos || 0),
  };
  rota.salvoEm = Date.now();
  dadosRotaAtual = rota;
  await salvarRotaOffline(rota);
  return true;
}

async function carregarRota() {
  if (carregandoRota || !motoristaAtual) return;
  carregandoRota = true;
  listaRota.setAttribute('aria-busy', 'true');
  try {
    const rotaSalva = await obterRotaSalva();
    if (rotaSalva?.inicioPendente && navigator.onLine) await sincronizarInicioPendente(rotaSalva);
    const resposta = await fetch('/api/minhas-entregas', { cache: 'no-store' });
    const dados = await respostaJson(resposta);
    if (!resposta.ok) throw new Error(dados.erro || 'Não foi possível carregar sua rota.');
    dadosRotaAtual = { motorista: motoristaAtual, ...dados, salvoEm: Date.now() };
    await salvarRotaOffline(dadosRotaAtual);
    await desenharRota(dados.entregas, dados.resumo, dadosRotaAtual.salvoEm);
    await sincronizarFila();
  } catch (erro) {
    const salva = dadosRotaAtual || await obterRotaSalva();
    if (salva) {
      dadosRotaAtual = salva;
      await desenharRota(salva.entregas, salva.resumo, salva.salvoEm);
      mensagemRota.textContent = 'Sem conexão com a central. Você pode registrar paradas; elas serão enviadas ao reconectar.';
    } else {
      mensagemRota.textContent = navigator.onLine ? erro.message : 'Ainda não há uma rota salva neste celular. Abra esta tela com internet uma vez para baixar a rota.';
      listaRota.classList.add('estado-vazio-rota');
      listaRota.textContent = 'Conecte-se à internet para carregar a rota pela primeira vez.';
    }
  } finally {
    carregandoRota = false;
    listaRota.setAttribute('aria-busy', 'false');
    await atualizarEstadoConexao();
  }
}

async function montarFormData(parada) {
  const dados = new FormData();
  dados.append('id', String(parada.id));
  dados.append('resultado_entrega', parada.resultado_entrega);
  dados.append('comentario', parada.comentario || '');
  if (parada.foto) dados.append('foto', parada.foto, parada.nomeFoto || 'foto-entrega.jpg');
  return dados;
}

async function sincronizarFila() {
  if (sincronizandoFila || !navigator.onLine || !motoristaAtual) return;
  sincronizandoFila = true;
  try {
    await sincronizarInicioPendente();
    const fila = (await listarFilaOffline()).filter((parada) => parada.motorista === motoristaAtual);
    if (fila.length) definirEstadoConexao(`Conexão disponível. Enviando ${fila.length} registro${fila.length === 1 ? '' : 's'}…`, 'sync');
    let houveEnvio = false;
    for (const parada of fila) {
      try {
        const resposta = await fetch(`/api/entregas/${encodeURIComponent(parada.id)}/finalizar`, {
          method: 'PATCH', body: await montarFormData(parada), cache: 'no-store',
        });
        const dados = await respostaJson(resposta);
        if (!resposta.ok) {
          parada.erroSync = resposta.status === 401
            ? 'Entre novamente para sincronizar.'
            : dados.erro || `Falha HTTP ${resposta.status}`;
          await salvarNaFilaOffline(parada);
          if (resposta.status === 401) break;
          continue;
        }
        await removerDaFilaOffline(parada.id);
        houveEnvio = true;
      } catch {
        break;
      }
    }
    if (houveEnvio) {
      const resposta = await fetch('/api/minhas-entregas', { cache: 'no-store' });
      const dados = await respostaJson(resposta);
      if (resposta.ok) {
        dadosRotaAtual = { motorista: motoristaAtual, ...dados, salvoEm: Date.now() };
        await salvarRotaOffline(dadosRotaAtual);
        await desenharRota(dados.entregas, dados.resumo, dadosRotaAtual.salvoEm);
      }
    }
  } finally {
    sincronizandoFila = false;
    await atualizarEstadoConexao();
  }
}

async function registrarParadaLocal(evento) {
  evento.preventDefault();
  if (!formFinalizar.reportValidity()) return;
  if (!rotaIniciadaAtual) {
    mensagemFinalizar.textContent = 'Toque em “Iniciar rota” antes de registrar as paradas.';
    return;
  }
  const entregaId = String(formFinalizar.elements.namedItem('id').value);
  const foto = formFinalizar.elements.namedItem('foto').files[0];
  const resultadoEntrega = formFinalizar.elements.namedItem('resultado_entrega').value;
  const comentario = formFinalizar.elements.namedItem('comentario').value.trim();
  const botao = document.getElementById('confirmar-finalizacao');
  botao.disabled = true;
  botao.textContent = 'Salvando…';
  mensagemFinalizar.textContent = 'Salvando o registro neste celular…';
  try {
    const parada = {
      id: entregaId,
      motorista: motoristaAtual,
      cliente: document.getElementById('endereco-finalizar').textContent,
      ...(foto ? { foto, nomeFoto: foto.name } : {}),
      resultado_entrega: resultadoEntrega,
      comentario,
      registradoEm: Date.now(),
    };
    await salvarNaFilaOffline(parada);
    dialogFinalizar.close();
    if (dadosRotaAtual) await desenharRota(dadosRotaAtual.entregas, dadosRotaAtual.resumo, dadosRotaAtual.salvoEm);
    await atualizarEstadoConexao();
    if (navigator.onLine) {
      await sincronizarFila();
      const filaAtual = (await listarFilaOffline()).filter((paradaPendente) => paradaPendente.motorista === motoristaAtual);
      mensagemRota.textContent = filaAtual.length
        ? 'Registro salvo neste celular; a central ainda não confirmou o recebimento.'
        : `${resultadoEntrega === 'devolvida' ? 'Devolução' : 'Entrega'} registrada e enviada à central${foto ? '.' : ' (sem foto).'}`;
    } else {
      mensagemRota.textContent = `Registro salvo neste celular${foto ? '' : ' sem foto'}; será enviado quando a internet voltar.`;
    }
    if ('serviceWorker' in navigator) {
      const registro = await navigator.serviceWorker.ready.catch(() => null);
      if (registro?.sync) await registro.sync.register('sincronizar-paradas').catch(() => {});
    }
  } catch (erro) {
    mensagemFinalizar.textContent = erro.name === 'QuotaExceededError'
      ? 'O armazenamento do celular está cheio. Libere espaço e tente novamente.'
      : `Não foi possível salvar neste celular: ${erro.message}`;
  } finally {
    botao.disabled = false;
    const selecionado = formFinalizar.querySelector('input[name="resultado_entrega"]:checked');
    botao.textContent = selecionado?.value === 'devolvida' ? 'Confirmar devolução' : 'Salvar registro';
  }
}

async function iniciarRotaAgora() {
  if (!dadosRotaAtual || !dadosRotaAtual.resumo?.rota_enviada) {
    definirEstadoConexao('A central ainda não enviou entregas pendentes para esta rota.', 'offline');
    return;
  }
  const rota = {
    ...dadosRotaAtual,
    inicioPendente: true,
    inicioLocalEm: Date.now(),
    resumo: { ...dadosRotaAtual.resumo, rota_iniciada: true, rota_ativa: true },
  };
  dadosRotaAtual = rota;
  await salvarRotaOffline(rota);
  await desenharRota(rota.entregas, rota.resumo, rota.salvoEm, rota);
  if (navigator.onLine) {
    try {
      await sincronizarInicioPendente(rota);
      await carregarRota();
    } catch (erro) {
      if (!navigator.onLine || erro instanceof TypeError) {
        definirEstadoConexao('Rota iniciada neste celular. O início será enviado quando a internet voltar.', 'offline');
        if ('serviceWorker' in navigator) {
          const registro = await navigator.serviceWorker.ready.catch(() => null);
          if (registro?.sync) await registro.sync.register('sincronizar-paradas').catch(() => {});
        }
        return;
      }
      rota.inicioPendente = false;
      delete rota.inicioLocalEm;
      rota.resumo = { ...rota.resumo, rota_iniciada: false, rota_ativa: false, tempo_em_rota_segundos: null };
      dadosRotaAtual = rota;
      await salvarRotaOffline(rota);
      await desenharRota(rota.entregas, rota.resumo, rota.salvoEm, rota);
      definirEstadoConexao(erro.message, 'offline');
    }
  } else {
    definirEstadoConexao('Rota iniciada neste celular. O início será enviado quando a internet voltar.', 'offline');
    if ('serviceWorker' in navigator) {
      const registro = await navigator.serviceWorker.ready.catch(() => null);
      if (registro?.sync) await registro.sync.register('sincronizar-paradas').catch(() => {});
    }
  }
}

async function iniciarAreaMotorista() {
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('/motorista-sw.js');
      await navigator.serviceWorker.ready;
    } catch {
      // O modo offline em abas já abertas continua funcionando; cache para reabrir requer HTTPS ou localhost.
    }
  }
  try {
    const resposta = await fetch('/api/auth/session', { cache: 'no-store' });
    const dados = await respostaJson(resposta);
    if (!resposta.ok) {
      const erro = new Error(dados.erro || 'Sessão indisponível.');
      erro.status = resposta.status;
      throw erro;
    }
    if (!dados.usuario) return window.location.replace('/login.html');
    if (dados.usuario.papel !== 'motorista') {
      document.getElementById('conteudo-rota-motorista').hidden = true;
      document.getElementById('aviso-acesso-motorista').hidden = false;
      const papel = dados.usuario.papel === 'master' ? 'administrador' : 'roteirizador';
      document.getElementById('detalhe-acesso-motorista').textContent = `Você está conectado como ${dados.usuario.nome} (${papel}). Saia e entre com o usuário de motorista criado no Painel admin.`;
      return;
    }
    motoristaAtual = dados.usuario.nome;
    localStorage.setItem(nomeMotoristaLocal, motoristaAtual);
  } catch (erro) {
    const falhaDeRede = !navigator.onLine || erro instanceof TypeError;
    if (!falhaDeRede) {
      document.getElementById('aviso-acesso-motorista').hidden = false;
      document.getElementById('conteudo-rota-motorista').hidden = true;
      document.getElementById('titulo-acesso-motorista').textContent = 'Não foi possível confirmar seu acesso';
      document.getElementById('detalhe-acesso-motorista').textContent = erro.message;
      return;
    }
    motoristaAtual = localStorage.getItem(nomeMotoristaLocal);
    if (!motoristaAtual) {
      document.getElementById('aviso-acesso-motorista').hidden = false;
      document.getElementById('conteudo-rota-motorista').hidden = true;
      document.getElementById('detalhe-acesso-motorista').textContent = 'Entre com internet ao menos uma vez neste aparelho para salvar sua rota e habilitar o modo offline.';
      return;
    }
  }
  document.getElementById('aviso-acesso-motorista').hidden = true;
  document.getElementById('conteudo-rota-motorista').hidden = false;
  document.getElementById('nome-motorista').textContent = motoristaAtual;
  const salva = await obterRotaSalva();
  if (salva) {
    dadosRotaAtual = salva;
    await desenharRota(salva.entregas, salva.resumo, salva.salvoEm);
  }
  await atualizarEstadoConexao();
  await carregarRota();
  window.setInterval(carregarRota, 30000);
  window.setInterval(mostrarTempoEmRota, 1000);
}

async function encerrarSessaoMotorista() {
  if (!navigator.onLine) {
    definirEstadoConexao('Sem internet: permaneça nesta tela para continuar a rota e sincronizar seus registros depois.', 'offline');
    return;
  }
  const filaAtual = (await listarFilaOffline()).filter((parada) => parada.motorista === motoristaAtual);
  if (filaAtual.length) {
    await sincronizarFila();
    const aindaPendentes = (await listarFilaOffline()).some((parada) => parada.motorista === motoristaAtual);
    if (aindaPendentes) {
      definirEstadoConexao('Ainda há registros guardados neste celular. Mantenha a sessão aberta até a central confirmar o envio.', 'sync');
      return;
    }
  }
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
  localStorage.removeItem(nomeMotoristaLocal);
  window.location.replace('/login.html');
}

document.getElementById('sair-motorista').addEventListener('click', encerrarSessaoMotorista);
botaoTentarSincronizar.addEventListener('click', async () => {
  botaoTentarSincronizar.disabled = true;
  botaoTentarSincronizar.textContent = 'Tentando…';
  try {
    await sincronizarFila();
    await carregarRota();
  } finally {
    botaoTentarSincronizar.disabled = false;
    botaoTentarSincronizar.textContent = 'Tentar enviar agora';
    await atualizarEstadoConexao();
  }
});
document.getElementById('trocar-conta-motorista').addEventListener('click', encerrarSessaoMotorista);
document.getElementById('foto-entrega').addEventListener('change', (evento) => {
  const arquivo = evento.target.files[0];
  document.getElementById('nome-foto').textContent = arquivo
    ? `${arquivo.name} (${(arquivo.size / 1024 / 1024).toFixed(1)} MB)`
    : 'Nenhuma foto selecionada';
});
document.querySelectorAll('input[name="resultado_entrega"]').forEach((opcao) => {
  opcao.addEventListener('change', () => {
    document.getElementById('confirmar-finalizacao').textContent = opcao.value === 'devolvida' ? 'Confirmar devolução' : 'Confirmar entrega';
  });
});
formFinalizar.addEventListener('submit', registrarParadaLocal);
botaoIniciarRota.addEventListener('click', iniciarRotaAgora);
document.getElementById('cancelar-finalizacao').addEventListener('click', () => dialogFinalizar.close());
document.getElementById('fechar-dialogo').addEventListener('click', () => dialogFinalizar.close());
window.addEventListener('offline', atualizarEstadoConexao);
window.addEventListener('online', async () => { await carregarRota(); await sincronizarFila(); });
if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', (evento) => {
  if (evento.data?.tipo === 'FILA_SINCRONIZADA') { carregarRota(); }
});
iniciarAreaMotorista();
