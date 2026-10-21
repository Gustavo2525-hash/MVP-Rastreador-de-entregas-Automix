const mapa = L.map('mapa').setView([-23.5505, -46.6333], 12);
const camadaMarcadores = L.layerGroup().addTo(mapa);
let mapaEnquadradoInicialmente = false;

const mapaRota = L.map('mapa-roteirizacao').setView([-23.5505, -46.6333], 12);
const camadaParadasRota = L.layerGroup().addTo(mapaRota);
const camadaDesenhoRota = L.layerGroup().addTo(mapaRota);
let mapaRotaEnquadrado = false;
let desenhoRegiaoAtivo = false;
let verticesRegiao = [];
let poligonoRegiao = null;

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap contributors',
}).addTo(mapa);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap contributors',
}).addTo(mapaRota);

const lista = document.getElementById('lista-entregas');
const mensagem = document.getElementById('mensagem');
const form = document.getElementById('form-entrega');
const mensagemCadastro = document.getElementById('mensagem-cadastro');
const botaoAtualizar = document.getElementById('atualizar');
const totalPendentes = document.getElementById('total-pendentes');
const totalEntregues = document.getElementById('total-entregues');
const totalDevolvidas = document.getElementById('total-devolvidas');
const dialogEdicao = document.getElementById('dialog-edicao');
const formEdicao = document.getElementById('form-edicao');
const mensagemEdicao = document.getElementById('mensagem-edicao');
const campoBusca = document.getElementById('busca-entregas');
const resumoLista = document.getElementById('resumo-lista');
const seletorMotoristaRota = document.getElementById('motorista-rota');
const botaoEnviarRota = document.getElementById('enviar-rota');
const resumoEnvioRota = document.getElementById('resumo-envio-rota');
const avisoEntregasNaoEnviadas = document.getElementById('aviso-entregas-nao-enviadas');
const historicoDe = document.getElementById('historico-de');
const historicoAte = document.getElementById('historico-ate');
const seletorPeriodo = document.getElementById('atalho-periodo');
const datasPersonalizadas = document.getElementById('datas-personalizadas');
const listaParadasRota = document.getElementById('lista-paradas-rota');
const resumoParadasRota = document.getElementById('resumo-paradas-rota');
const estadoDesenhoRegiao = document.getElementById('estado-desenho-regiao');
const botaoIniciarDesenho = document.getElementById('iniciar-desenho-regiao');
const botaoFecharDesenho = document.getElementById('fechar-desenho-regiao');
const botaoLimparDesenho = document.getElementById('limpar-desenho-regiao');
let filtroAtual = 'todas';
let entregasAtuais = [];
let motoristasDisponiveis = [];
const entregasSelecionadas = new Set();

function entregaDisponivel(entrega) {
  return entrega.status === 'pendente' && !entrega.rota_enviada
    && Number.isFinite(Number(entrega.latitude)) && Number.isFinite(Number(entrega.longitude));
}

function pontoDentroDaRegiao(ponto, vertices) {
  const x = ponto.lng;
  const y = ponto.lat;
  let dentro = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i, i += 1) {
    const xi = vertices[i].lng; const yi = vertices[i].lat;
    const xj = vertices[j].lng; const yj = vertices[j].lat;
    const cruza = ((yi > y) !== (yj > y))
      && (x < ((xj - xi) * (y - yi)) / ((yj - yi) || Number.EPSILON) + xi);
    if (cruza) dentro = !dentro;
  }
  return dentro;
}

function atualizarMapaRota() {
  if (!mapaRota) return;
  camadaParadasRota.clearLayers();
  const paradas = entregasAtuais.filter(entregaDisponivel);
  const pontos = [];
  for (const entrega of paradas) {
    const latLng = [Number(entrega.latitude), Number(entrega.longitude)];
    const selecionada = entregasSelecionadas.has(String(entrega.id));
    const marcador = L.circleMarker(latLng, {
      radius: selecionada ? 10 : 8,
      color: '#fff',
      weight: 3,
      fillColor: selecionada ? '#087e69' : '#d94f45',
      fillOpacity: 1,
      bubblingMouseEvents: false,
    }).addTo(camadaParadasRota);
    marcador.bindTooltip(`${entrega.cliente} · ${selecionada ? 'selecionada' : 'pendente'}`);
    marcador.on('click', (evento) => {
      L.DomEvent.stopPropagation(evento.originalEvent);
      if (desenhoRegiaoAtivo) {
        adicionarVerticeRegiao(evento.latlng);
        return;
      }
      const id = String(entrega.id);
      if (entregasSelecionadas.has(id)) entregasSelecionadas.delete(id);
      else entregasSelecionadas.add(id);
      renderizarParadasRota(entregasAtuais);
      atualizarPainelEnvioRota(entregasAtuais);
      atualizarMapaRota();
    });
    pontos.push(latLng);
  }
  if (pontos.length && !mapaRotaEnquadrado) {
    mapaRota.fitBounds(pontos, { padding: [35, 35], maxZoom: 14 });
    mapaRotaEnquadrado = true;
  }
}

function definirEstadoDesenho(texto, tipo = '') {
  estadoDesenhoRegiao.textContent = texto;
  estadoDesenhoRegiao.dataset.tipo = tipo;
}

function limparDesenhoRegiao(limparSelecao = true) {
  desenhoRegiaoAtivo = false;
  verticesRegiao = [];
  poligonoRegiao = null;
  camadaDesenhoRota.clearLayers();
  mapaRota.dragging.enable();
  mapaRota.getContainer().classList.remove('modo-desenho');
  botaoFecharDesenho.disabled = true;
  botaoLimparDesenho.disabled = true;
  botaoIniciarDesenho.disabled = false;
  if (limparSelecao) entregasSelecionadas.clear();
  definirEstadoDesenho('Você também pode selecionar paradas individualmente na lista abaixo.');
  renderizarParadasRota(entregasAtuais);
  atualizarPainelEnvioRota(entregasAtuais);
  atualizarMapaRota();
}

function iniciarDesenhoRegiao() {
  limparDesenhoRegiao(true);
  desenhoRegiaoAtivo = true;
  mapaRota.dragging.disable();
  mapaRota.getContainer().classList.add('modo-desenho');
  botaoIniciarDesenho.disabled = true;
  botaoLimparDesenho.disabled = false;
  definirEstadoDesenho('Desenho ativo: clique no mapa para marcar pelo menos 3 cantos da região.', 'andamento');
}

function fecharDesenhoRegiao() {
  if (!desenhoRegiaoAtivo || verticesRegiao.length < 3) return;
  desenhoRegiaoAtivo = false;
  mapaRota.dragging.enable();
  mapaRota.getContainer().classList.remove('modo-desenho');
  camadaDesenhoRota.clearLayers();
  poligonoRegiao = L.polygon(verticesRegiao, {
    color: '#087e69', weight: 3, fillColor: '#26a887', fillOpacity: 0.18,
  }).addTo(camadaDesenhoRota);
  const dentro = entregasAtuais.filter((entrega) => entregaDisponivel(entrega)
    && pontoDentroDaRegiao(L.latLng(Number(entrega.latitude), Number(entrega.longitude)), verticesRegiao));
  entregasSelecionadas.clear();
  dentro.forEach((entrega) => entregasSelecionadas.add(String(entrega.id)));
  botaoFecharDesenho.disabled = true;
  botaoIniciarDesenho.disabled = false;
  botaoLimparDesenho.disabled = false;
  definirEstadoDesenho(`${dentro.length} ${dentro.length === 1 ? 'entrega selecionada' : 'entregas selecionadas'} dentro da região. Você pode ajustar a lista abaixo.`, 'sucesso');
  renderizarParadasRota(entregasAtuais);
  atualizarPainelEnvioRota(entregasAtuais);
  atualizarMapaRota();
}

function adicionarVerticeRegiao(latlng) {
  if (!desenhoRegiaoAtivo) return;
  verticesRegiao.push(latlng);
  camadaDesenhoRota.clearLayers();
  if (verticesRegiao.length > 1) {
    L.polyline(verticesRegiao, { color: '#087e69', weight: 3, dashArray: '7 6' }).addTo(camadaDesenhoRota);
  }
  verticesRegiao.forEach((ponto) => L.circleMarker(ponto, {
    radius: 5, color: '#fff', weight: 2, fillColor: '#087e69', fillOpacity: 1,
  }).addTo(camadaDesenhoRota));
  botaoFecharDesenho.disabled = verticesRegiao.length < 3;
  definirEstadoDesenho(`${verticesRegiao.length} ${verticesRegiao.length === 1 ? 'ponto marcado' : 'pontos marcados'}. ${verticesRegiao.length < 3 ? 'Marque pelo menos mais pontos.' : 'Feche a área quando terminar.'}`, 'andamento');
}

mapaRota.on('click', (evento) => adicionarVerticeRegiao(evento.latlng));

botaoIniciarDesenho.addEventListener('click', iniciarDesenhoRegiao);
botaoFecharDesenho.addEventListener('click', fecharDesenhoRegiao);
botaoLimparDesenho.addEventListener('click', () => limparDesenhoRegiao(true));

function atualizarOpcoesMotorista(entregas) {
  const selecionado = seletorMotoristaRota.value;
  const motoristas = [...new Set(motoristasDisponiveis.filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'pt-BR'));
  seletorMotoristaRota.replaceChildren(new Option('Escolha um motorista para enviar', ''));
  for (const motorista of motoristas) seletorMotoristaRota.add(new Option(motorista, motorista));
  if (motoristas.includes(selecionado)) seletorMotoristaRota.value = selecionado;
}

function atualizarPainelEnvioRota(entregas) {
  const preparadas = entregas.filter((entrega) => entrega.status === 'pendente' && !entrega.rota_enviada);
  const preparadasTotal = preparadas.length;
  const selecionadas = preparadas.filter((entrega) => entregasSelecionadas.has(String(entrega.id)));
  avisoEntregasNaoEnviadas.hidden = preparadasTotal === 0;
  avisoEntregasNaoEnviadas.textContent = preparadasTotal
    ? `${preparadasTotal} ${preparadasTotal === 1 ? 'entrega pendente ainda aguarda' : 'entregas pendentes ainda aguardam'} envio para o motorista.`
    : '';
  const motorista = seletorMotoristaRota.value;
  botaoEnviarRota.disabled = !motorista || selecionadas.length === 0;
  botaoEnviarRota.textContent = selecionadas.length
    ? `Enviar ${selecionadas.length} ${selecionadas.length === 1 ? 'entrega' : 'entregas'} selecionada${selecionadas.length === 1 ? '' : 's'}`
    : 'Enviar entregas selecionadas';
  if (!selecionadas.length) {
    resumoEnvioRota.textContent = motorista
      ? `Marque as entregas que deseja enviar para ${motorista}.`
      : 'Marque as entregas acima. Depois escolha o motorista da rota.';
    return;
  }
  if (!motorista) {
    resumoEnvioRota.textContent = `${selecionadas.length} ${selecionadas.length === 1 ? 'entrega selecionada' : 'entregas selecionadas'}. Agora escolha o motorista.`;
    return;
  }
  resumoEnvioRota.textContent = selecionadas.length
    ? `${selecionadas.length} ${selecionadas.length === 1 ? 'parada será atribuída' : 'paradas serão atribuídas'} a ${motorista}.`
    : `Marque as entregas que deseja enviar para ${motorista}.`;
}

function renderizarParadasRota(entregas) {
  const paradas = entregas.filter((entrega) => entrega.status === 'pendente' && !entrega.rota_enviada);
  const idsDisponiveis = new Set(paradas.map((entrega) => String(entrega.id)));
  for (const id of entregasSelecionadas) if (!idsDisponiveis.has(id)) entregasSelecionadas.delete(id);
  resumoParadasRota.textContent = `${entregasSelecionadas.size} selecionada${entregasSelecionadas.size === 1 ? '' : 's'}`;
  document.getElementById('badge-roteirizacao').textContent = entregas.filter((entrega) => entrega.status === 'pendente' && !entrega.rota_enviada).length;
  document.getElementById('badge-relatorios').textContent = entregas.length;
  listaParadasRota.replaceChildren();
  if (!paradas.length) {
    const vazio = document.createElement('p');
    vazio.className = 'lista-vazia-rota';
    vazio.textContent = 'Nenhuma entrega aguardando montagem de rota. Cadastre uma nova parada para começar.';
    listaParadasRota.appendChild(vazio);
    return;
  }
  for (const entrega of paradas) {
    const card = document.createElement('article');
    card.className = 'parada-rota';
    const seletor = document.createElement('input');
    seletor.type = 'checkbox';
    seletor.className = 'seletor-parada-rota';
    seletor.checked = entregasSelecionadas.has(String(entrega.id));
    seletor.setAttribute('aria-label', `Selecionar entrega de ${entrega.cliente}`);
    seletor.addEventListener('change', () => {
      if (seletor.checked) entregasSelecionadas.add(String(entrega.id));
      else entregasSelecionadas.delete(String(entrega.id));
      resumoParadasRota.textContent = `${entregasSelecionadas.size} selecionada${entregasSelecionadas.size === 1 ? '' : 's'}`;
      atualizarPainelEnvioRota(entregasAtuais);
      atualizarMapaRota();
    });
    const marcador = document.createElement('span');
    marcador.className = 'numero-parada';
    marcador.textContent = String(paradas.indexOf(entrega) + 1).padStart(2, '0');
    const conteudo = document.createElement('div');
    conteudo.className = 'parada-conteudo';
    const cliente = document.createElement('strong');
    cliente.textContent = entrega.cliente;
    const endereco = document.createElement('p');
    endereco.textContent = entrega.endereco;
    const meta = document.createElement('small');
    meta.textContent = entrega.motorista ? `Motorista: ${entrega.motorista}` : 'Sem motorista · pronta para atribuir';
    conteudo.append(cliente, endereco, meta);
    const acoes = document.createElement('div');
    acoes.className = 'acoes-parada-rota';
    if (!entrega.rota_enviada) {
      const editar = document.createElement('button');
      editar.type = 'button'; editar.className = 'botao-secundario'; editar.textContent = 'Editar';
      editar.addEventListener('click', () => abrirEdicao(entrega));
      acoes.appendChild(editar);
      const excluir = document.createElement('button');
      excluir.type = 'button'; excluir.className = 'botao-excluir'; excluir.textContent = 'Remover';
      excluir.addEventListener('click', () => excluirEntrega(entrega));
      acoes.appendChild(excluir);
    }
    card.append(seletor, marcador, conteudo, acoes);
    listaParadasRota.appendChild(card);
  }
}

function configurarNavegacaoPainel() {
  const botoes = [...document.querySelectorAll('[data-painel]')];
  const paineis = {
    roteirizacao: document.getElementById('painel-roteirizacao'),
    relatorios: document.getElementById('painel-relatorios'),
  };
  function selecionarPainel(nome, focar = false) {
    for (const botao of botoes) {
      const ativo = botao.dataset.painel === nome;
      botao.classList.toggle('ativo', ativo);
      botao.setAttribute('aria-current', ativo ? 'page' : 'false');
      if (focar && ativo) botao.focus();
    }
    for (const [chave, painel] of Object.entries(paineis)) painel.hidden = chave !== nome;
    try { localStorage.setItem('automix-painel-central', nome); } catch { /* Armazenamento local opcional. */ }
    requestAnimationFrame(() => {
      if (nome === 'relatorios') mapa.invalidateSize();
      if (nome === 'roteirizacao') mapaRota.invalidateSize();
    });
  }
  botoes.forEach((botao, indice) => {
    botao.addEventListener('click', () => selecionarPainel(botao.dataset.painel));
    botao.addEventListener('keydown', (evento) => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(evento.key)) return;
      evento.preventDefault();
      const proximo = evento.key === 'Home' ? 0 : evento.key === 'End' ? botoes.length - 1
        : (indice + (evento.key === 'ArrowDown' ? 1 : botoes.length - 1)) % botoes.length;
      selecionarPainel(botoes[proximo].dataset.painel, true);
    });
  });
  let inicial = 'roteirizacao';
  try {
    const salvo = localStorage.getItem('automix-painel-central');
    if (salvo && paineis[salvo]) inicial = salvo;
  } catch { /* A tela abre normalmente sem armazenamento local. */ }
  selecionarPainel(inicial);
}

function normalizarBusca(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
    .trim();
}

function dataLocalDaEntrega(entrega) {
  const momento = entrega.entregue_em || entrega.criado_em;
  if (!momento) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(momento));
}

function hojeLocal() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function aplicarAtalhoPeriodo(periodo) {
  datasPersonalizadas.hidden = periodo !== 'personalizado';
  historicoDe.value = '';
  historicoAte.value = '';
  if (periodo === 'todos' || periodo === 'personalizado') return;

  const hoje = hojeLocal();
  historicoAte.value = hoje;
  if (periodo === 'hoje') {
    historicoDe.value = hoje;
    return;
  }
  const dias = periodo === '7dias' ? 6 : 29;
  const [ano, mes, dia] = hoje.split('-').map(Number);
  const inicio = new Date(Date.UTC(ano, mes - 1, dia - dias, 12));
  historicoDe.value = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(inicio);
}

function criarEstadoVazio(titulo, descricao, comAcao = false) {
  const estado = document.createElement('div');
  estado.className = 'estado-vazio-lista';
  const icone = document.createElement('span');
  icone.className = 'icone-vazio';
  icone.setAttribute('aria-hidden', 'true');
  icone.textContent = comAcao ? '+' : '⌕';
  const texto = document.createElement('span');
  texto.className = 'texto-vazio';
  const chamada = document.createElement('strong');
  chamada.textContent = titulo;
  const detalhe = document.createElement('small');
  detalhe.textContent = descricao;
  texto.append(chamada, detalhe);
  estado.append(icone, texto);
  if (comAcao) {
    const acao = document.createElement('button');
    acao.type = 'button';
    acao.className = 'acao-estado-vazio';
    acao.textContent = 'Cadastrar entrega';
    acao.addEventListener('click', () => document.querySelector('[data-painel="roteirizacao"]').click());
    estado.appendChild(acao);
  }
  return estado;
}

function formatarDataHora(valor) {
  if (!valor) return 'Horário não registrado';
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo',
  }).format(new Date(valor));
}

function criarPopup(entrega) {
  const popup = document.createElement('div');
  popup.className = 'popup-entrega';

  const cliente = document.createElement('strong');
  cliente.textContent = entrega.cliente;
  popup.appendChild(cliente);

  const endereco = document.createElement('p');
  endereco.textContent = entrega.endereco;
  popup.appendChild(endereco);

  const status = document.createElement('p');
  const devolvida = entrega.resultado_entrega === 'devolvida';
  status.textContent = `Status: ${devolvida ? 'Devolvida' : entrega.status === 'entregue' ? 'Entregue' : 'Pendente'}`;
  popup.appendChild(status);

  if (entrega.status === 'pendente' && !entrega.rota_enviada) {
    const dicaMapa = document.createElement('p');
    dicaMapa.className = 'dica-marcador-arrastavel';
    dicaMapa.textContent = 'Arraste o marcador vermelho para ajustar o local. A posição é salva automaticamente.';
    popup.appendChild(dicaMapa);
  }

  if (entrega.resultado_entrega) {
    const resultado = document.createElement('p');
    resultado.textContent = `Resultado: ${entrega.resultado_entrega === 'devolvida' ? 'Devolvida' : entrega.resultado_entrega === 'entregue' ? 'Entrega realizada' : entrega.resultado_entrega}`;
    popup.appendChild(resultado);
  }

  if (entrega.comentario) {
    const comentario = document.createElement('p');
    comentario.textContent = `Comentário: ${entrega.comentario}`;
    popup.appendChild(comentario);
  }

  if (entrega.foto_url) {
    const foto = document.createElement('img');
    foto.src = entrega.foto_url;
    foto.alt = `Foto da entrega de ${entrega.cliente}`;
    popup.appendChild(foto);
  }

  return popup;
}

function criarCartao(entrega, marcador) {
  const cartao = document.createElement('article');
  cartao.className = 'item-entrega';

  const cliente = document.createElement('h3');
  cliente.textContent = entrega.cliente;
  cartao.appendChild(cliente);

  const endereco = document.createElement('p');
  endereco.textContent = entrega.endereco;
  cartao.appendChild(endereco);

  const motorista = document.createElement('p');
  motorista.textContent = entrega.motorista ? `Entregador: ${entrega.motorista}` : 'Motorista: ainda não atribuído';
  cartao.appendChild(motorista);

  if (entrega.rota_id) {
    const identificadorRota = document.createElement('span');
    identificadorRota.className = 'identificador-rota';
    identificadorRota.textContent = `Rota ${String(entrega.rota_id).slice(0, 8).toUpperCase()}`;
    cartao.appendChild(identificadorRota);
  }

  const status = document.createElement('span');
  const devolvida = entrega.resultado_entrega === 'devolvida';
  status.className = `status-entrega ${devolvida ? 'devolvida' : entrega.status}`;
  status.textContent = devolvida ? 'Devolvida' : entrega.status === 'entregue' ? 'Entregue' : 'Pendente';
  cartao.appendChild(status);
  if (entrega.status === 'pendente') {
    const estadoRota = document.createElement('span');
    estadoRota.className = `status-rota ${entrega.rota_enviada ? 'rota-enviada' : 'rota-preparacao'}`;
    estadoRota.textContent = entrega.rota_enviada ? 'Na rota do motorista' : 'Aguardando envio';
    cartao.appendChild(estadoRota);
  }

  const botaoMapa = document.createElement('button');
  botaoMapa.type = 'button';
  botaoMapa.className = 'botao-ver-mapa';
  botaoMapa.textContent = 'Ver no mapa';
  botaoMapa.addEventListener('click', () => {
    mapa.flyTo(marcador.getLatLng(), 15);
    marcador.openPopup();
  });
  cartao.appendChild(botaoMapa);

  const navegar = document.createElement('a');
  navegar.className = 'botao-navegar-entrega';
  navegar.href = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(entrega.endereco)}`;
  navegar.target = '_blank';
  navegar.rel = 'noopener noreferrer';
  navegar.textContent = 'Abrir navegação';
  cartao.appendChild(navegar);

  if (entrega.status === 'entregue') {
    const historico = document.createElement('details');
    historico.className = 'historico-entrega';
    const resumo = document.createElement('summary');
    resumo.textContent = 'Ver registro da parada';
    historico.appendChild(resumo);
    const data = document.createElement('p');
    data.textContent = `Registrada em ${formatarDataHora(entrega.entregue_em)}`;
    historico.appendChild(data);
    if (entrega.comentario) {
      const comentario = document.createElement('p');
      comentario.textContent = `Comentário: ${entrega.comentario}`;
      historico.appendChild(comentario);
    }
    if (entrega.foto_url) {
      const foto = document.createElement('a');
      foto.href = entrega.foto_url;
      foto.target = '_blank';
      foto.rel = 'noopener noreferrer';
      foto.textContent = 'Abrir foto do comprovante';
      historico.appendChild(foto);
    } else {
      const semFoto = document.createElement('p');
      semFoto.textContent = 'Sem foto anexada.';
      historico.appendChild(semFoto);
    }
    cartao.appendChild(historico);
  }

  const botoesGestao = document.createElement('div');
  botoesGestao.className = 'acoes-entrega';

  if (entrega.status === 'pendente') {
    const botaoEditar = document.createElement('button');
    botaoEditar.type = 'button';
    botaoEditar.className = 'botao-secundario';
    botaoEditar.textContent = 'Editar';
    botaoEditar.addEventListener('click', () => abrirEdicao(entrega));
    botoesGestao.appendChild(botaoEditar);
  }

  const botaoExcluir = document.createElement('button');
  botaoExcluir.type = 'button';
  botaoExcluir.className = 'botao-excluir';
  botaoExcluir.textContent = 'Excluir';
  botaoExcluir.addEventListener('click', () => excluirEntrega(entrega));
  botoesGestao.appendChild(botaoExcluir);

  cartao.appendChild(botoesGestao);

  return cartao;
}

function abrirEdicao(entrega) {
  formEdicao.elements.namedItem('id').value = entrega.id;
  formEdicao.elements.namedItem('cliente').value = entrega.cliente;
  formEdicao.elements.namedItem('endereco').value = entrega.endereco;
  formEdicao.elements.namedItem('motorista').value = entrega.motorista || '';
  mensagemEdicao.textContent = '';
  dialogEdicao.showModal();
}

async function excluirEntrega(entrega) {
  const confirmou = window.confirm(
    `Excluir a entrega de ${entrega.cliente} em ${entrega.endereco}? Essa ação não pode ser desfeita.`
  );
  if (!confirmou) return;

  try {
    const resposta = await fetch(`/api/entregas/${encodeURIComponent(entrega.id)}`, {
      method: 'DELETE',
    });
    const resultado = await resposta.json();
    if (!resposta.ok) throw new Error(resultado.erro || 'Não foi possível excluir a entrega.');

    mensagem.textContent = 'Entrega excluída.';
    await carregarEntregas();
  } catch (erro) {
    mensagem.textContent = erro.message;
  }
}

function mostrarEntregas(entregas) {
  atualizarOpcoesMotorista(entregas);
  renderizarParadasRota(entregas);
  atualizarPainelEnvioRota(entregas);
  atualizarMapaRota();
  lista.replaceChildren();
  camadaMarcadores.clearLayers();

  const pendentes = entregas.filter((item) => item.status === 'pendente');
  const devolvidas = entregas.filter((item) => item.resultado_entrega === 'devolvida');
  const concluidas = entregas.filter((item) => item.status === 'entregue' && item.resultado_entrega !== 'devolvida');

  totalPendentes.textContent = pendentes.length;
  totalEntregues.textContent = concluidas.length;
  totalDevolvidas.textContent = devolvidas.length;
  document.getElementById('contagem-filtro-todas').textContent = entregas.length;
  document.getElementById('contagem-filtro-pendente').textContent = pendentes.length;
  document.getElementById('contagem-filtro-entregue').textContent = concluidas.length;
  document.getElementById('contagem-filtro-devolvida').textContent = devolvidas.length;

  const termo = normalizarBusca(campoBusca.value);
  const visiveis = entregas.filter((entrega) => {
    const correspondeAoStatus = filtroAtual === 'todas'
      || (filtroAtual === 'devolvida' && entrega.resultado_entrega === 'devolvida')
      || (filtroAtual === 'entregue' && entrega.status === 'entregue' && entrega.resultado_entrega !== 'devolvida')
      || (filtroAtual === 'pendente' && entrega.status === 'pendente');
    const texto = normalizarBusca(
      `${entrega.cliente} ${entrega.endereco} ${entrega.motorista}`
    );
    const dataEntrega = dataLocalDaEntrega(entrega);
    const correspondeAoPeriodo = (!historicoDe.value || dataEntrega >= historicoDe.value)
      && (!historicoAte.value || dataEntrega <= historicoAte.value);
    return correspondeAoStatus && texto.includes(termo) && correspondeAoPeriodo;
  });

  resumoLista.textContent = `${visiveis.length} ${visiveis.length === 1 ? 'entrega' : 'entregas'} de ${entregas.length}`;

  if (entregas.length === 0) {
    lista.appendChild(criarEstadoVazio('Sua rota começa aqui', 'Ainda não há entregas cadastradas. Crie a primeira parada para começar.', true));
    return;
  }

  if (visiveis.length === 0) {
    lista.appendChild(criarEstadoVazio('Nenhum resultado neste recorte', 'Tente outro status, período ou termo de busca.'));
    return;
  }

  const pontos = [];

  for (const entrega of visiveis) {
    const latitude = Number(entrega.latitude);
    const longitude = Number(entrega.longitude);

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      continue;
    }

    const cor = entrega.resultado_entrega === 'devolvida'
      ? '#bd1e3b'
      : entrega.status === 'entregue' ? '#3eaa35' : '#d94f45';

    const marcadorEditavel = entrega.status === 'pendente' && !entrega.rota_enviada;
    const marcador = entrega.status === 'pendente'
      ? L.marker([latitude, longitude], {
        draggable: marcadorEditavel,
        title: marcadorEditavel ? `Arraste para corrigir a localização de ${entrega.cliente}` : entrega.cliente,
        icon: L.divIcon({
          className: 'marcador-arrastavel',
          html: '<span aria-hidden="true"></span>',
          iconSize: [30, 38],
          iconAnchor: [15, 34],
          popupAnchor: [0, -32],
        }),
      }).addTo(camadaMarcadores)
      : L.circleMarker([latitude, longitude], {
        radius: 9,
        color: '#ffffff',
        weight: 2,
        fillColor: cor,
        fillOpacity: 1,
      }).addTo(camadaMarcadores);

    marcador.bindPopup(criarPopup(entrega));
    if (marcadorEditavel) {
      marcador.on('dragend', async () => {
        const novaPosicao = marcador.getLatLng();
        const posicaoAnterior = [Number(entrega.latitude), Number(entrega.longitude)];
        marcador.closePopup();
        try {
          const resposta = await fetch(`/api/entregas/${encodeURIComponent(entrega.id)}/localizacao`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ latitude: novaPosicao.lat, longitude: novaPosicao.lng }),
          });
          const dados = await resposta.json();
          if (!resposta.ok) throw new Error(dados.erro || 'Não foi possível salvar o novo local.');
          entrega.latitude = dados.latitude;
          entrega.longitude = dados.longitude;
          mensagem.textContent = `Local da entrega de ${entrega.cliente} corrigido e salvo.`;
        } catch (erro) {
          marcador.setLatLng(posicaoAnterior);
          mensagem.textContent = erro.message;
        }
      });
    }
    lista.appendChild(criarCartao(entrega, marcador));
    pontos.push([latitude, longitude]);
  }

  // Reenquadra apenas quando os primeiros pontos chegam. A lista atualiza
  // periodicamente; chamar fitBounds em cada atualização tira o controle
  // do zoom e da posição de quem está explorando o mapa.
  if (pontos.length > 0 && !mapaEnquadradoInicialmente) {
    mapa.fitBounds(pontos, { padding: [35, 35], maxZoom: 14 });
    mapaEnquadradoInicialmente = true;
  }
}

async function carregarEntregas() {
  mensagem.textContent = 'Atualizando entregas…';
  lista.setAttribute('aria-busy', 'true');

  try {
    const resposta = await fetch('/api/entregas', { cache: 'no-store' });
    const dados = await resposta.json();

    if (!resposta.ok) {
      throw new Error(dados.erro || 'Falha ao carregar entregas.');
    }

    entregasAtuais = dados;
    mostrarEntregas(entregasAtuais);
    lista.setAttribute('aria-busy', 'false');
    mensagem.textContent = `Atualizado às ${new Date().toLocaleTimeString('pt-BR')}.`;
  } catch (erro) {
    lista.setAttribute('aria-busy', 'false');
    mensagem.textContent = erro.message;
  }
}

async function carregarMotoristas() {
  try {
    const resposta = await fetch('/api/motoristas', { cache: 'no-store' });
    const dados = await resposta.json();
    if (!resposta.ok) return;
    motoristasDisponiveis = dados;
    mostrarEntregas(entregasAtuais);
  } catch {
    motoristasDisponiveis = [];
  }
}

form.addEventListener('submit', async (evento) => {
  evento.preventDefault();

  const dados = Object.fromEntries(new FormData(form).entries());

  const botao = document.getElementById('botao-cadastrar');
  botao.disabled = true;
  botao.textContent = 'Cadastrando…';
  mensagemCadastro.textContent = 'Recebendo cadastro e verificando o endereço…';
  mensagemCadastro.dataset.tipo = 'andamento';

  try {
    const resposta = await fetch('/api/entregas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dados),
    });
    const resultado = await resposta.json();

    if (!resposta.ok) {
      throw new Error(resultado.erro || 'Falha ao cadastrar entrega.');
    }

    form.reset();
    mensagemCadastro.textContent = `Entrega de ${resultado.cliente} cadastrada com sucesso.`;
    mensagemCadastro.dataset.tipo = 'sucesso';
    await carregarEntregas();
    await carregarMotoristas();
  } catch (erro) {
    mensagemCadastro.textContent = `Não foi possível cadastrar: ${erro.message}`;
    mensagemCadastro.dataset.tipo = 'erro';
    console.error('Falha no cadastro da entrega:', erro);
  } finally {
    botao.disabled = false;
    botao.textContent = 'Cadastrar entrega';
  }
});

formEdicao.addEventListener('submit', async (evento) => {
  evento.preventDefault();

  const dados = Object.fromEntries(new FormData(formEdicao).entries());
  const id = dados.id;
  delete dados.id;

  const botaoSalvar = document.getElementById('salvar-edicao');
  botaoSalvar.disabled = true;
  botaoSalvar.textContent = 'Salvando…';
  mensagemEdicao.textContent = 'Atualizando endereço e localização…';

  try {
    const resposta = await fetch(`/api/entregas/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dados),
    });
    const resultado = await resposta.json();
    if (!resposta.ok) throw new Error(resultado.erro || 'Não foi possível alterar a entrega.');

    dialogEdicao.close();
    mensagem.textContent = `Entrega de ${resultado.cliente} atualizada.`;
    await carregarEntregas();
  } catch (erro) {
    mensagemEdicao.textContent = erro.message;
  } finally {
    botaoSalvar.disabled = false;
    botaoSalvar.textContent = 'Salvar alterações';
  }
});

document.getElementById('cancelar-edicao').addEventListener('click', () => {
  dialogEdicao.close();
});

document.querySelector('.botao-fechar-dialogo').addEventListener('click', () => {
  dialogEdicao.close();
});

botaoAtualizar.addEventListener('click', carregarEntregas);

campoBusca.addEventListener('input', () => mostrarEntregas(entregasAtuais));

document.querySelectorAll('[data-filtro]').forEach((botao) => {
  botao.addEventListener('click', () => {
    filtroAtual = botao.dataset.filtro;
    document.querySelectorAll('[data-filtro]').forEach((item) => {
      item.setAttribute('aria-pressed', String(item === botao));
    });
    mostrarEntregas(entregasAtuais);
  });
});

seletorMotoristaRota.addEventListener('change', () => {
  atualizarPainelEnvioRota(entregasAtuais);
  renderizarParadasRota(entregasAtuais);
});
historicoDe.addEventListener('change', () => mostrarEntregas(entregasAtuais));
historicoAte.addEventListener('change', () => mostrarEntregas(entregasAtuais));
seletorPeriodo.addEventListener('change', () => {
  aplicarAtalhoPeriodo(seletorPeriodo.value);
  mostrarEntregas(entregasAtuais);
});
document.getElementById('limpar-historico').addEventListener('click', () => {
  seletorPeriodo.value = 'todos';
  aplicarAtalhoPeriodo('todos');
  mostrarEntregas(entregasAtuais);
});

botaoEnviarRota.addEventListener('click', async () => {
  const motorista = seletorMotoristaRota.value;
  if (!motorista) return;
  botaoEnviarRota.disabled = true;
  botaoEnviarRota.textContent = 'Enviando…';
  try {
    const resposta = await fetch('/api/rotas/enviar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        motorista,
        entrega_ids: [...entregasSelecionadas],
      }),
    });
    const dados = await resposta.json();
    if (!resposta.ok) throw new Error(dados.erro || 'Não foi possível enviar a rota.');
    entregasSelecionadas.clear();
    limparDesenhoRegiao(false);
    seletorMotoristaRota.value = '';
    const identificadorRota = dados.rota_id ? ` ${dados.rota_id.slice(0, 8).toUpperCase()}` : '';
    mensagem.textContent = `Rota${identificadorRota} enviada para ${motorista} com ${dados.entregas_enviadas} ${dados.entregas_enviadas === 1 ? 'entrega' : 'entregas'}.`;
    await carregarEntregas();
  } catch (erro) {
    mensagem.textContent = erro.message;
    botaoEnviarRota.disabled = false;
    atualizarPainelEnvioRota(entregasAtuais);
  }
});

async function iniciarCentral() {
  configurarNavegacaoPainel();
  try {
    const resposta = await fetch('/api/auth/session', { cache: 'no-store' });
    const dados = await resposta.json();
    if (!dados.usuario) {
      window.location.replace('/login.html');
      return;
    }
    if (dados.usuario.papel === 'motorista') {
      window.location.replace('/motorista.html');
      return;
    }
    if (dados.usuario.papel === 'master') {
      document.getElementById('link-admin').hidden = false;
    }
    document.querySelector('.navegacao-papeis a[href="/motorista.html"]').hidden = dados.usuario.papel === 'motorista';
    await Promise.all([carregarEntregas(), carregarMotoristas()]);
    setInterval(carregarEntregas, 5000);
    setInterval(carregarMotoristas, 30000);
  } catch (erro) {
    mensagem.textContent = `Não foi possível validar o acesso: ${erro.message}`;
  }
}

document.getElementById('sair').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.replace('/login.html');
});

// Atualiza a central a cada 5 segundos depois de validar o acesso.
iniciarCentral();
