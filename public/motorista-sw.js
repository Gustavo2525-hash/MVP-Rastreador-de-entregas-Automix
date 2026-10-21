const CACHE_MOTORISTA = 'motorista-shell-v4';
const BANCO_MOTORISTA = 'rastreabilidade-motorista-v1';
const ARQUIVOS_MOTORISTA = [
  '/motorista.html',
  '/motorista.css?v=20261020-qa-polish',
  '/motorista.js?v=20261020-qa-polish',
];

self.addEventListener('install', (evento) => {
  evento.waitUntil(caches.open(CACHE_MOTORISTA).then((cache) => cache.addAll(ARQUIVOS_MOTORISTA)));
  self.skipWaiting();
});

self.addEventListener('activate', (evento) => {
  evento.waitUntil((async () => {
    const nomes = await caches.keys();
    await Promise.all(nomes.filter((nome) => nome.startsWith('motorista-shell-') && nome !== CACHE_MOTORISTA).map((nome) => caches.delete(nome)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (evento) => {
  const url = new URL(evento.request.url);
  if (url.origin !== self.location.origin || evento.request.method !== 'GET') return;
  const ehArquivoMotorista = url.pathname === '/motorista.html' || url.pathname === '/motorista.js' || url.pathname === '/motorista.css';
  if (!ehArquivoMotorista) return;
  evento.respondWith((async () => {
    const cache = await caches.open(CACHE_MOTORISTA);
    const salvo = await cache.match(evento.request) || await cache.match(url.pathname);
    if (salvo) {
      fetch(evento.request).then((resposta) => {
        if (resposta.ok) cache.put(evento.request, resposta.clone());
      }).catch(() => {});
      return salvo;
    }
    try {
      const resposta = await fetch(evento.request);
      if (resposta.ok) await cache.put(evento.request, resposta.clone());
      return resposta;
    } catch {
      if (evento.request.mode === 'navigate') return (await cache.match('/motorista.html')) || Response.error();
      return Response.error();
    }
  })());
});

function abrirBanco() {
  return new Promise((resolve, reject) => {
    const requisicao = indexedDB.open(BANCO_MOTORISTA, 1);
    requisicao.onsuccess = () => resolve(requisicao.result);
    requisicao.onerror = () => reject(requisicao.error);
  });
}

async function enviarFilaOffline() {
  const banco = await abrirBanco();
  const sessao = await fetch('/api/auth/session', { cache: 'no-store', credentials: 'include' }).catch(() => null);
  if (!sessao?.ok) { banco.close(); return; }
  const dadosSessao = await sessao.json().catch(() => ({}));
  const motorista = dadosSessao.usuario?.nome;
  if (!motorista || dadosSessao.usuario?.papel !== 'motorista') { banco.close(); return; }

  const rota = await new Promise((resolve, reject) => {
    const transacao = banco.transaction('rotas', 'readonly');
    const requisicao = transacao.objectStore('rotas').get(motorista);
    requisicao.onsuccess = () => resolve(requisicao.result);
    requisicao.onerror = () => reject(requisicao.error);
  });
  if (rota?.inicioPendente) {
    let inicio;
    try {
      inicio = await fetch('/api/minhas-entregas/iniciar', { method: 'POST', credentials: 'include', cache: 'no-store' });
    } catch { banco.close(); return; }
    if (!inicio.ok) { banco.close(); return; }
    const dadosInicio = await inicio.json().catch(() => ({}));
    rota.inicioPendente = false;
    delete rota.inicioLocalEm;
    rota.resumo = {
      ...rota.resumo,
      rota_iniciada: true,
      rota_ativa: true,
      tempo_em_rota_segundos: Number(dadosInicio.tempo_em_rota_segundos || 0),
    };
    rota.salvoEm = Date.now();
    await new Promise((resolve, reject) => {
      const transacao = banco.transaction('rotas', 'readwrite');
      transacao.objectStore('rotas').put(rota);
      transacao.oncomplete = resolve;
      transacao.onerror = () => reject(transacao.error);
    });
  }

  const fila = await new Promise((resolve, reject) => {
    const transacao = banco.transaction('fila', 'readonly');
    const requisicao = transacao.objectStore('fila').getAll();
    requisicao.onsuccess = () => resolve(requisicao.result);
    requisicao.onerror = () => reject(requisicao.error);
  });
  let enviados = 0;
  for (const parada of fila.filter((item) => item.motorista === motorista)) {
    const dados = new FormData();
    dados.append('id', String(parada.id));
    dados.append('resultado_entrega', parada.resultado_entrega);
    dados.append('comentario', parada.comentario || '');
    if (parada.foto) dados.append('foto', parada.foto, parada.nomeFoto || 'foto-entrega.jpg');
    let resposta;
    try {
      resposta = await fetch(`/api/entregas/${encodeURIComponent(parada.id)}/finalizar`, {
        method: 'PATCH', body: dados, credentials: 'include', cache: 'no-store',
      });
    } catch { break; }
    if (resposta.status === 401) break;
    if (!resposta.ok) {
      parada.erroSync = `HTTP ${resposta.status}`;
      await new Promise((resolve, reject) => {
        const tx = banco.transaction('fila', 'readwrite');
        tx.objectStore('fila').put(parada);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      continue;
    }
    await new Promise((resolve, reject) => {
      const tx = banco.transaction('fila', 'readwrite');
      tx.objectStore('fila').delete(String(parada.id));
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    enviados += 1;
  }
  banco.close();
  if (enviados) {
    const abas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    abas.forEach((aba) => aba.postMessage({ tipo: 'FILA_SINCRONIZADA', enviados }));
  }
}

self.addEventListener('sync', (evento) => {
  if (evento.tag === 'sincronizar-paradas') evento.waitUntil(enviarFilaOffline());
});
