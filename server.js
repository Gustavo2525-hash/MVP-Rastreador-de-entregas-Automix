require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { Pool } = require('pg');

const app = express();
const porta = Number(process.env.PORT) || 3000;
const pastaFotos = path.join(__dirname, 'uploads');
const sessoes = new Map();
const nomeCookieSessao = 'rastreabilidade_sessao';
const duracaoSessaoMs = 8 * 60 * 60 * 1000;
const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, '');
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseBucketFotos = process.env.SUPABASE_STORAGE_BUCKET || 'comprovantes';
const usarSupabaseStorage = Boolean(supabaseUrl && supabaseServiceRoleKey);

fs.mkdirSync(pastaFotos, { recursive: true });

const banco = new Pool({
  connectionString: process.env.DATABASE_URL || undefined,
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
  max: Number(process.env.PGPOOL_MAX) || 5,
});

banco.on('error', (erro) => {
  console.error('Erro inesperado na conexão com PostgreSQL:', erro.message);
});

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
function exigirSessaoFoto(req, res, next) {
  if (!usuarioDaRequisicao(req)) {
    return res.status(401).send('Faça login para consultar fotos de entrega.');
  }
  next();
}

app.get('/uploads/:nome', exigirSessaoFoto, async (req, res, next) => {
  const nome = req.params.nome;
  if (!nome || path.basename(nome) !== nome) return res.sendStatus(404);
  if (!usarSupabaseStorage) return next();
  try {
    const url = `${supabaseUrl}/storage/v1/object/${encodeURIComponent(supabaseBucketFotos)}/${encodeURIComponent(nome)}`;
    const resposta = await fetch(url, {
      headers: { apikey: supabaseServiceRoleKey, Authorization: `Bearer ${supabaseServiceRoleKey}` },
    });
    if (resposta.status === 404) return res.sendStatus(404);
    if (!resposta.ok) return res.status(502).send('Não foi possível carregar a foto da entrega.');
    res.setHeader('Content-Type', resposta.headers.get('content-type') || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(Buffer.from(await resposta.arrayBuffer()));
  } catch (erro) {
    console.error('Falha ao buscar foto no Supabase Storage:', erro.message);
    res.status(502).send('Não foi possível carregar a foto da entrega.');
  }
});
app.use('/uploads', exigirSessaoFoto, express.static(pastaFotos));

function lerCookie(req, nome) {
  const cookies = req.headers.cookie || '';
  const entrada = cookies.split(';').map((item) => item.trim())
    .find((item) => item.startsWith(`${nome}=`));
  return entrada ? entrada.slice(nome.length + 1) : '';
}

function criarSessao(res, usuario) {
  const token = crypto.randomBytes(32).toString('hex');
  sessoes.set(token, { usuario, expiraEm: Date.now() + duracaoSessaoMs });
  const seguro = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${nomeCookieSessao}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${duracaoSessaoMs / 1000}${seguro}`);
}

function hashSenha(senha, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(senha, salt, 64).toString('hex');
  return { salt, hash };
}

function senhaCorreta(senha, salt, hashArmazenado) {
  const tentativa = crypto.scryptSync(senha, salt, 64);
  const armazenado = Buffer.from(hashArmazenado, 'hex');
  return tentativa.length === armazenado.length && crypto.timingSafeEqual(tentativa, armazenado);
}

function usuarioDaRequisicao(req) {
  const token = lerCookie(req, nomeCookieSessao);
  const sessao = sessoes.get(token);
  if (!sessao || sessao.expiraEm <= Date.now()) {
    if (token) sessoes.delete(token);
    return null;
  }
  return sessao.usuario;
}

function permitirPapeis(...papeis) {
  return (req, res, next) => {
    if (!req.usuario) return res.status(401).json({ erro: 'Faça login para continuar.' });
    if (!papeis.includes(req.usuario.papel)) return res.status(403).json({ erro: 'Seu usuário não tem permissão para esta ação.' });
    next();
  };
}

function papelValido(papel) {
  return ['master', 'roteirizador', 'motorista'].includes(papel);
}

// Registra cada tentativa de cadastro sem expor nome, endereço ou outros dados pessoais.
app.use((req, res, next) => {
  if (req.method === 'POST' && req.path === '/api/entregas') {
    const inicio = Date.now();
    console.info(`[HTTP] POST /api/entregas recebido às ${new Date().toLocaleTimeString('pt-BR')}`);
    res.on('finish', () => {
      console.info(`[HTTP] POST /api/entregas respondeu ${res.statusCode} em ${Date.now() - inicio} ms`);
    });
  }
  next();
});

const extensoesPorTipo = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

const armazenamentoFotosLocal = multer.diskStorage({
  destination: (req, arquivo, callback) => {
    callback(null, pastaFotos);
  },
  filename: (req, arquivo, callback) => {
    const extensao = extensoesPorTipo[arquivo.mimetype];
    callback(null, `${crypto.randomUUID()}${extensao}`);
  },
});

const uploadFoto = multer({
  storage: usarSupabaseStorage ? multer.memoryStorage() : armazenamentoFotosLocal,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, arquivo, callback) => {
    if (!extensoesPorTipo[arquivo.mimetype]) {
      return callback(new Error('Envie uma foto JPEG, PNG ou WebP.'));
    }

    callback(null, true);
  },
});

function receberFoto(req, res, next) {
  uploadFoto.single('foto')(req, res, (erro) => {
    if (erro) {
      const mensagem = erro.code === 'LIMIT_FILE_SIZE'
        ? 'A foto deve ter no máximo 8 MB.'
        : erro.message;

      return res.status(400).json({ erro: mensagem });
    }

    if (req.file && !req.file.filename) {
      req.file.filename = `${crypto.randomUUID()}${extensoesPorTipo[req.file.mimetype]}`;
    }

    next();
  });
}

async function removerFoto(arquivo) {
  if (arquivo?.path) {
    await fs.promises.unlink(arquivo.path).catch(() => {});
  }
}

async function salvarFoto(arquivo) {
  if (!arquivo) return null;
  const urlFoto = `/uploads/${arquivo.filename}`;
  if (!usarSupabaseStorage) return urlFoto;
  const url = `${supabaseUrl}/storage/v1/object/${encodeURIComponent(supabaseBucketFotos)}/${encodeURIComponent(arquivo.filename)}`;
  const resposta = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: supabaseServiceRoleKey,
      Authorization: `Bearer ${supabaseServiceRoleKey}`,
      'Content-Type': arquivo.mimetype,
      'x-upsert': 'false',
    },
    body: arquivo.buffer,
  });
  if (!resposta.ok) {
    const detalhe = await resposta.text().catch(() => '');
    console.error('Falha ao enviar foto ao Supabase Storage:', resposta.status, detalhe);
    throw new Error('Não foi possível guardar a foto na nuvem. Tente novamente.');
  }
  return urlFoto;
}

async function removerFotoSalva(urlFoto) {
  const prefixo = '/uploads/';
  if (typeof urlFoto !== 'string' || !urlFoto.startsWith(prefixo)) return;

  const nome = urlFoto.slice(prefixo.length);
  if (!nome || path.basename(nome) !== nome) return;

  if (usarSupabaseStorage) {
    const url = `${supabaseUrl}/storage/v1/object/${encodeURIComponent(supabaseBucketFotos)}`;
    await fetch(url, {
      method: 'DELETE',
      headers: {
        apikey: supabaseServiceRoleKey,
        Authorization: `Bearer ${supabaseServiceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ prefixes: [nome] }),
    }).catch((erro) => console.error('Falha ao excluir foto no Supabase Storage:', erro.message));
    return;
  }

  await fs.promises.unlink(path.join(pastaFotos, nome)).catch(() => {});
}

function normalizarTexto(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
    .replace(/[.,;:!?]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatoEnderecoValido(endereco) {
  const partes = endereco.split(',').map((parte) => parte.trim());
  return partes.length >= 4 &&
    partes[0].length > 0 &&
    /\d/.test(partes[1] || '') &&
    partes[2].length > 0 &&
    partes[3].length > 0;
}

function extrairMunicipio(endereco) {
  const estados = new Set([
    'ac', 'acre', 'al', 'alagoas', 'ap', 'amapa', 'am', 'amazonas',
    'ba', 'bahia', 'ce', 'ceara', 'df', 'distrito federal', 'es', 'espirito santo',
    'go', 'goias', 'ma', 'maranhao', 'mt', 'mato grosso', 'ms', 'mato grosso do sul',
    'mg', 'minas gerais', 'pa', 'para', 'pb', 'paraiba', 'pr', 'parana',
    'pe', 'pernambuco', 'pi', 'piaui', 'rj', 'rio de janeiro', 'rn', 'rio grande do norte',
    'rs', 'rio grande do sul', 'ro', 'rondonia', 'rr', 'roraima', 'sc', 'santa catarina',
    'sp', 'sao paulo', 'se', 'sergipe', 'to', 'tocantins',
  ]);

  const partes = endereco.split(',').map((parte) => parte.trim()).filter(Boolean);
  if (normalizarTexto(partes.at(-1)) === 'brasil') partes.pop();
  if (/^\d{5}-?\d{3}$/.test(partes.at(-1) || '')) partes.pop();
  // Só trata o último componente como estado quando há um componente
  // anterior para a cidade. Isso preserva cidades chamadas São Paulo.
  if (partes.length >= 5 && estados.has(normalizarTexto(partes.at(-1)))) {
    partes.pop();
  }

  // No formato Rua, número, bairro, cidade, estado, município fica antes do estado.
  return partes.length >= 3 ? normalizarTexto(partes.at(-1)) : '';
}

async function geocodificarEndereco(endereco) {
  const chave = process.env.MAPTILER_API_KEY?.trim();

  if (!chave) {
    const erro = new Error('A chave do MapTiler não está configurada.');
    erro.code = 'MAPTILER_API_KEY_MISSING';
    throw erro;
  }

  const url = new URL(
    `https://api.maptiler.com/geocoding/${encodeURIComponent(endereco)}.json`
  );

  url.searchParams.set('key', chave);
  url.searchParams.set('country', 'br');
  url.searchParams.set('language', 'pt');
  url.searchParams.set('limit', '5');
  url.searchParams.set('types', 'address,road');
  url.searchParams.set('fuzzyMatch', 'false');
  url.searchParams.set('autocomplete', 'false');

  const resposta = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'RastreabilidadeEntregas/1.0 (backend)',
    },
    signal: AbortSignal.timeout(12000),
  });

  if (!resposta.ok) {
    // O corpo pode ser JSON ou texto simples. Nunca registre a URL, pois
    // ela contém a chave na query string, e remova a chave do corpo também.
    let detalhe = '';
    try {
      const corpo = await resposta.text();
      try {
        const json = JSON.parse(corpo);
        detalhe = json.message || json.error || corpo;
      } catch {
        detalhe = corpo;
      }
    } catch {
      // Mantém o diagnóstico HTTP se não for possível ler a resposta.
    }
    detalhe = String(detalhe).replaceAll(chave, '[chave ocultada]').replace(/\s+/g, ' ').trim().slice(0, 500);

    const erro = new Error(
      `O serviço de localização respondeu com HTTP ${resposta.status}${
        detalhe ? `: ${detalhe}` : '.'
      }`
    );
    erro.code = 'MAPTILER_HTTP_ERROR';
    erro.status = resposta.status;
    throw erro;
  }

  const dados = await resposta.json();
  const municipio = extrairMunicipio(endereco);
  if (!municipio) {
    return null;
  }

  // Não usar cegamente o primeiro resultado: nomes de ruas parecidos podem
  // apontar para outro município. Só aceitamos endereço/rua que corresponda
  // ao município escrito pela pessoa.
  const resultado = dados.features?.find((feature) => {
    const tipo = feature.place_type || [];
    const tipoValido = tipo.includes('address') || tipo.includes('road');
    const nomes = [
      feature.place_name,
      feature.matching_place_name,
      ...(feature.context || []).map((item) => item.text),
    ].join(' ');

    return tipoValido && normalizarTexto(nomes).includes(municipio);
  });
  const coordenadas = resultado?.geometry?.coordinates;

  if (!Array.isArray(coordenadas) || coordenadas.length < 2) {
    return null;
  }

  // A API retorna [longitude, latitude].
  const longitude = Number(coordenadas[0]);
  const latitude = Number(coordenadas[1]);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }

  return { latitude, longitude };
}

// Primeiro acesso: cria a conta principal Gustavo e define a senha no navegador.
app.get('/api/auth/status', async (req, res) => {
  try {
    const resultado = await banco.query('SELECT COUNT(*)::int AS total FROM usuarios');
    res.json({ precisaConfiguracao: resultado.rows[0].total === 0 });
  } catch (erro) {
    console.error('Falha ao verificar configuração de usuários:', erro.message);
    res.status(500).json({ erro: 'Não foi possível verificar a configuração do painel.' });
  }
});

app.post('/api/auth/bootstrap', async (req, res) => {
  const senha = req.body?.senha;
  if (typeof senha !== 'string' || senha.length < 8) {
    return res.status(400).json({ erro: 'Crie uma senha com pelo menos 8 caracteres.' });
  }

  try {
    const existente = await banco.query('SELECT 1 FROM usuarios LIMIT 1');
    if (existente.rowCount > 0) {
      return res.status(409).json({ erro: 'O painel já foi configurado. Entre com seu usuário.' });
    }

    const credenciais = hashSenha(senha);
    const criado = await banco.query(
      `INSERT INTO usuarios (nome, usuario, senha_hash, senha_salt, papel)
       VALUES ('Gustavo', 'gustavo', $1, $2, 'master')
       RETURNING id, nome, usuario, papel`,
      [credenciais.hash, credenciais.salt]
    );
    criarSessao(res, criado.rows[0]);
    res.status(201).json({ usuario: criado.rows[0] });
  } catch (erro) {
    console.error('Falha ao configurar o usuário master:', erro.message);
    res.status(500).json({ erro: 'Não foi possível criar o usuário master.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const usuarioInformado = typeof req.body?.usuario === 'string'
    ? req.body.usuario.trim().toLocaleLowerCase('pt-BR')
    : '';
  const senha = typeof req.body?.senha === 'string' ? req.body.senha : '';
  if (!usuarioInformado || !senha) {
    return res.status(400).json({ erro: 'Informe usuário e senha.' });
  }

  try {
    const resultado = await banco.query(
      `SELECT id, nome, usuario, senha_hash, senha_salt, papel, ativo
       FROM usuarios WHERE usuario = $1`,
      [usuarioInformado]
    );
    const conta = resultado.rows[0];
    if (!conta || !conta.ativo || !senhaCorreta(senha, conta.senha_salt, conta.senha_hash)) {
      return res.status(401).json({ erro: 'Usuário ou senha incorretos.' });
    }

    const usuarioPublico = { id: conta.id, nome: conta.nome, usuario: conta.usuario, papel: conta.papel };
    criarSessao(res, usuarioPublico);
    res.json({ usuario: usuarioPublico });
  } catch (erro) {
    console.error('Falha ao entrar no sistema:', erro.message);
    res.status(500).json({ erro: 'Não foi possível iniciar a sessão.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  const token = lerCookie(req, nomeCookieSessao);
  if (token) sessoes.delete(token);
  res.setHeader('Set-Cookie', `${nomeCookieSessao}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  res.json({ mensagem: 'Sessão encerrada.' });
});

app.get('/api/auth/session', (req, res) => {
  res.json({ usuario: usuarioDaRequisicao(req) });
});

// Todas as outras rotas da API exigem uma sessão válida.
app.use('/api', (req, res, next) => {
  const rotasPublicas = ['/auth/status', '/auth/bootstrap', '/auth/login', '/auth/logout', '/auth/session'];
  if (rotasPublicas.includes(req.path)) return next();
  req.usuario = usuarioDaRequisicao(req);
  if (!req.usuario) return res.status(401).json({ erro: 'Faça login para continuar.' });
  next();
});

app.get('/api/usuarios', permitirPapeis('master'), async (req, res) => {
  try {
    const resultado = await banco.query(
      'SELECT id, nome, usuario, papel, ativo, criado_em FROM usuarios ORDER BY CASE papel WHEN \'master\' THEN 1 WHEN \'roteirizador\' THEN 2 ELSE 3 END, nome'
    );
    res.json(resultado.rows);
  } catch (erro) {
    console.error('Falha ao listar usuários:', erro.message);
    res.status(500).json({ erro: 'Não foi possível carregar os usuários.' });
  }
});

app.post('/api/usuarios', permitirPapeis('master'), async (req, res) => {
  const nome = typeof req.body?.nome === 'string' ? req.body.nome.trim() : '';
  const usuario = typeof req.body?.usuario === 'string' ? req.body.usuario.trim().toLocaleLowerCase('pt-BR') : '';
  const senha = typeof req.body?.senha === 'string' ? req.body.senha : '';
  const papel = req.body?.papel;

  if (nome.length < 2 || nome.length > 100) {
    return res.status(400).json({ erro: 'Informe o nome da pessoa (2 a 100 caracteres).' });
  }
  if (!/^[a-z0-9._-]{3,40}$/.test(usuario)) {
    return res.status(400).json({ erro: 'O usuário deve ter 3 a 40 caracteres: letras sem acento, números, ponto, hífen ou sublinhado.' });
  }
  if (senha.length < 8) return res.status(400).json({ erro: 'A senha deve ter pelo menos 8 caracteres.' });
  if (!papelValido(papel)) return res.status(400).json({ erro: 'Escolha uma função válida.' });

  try {
    const credenciais = hashSenha(senha);
    const criado = await banco.query(
      `INSERT INTO usuarios (nome, usuario, senha_hash, senha_salt, papel)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, nome, usuario, papel, ativo, criado_em`,
      [nome, usuario, credenciais.hash, credenciais.salt, papel]
    );
    res.status(201).json(criado.rows[0]);
  } catch (erro) {
    if (erro.code === '23505') return res.status(409).json({ erro: 'Esse nome de usuário já existe.' });
    console.error('Falha ao criar usuário:', erro.message);
    res.status(500).json({ erro: 'Não foi possível criar o usuário.' });
  }
});

// Verifica se a API consegue acessar o banco.
app.get('/api/status', async (req, res) => {
  try {
    const resultado = await banco.query(
      'SELECT current_database() AS banco'
    );

    res.json({
      api: 'ok',
      banco: resultado.rows[0].banco,
      maptiler: process.env.MAPTILER_API_KEY?.trim()
        ? 'configurada'
        : 'ausente',
    });
  } catch (erro) {
    console.error('Falha ao consultar o banco:', erro.message);
    res.status(500).json({
      api: 'erro',
      erro: 'Banco indisponível.',
    });
  }
});

// Nomes disponíveis para que o entregador escolha sua rota no celular.
app.get('/api/motoristas', permitirPapeis('master', 'roteirizador'), async (req, res) => {
  try {
    const resultado = await banco.query(
      `SELECT nome AS motorista FROM usuarios
       WHERE papel = 'motorista' AND ativo = TRUE
       ORDER BY nome`
    );
    res.json(resultado.rows.map((linha) => linha.motorista));
  } catch (erro) {
    console.error('Falha ao listar entregadores:', erro.message);
    res.status(500).json({ erro: 'Não foi possível carregar os entregadores.' });
  }
});

// A central atribui e publica somente as paradas selecionadas para o motorista.
app.post('/api/rotas/enviar', permitirPapeis('master', 'roteirizador'), async (req, res) => {
  const motorista = typeof req.body?.motorista === 'string' ? req.body.motorista.trim() : '';
  if (!motorista) return res.status(400).json({ erro: 'Escolha o motorista da rota.' });
  const idsRecebidos = req.body?.entrega_ids;
  if (!Array.isArray(idsRecebidos) || idsRecebidos.length === 0 || idsRecebidos.length > 500) {
    return res.status(400).json({ erro: 'Selecione pelo menos uma entrega para montar a rota.' });
  }
  const entregaIds = idsRecebidos.map(Number);
  if (entregaIds.some((id) => !Number.isSafeInteger(id) || id < 1)
    || new Set(entregaIds).size !== entregaIds.length) {
    return res.status(400).json({ erro: 'A seleção contém uma entrega inválida.' });
  }
  let clienteBanco;
  let transacaoAberta = false;
  try {
    const motoristaAtivo = await banco.query(
      `SELECT id FROM usuarios WHERE nome = $1 AND papel = 'motorista' AND ativo = TRUE`,
      [motorista]
    );
    if (!motoristaAtivo.rowCount) {
      return res.status(404).json({ erro: 'Esse motorista não tem acesso ativo. Cadastre ou reative o usuário no Painel admin.' });
    }
    clienteBanco = await banco.connect();
    await clienteBanco.query('BEGIN');
    transacaoAberta = true;
    const rotaId = crypto.randomUUID();
    const publicadas = await clienteBanco.query(
      `UPDATE entregas SET motorista = $1, rota_enviada = TRUE, rota_id = $2
       WHERE id = ANY($3::bigint[]) AND status = 'pendente' AND rota_enviada = FALSE
       RETURNING id`,
      [motorista, rotaId, entregaIds]
    );
    if (publicadas.rowCount !== entregaIds.length) {
      await clienteBanco.query('ROLLBACK');
      transacaoAberta = false;
      return res.status(409).json({ erro: 'Uma ou mais entregas já foram enviadas ou não estão mais disponíveis. Atualize a lista e selecione novamente.' });
    }
    await clienteBanco.query(
      `UPDATE usuarios
       SET rota_iniciada_em = CASE
             WHEN rota_finalizada_em IS NOT NULL THEN NULL
             WHEN rota_iniciada_em IS NOT NULL AND
                  (rota_iniciada_em AT TIME ZONE 'America/Sao_Paulo')::date <
                  (NOW() AT TIME ZONE 'America/Sao_Paulo')::date THEN NULL
             ELSE rota_iniciada_em
           END,
           rota_finalizada_em = CASE
             WHEN rota_finalizada_em IS NOT NULL OR
                  (rota_iniciada_em AT TIME ZONE 'America/Sao_Paulo')::date <
                  (NOW() AT TIME ZONE 'America/Sao_Paulo')::date THEN NULL
             ELSE rota_finalizada_em
           END
       WHERE nome = $1 AND papel = 'motorista'`,
      [motorista]
    );
    await clienteBanco.query('COMMIT');
    transacaoAberta = false;
    res.json({ rota_id: rotaId, motorista, entregas_enviadas: publicadas.rowCount });
  } catch (erro) {
    if (transacaoAberta) await clienteBanco.query('ROLLBACK').catch(() => {});
    console.error('Falha ao enviar a rota:', erro.message);
    res.status(500).json({ erro: 'Não foi possível enviar a rota.' });
  } finally {
    clienteBanco?.release();
  }
});

app.post('/api/minhas-entregas/iniciar', permitirPapeis('motorista'), async (req, res) => {
  try {
    const pendentes = await banco.query(
      `SELECT COUNT(*)::int AS total FROM entregas
       WHERE motorista = $1 AND status = 'pendente' AND rota_enviada = TRUE`,
      [req.usuario.nome]
    );
    if (!pendentes.rows[0].total) {
      return res.status(409).json({ erro: 'A central ainda não enviou entregas pendentes para você.' });
    }
    const iniciada = await banco.query(
      `UPDATE usuarios
       SET rota_iniciada_em = CASE
             WHEN rota_iniciada_em IS NULL OR rota_finalizada_em IS NOT NULL OR
                  (rota_iniciada_em AT TIME ZONE 'America/Sao_Paulo')::date <
                  (NOW() AT TIME ZONE 'America/Sao_Paulo')::date THEN NOW()
             ELSE rota_iniciada_em
           END,
           rota_finalizada_em = NULL
       WHERE id = $1
       RETURNING rota_iniciada_em,
         GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - rota_iniciada_em))))::int AS tempo_em_rota_segundos`,
      [req.usuario.id]
    );
    res.json({ iniciada: true, tempo_em_rota_segundos: iniciada.rows[0].tempo_em_rota_segundos });
  } catch (erro) {
    console.error('Falha ao iniciar a rota:', erro.message);
    res.status(500).json({ erro: 'Não foi possível iniciar sua rota.' });
  }
});

// O motorista só recebe uma rota que a central já enviou.
app.get('/api/minhas-entregas', permitirPapeis('motorista'), async (req, res) => {
  try {
    const entregas = await banco.query(
      `SELECT * FROM entregas
       WHERE motorista = $1 AND status = 'pendente' AND rota_enviada = TRUE
       ORDER BY criado_em ASC`,
      [req.usuario.nome]
    );
    const aguardandoEnvio = await banco.query(
      `SELECT COUNT(*)::int AS total FROM entregas
       WHERE motorista = $1 AND status = 'pendente' AND rota_enviada = FALSE`,
      [req.usuario.nome]
    );
    const feitas = await banco.query(
      `SELECT COUNT(*)::int AS total FROM entregas
       WHERE motorista = $1 AND status = 'entregue'
         AND (entregue_em AT TIME ZONE 'America/Sao_Paulo')::date =
             (NOW() AT TIME ZONE 'America/Sao_Paulo')::date`,
      [req.usuario.nome]
    );
    const faltam = entregas.rowCount;
    if (!faltam) {
      await banco.query(
        `UPDATE usuarios SET rota_finalizada_em = NOW()
         WHERE id = $1 AND rota_iniciada_em IS NOT NULL AND rota_finalizada_em IS NULL`,
        [req.usuario.id]
      );
    }
    const estadoRota = await banco.query(
      `SELECT
         (rota_iniciada_em IS NOT NULL AND
          (rota_iniciada_em AT TIME ZONE 'America/Sao_Paulo')::date =
          (NOW() AT TIME ZONE 'America/Sao_Paulo')::date) AS rota_iniciada,
         (rota_iniciada_em IS NOT NULL AND rota_finalizada_em IS NULL AND
          (rota_iniciada_em AT TIME ZONE 'America/Sao_Paulo')::date =
          (NOW() AT TIME ZONE 'America/Sao_Paulo')::date) AS rota_ativa,
         CASE WHEN rota_iniciada_em IS NULL OR
                   (rota_iniciada_em AT TIME ZONE 'America/Sao_Paulo')::date <
                   (NOW() AT TIME ZONE 'America/Sao_Paulo')::date
              THEN NULL
              ELSE GREATEST(0, FLOOR(EXTRACT(EPOCH FROM
                   (COALESCE(rota_finalizada_em, NOW()) - rota_iniciada_em))))::int
         END AS tempo_em_rota_segundos
       FROM usuarios WHERE id = $1`,
      [req.usuario.id]
    );

    res.json({
      entregas: entregas.rows,
      resumo: {
        feitas: feitas.rows[0].total,
        faltam,
        aguardando_envio: aguardandoEnvio.rows[0].total,
        rota_enviada: faltam > 0,
        rota_iniciada: estadoRota.rows[0].rota_iniciada,
        rota_ativa: estadoRota.rows[0].rota_ativa,
        tempo_em_rota_segundos: estadoRota.rows[0].tempo_em_rota_segundos,
      },
    });
  } catch (erro) {
    console.error('Falha ao carregar a rota do motorista:', erro.message);
    res.status(500).json({ erro: 'Não foi possível carregar sua rota.' });
  }
});
// Lista entregas. Os filtros por motorista e status são opcionais.
app.get('/api/entregas', permitirPapeis('master', 'roteirizador'), async (req, res) => {
  const { motorista, status } = req.query;
  const filtros = [];
  const parametros = [];

  if (motorista !== undefined) {
    if (typeof motorista !== 'string' || !motorista.trim()) {
      return res.status(400).json({
        erro: 'Nome de entregador inválido.',
      });
    }

    parametros.push(motorista.trim());
    filtros.push(`motorista = $${parametros.length}`);
  }

  if (status !== undefined) {
    if (!['pendente', 'entregue'].includes(status)) {
      return res.status(400).json({
        erro: 'Status inválido.',
      });
    }

    parametros.push(status);
    filtros.push(`status = $${parametros.length}`);
  }

  const where = filtros.length
    ? `WHERE ${filtros.join(' AND ')}`
    : '';

  try {
    const resultado = await banco.query(
      `SELECT * FROM entregas ${where} ORDER BY criado_em DESC`,
      parametros
    );

    res.json(resultado.rows);
  } catch (erro) {
    console.error('Falha ao listar entregas:', erro.message);
    res.status(500).json({
      erro: 'Não foi possível buscar as entregas.',
    });
  }
});

// Cadastra a entrega e converte o endereço em coordenadas.
app.post('/api/entregas', permitirPapeis('master', 'roteirizador'), async (req, res) => {
  const { cliente, endereco } = req.body;

  if (
    typeof cliente !== 'string' || !cliente.trim() ||
    typeof endereco !== 'string' || !endereco.trim()
  ) {
    return res.status(400).json({
      erro: 'Informe o cliente e o endereço da entrega.',
    });
  }

  if (!formatoEnderecoValido(endereco.trim())) {
    return res.status(400).json({
      erro: 'Use o formato: Rua, número, bairro, cidade. Exemplo: Avenida Francisco José Pedro, 951, Quintino, Divinópolis.',
    });
  }

  let localizacao;

  try {
    localizacao = await geocodificarEndereco(endereco.trim());
  } catch (erro) {
    if (erro.code === 'MAPTILER_API_KEY_MISSING') {
      console.error(erro.message);
      return res.status(500).json({
        erro: 'Configure a chave do MapTiler no arquivo .env.',
      });
    }

    console.error('Falha ao localizar o endereço:', erro.message);

    if (erro.status === 403) {
      return res.status(502).json({
        erro: 'O MapTiler recusou esta chave (HTTP 403). Confira se a chave Backend está ativa e sem restrições de origem ou User-Agent, atualize o .env e reinicie o servidor.',
      });
    }

    return res.status(502).json({
      erro: 'Não foi possível buscar esse endereço. Tente novamente.',
    });
  }

  if (!localizacao) {
    return res.status(422).json({
      erro: 'Não consegui confirmar esse endereço na cidade informada. Confira o logradouro, número, bairro e cidade.',
    });
  }

  try {
    const resultado = await banco.query(
      `INSERT INTO entregas
        (cliente, endereco, latitude, longitude, motorista, rota_enviada)
       VALUES ($1, $2, $3, $4, NULL, FALSE)
       RETURNING *`,
      [
        cliente.trim(),
        endereco.trim(),
        localizacao.latitude,
        localizacao.longitude,
      ]
    );

    res.status(201).json(resultado.rows[0]);
  } catch (erro) {
    console.error('Falha ao salvar a entrega:', erro.message);
    res.status(500).json({
      erro: 'Não foi possível cadastrar a entrega.',
    });
  }
});

// Atualiza os dados de uma entrega pendente. Motorista fica opcional até a rota ser montada.
app.put('/api/entregas/:id', permitirPapeis('master', 'roteirizador'), async (req, res) => {
  const id = Number(req.params.id);
  const { cliente, endereco, motorista } = req.body;

  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ erro: 'ID de entrega inválido.' });
  }

  if (
    typeof cliente !== 'string' || !cliente.trim() ||
    typeof endereco !== 'string' || !endereco.trim() ||
    (motorista !== undefined && motorista !== null && typeof motorista !== 'string')
  ) {
    return res.status(400).json({ erro: 'Informe o cliente e o endereço. O motorista é opcional.' });
  }
  const motoristaNormalizado = typeof motorista === 'string' && motorista.trim() ? motorista.trim() : null;

  if (!formatoEnderecoValido(endereco.trim())) {
    return res.status(400).json({
      erro: 'Use o formato: Rua, número, bairro, cidade. Exemplo: Avenida Francisco José Pedro, 951, Quintino, Divinópolis.',
    });
  }

  let localizacao;
  try {
    localizacao = await geocodificarEndereco(endereco.trim());
  } catch (erro) {
    console.error('Falha ao localizar o endereço editado:', erro.message);
    return res.status(502).json({
      erro: erro.status === 403
        ? 'O MapTiler recusou a chave de geocodificação (HTTP 403).'
        : 'Não foi possível localizar o novo endereço.',
    });
  }

  if (!localizacao) {
    return res.status(422).json({
      erro: 'Não encontrei uma rua ou endereço nesse município. Confira o endereço informado.',
    });
  }

  try {
    const atualizada = await banco.query(
      `UPDATE entregas
       SET cliente = $1,
           endereco = $2,
           latitude = $3,
           longitude = $4,
           rota_enviada = CASE WHEN motorista IS DISTINCT FROM $5 THEN FALSE ELSE rota_enviada END,
           rota_id = CASE WHEN motorista IS DISTINCT FROM $5 THEN NULL ELSE rota_id END,
           motorista = $5
       WHERE id = $6 AND status = 'pendente'
       RETURNING *`,
      [cliente.trim(), endereco.trim(), localizacao.latitude,
        localizacao.longitude, motoristaNormalizado, id]
    );

    if (atualizada.rowCount > 0) {
      return res.json(atualizada.rows[0]);
    }

    const existente = await banco.query(
      'SELECT status FROM entregas WHERE id = $1',
      [id]
    );
    if (existente.rowCount === 0) {
      return res.status(404).json({ erro: 'Entrega não encontrada.' });
    }

    return res.status(409).json({
      erro: 'Entregas já concluídas não podem ser alteradas.',
    });
  } catch (erro) {
    console.error('Falha ao editar a entrega:', erro.message);
    return res.status(500).json({ erro: 'Não foi possível alterar a entrega.' });
  }
});

// Permite corrigir no mapa a posição da entrega, sem alterar o endereço escrito.
app.patch('/api/entregas/:id/localizacao', permitirPapeis('master', 'roteirizador'), async (req, res) => {
  const id = Number(req.params.id);
  const latitude = Number(req.body?.latitude);
  const longitude = Number(req.body?.longitude);
  if (!Number.isSafeInteger(id) || id < 1
    || !Number.isFinite(latitude) || latitude < -90 || latitude > 90
    || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    return res.status(400).json({ erro: 'Coordenadas inválidas. Arraste o marcador para um ponto válido.' });
  }
  try {
    const atualizada = await banco.query(
      `UPDATE entregas SET latitude = $1, longitude = $2
       WHERE id = $3 AND status = 'pendente' AND rota_enviada = FALSE
       RETURNING id, latitude, longitude`,
      [latitude, longitude, id]
    );
    if (!atualizada.rowCount) {
      return res.status(409).json({ erro: 'A localização só pode ser ajustada antes do envio da rota.' });
    }
    res.json(atualizada.rows[0]);
  } catch (erro) {
    console.error('Falha ao corrigir a localização da entrega:', erro.message);
    res.status(500).json({ erro: 'Não foi possível salvar a nova localização.' });
  }
});

// Exclui uma entrega e remove sua foto armazenada, se houver.
app.delete('/api/entregas/:id', permitirPapeis('master', 'roteirizador'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ erro: 'ID de entrega inválido.' });
  }

  try {
    const removida = await banco.query(
      'DELETE FROM entregas WHERE id = $1 RETURNING foto_url',
      [id]
    );

    if (removida.rowCount === 0) {
      return res.status(404).json({ erro: 'Entrega não encontrada.' });
    }

    await removerFotoSalva(removida.rows[0].foto_url);
    return res.json({ mensagem: 'Entrega excluída.' });
  } catch (erro) {
    console.error('Falha ao excluir a entrega:', erro.message);
    return res.status(500).json({ erro: 'Não foi possível excluir a entrega.' });
  }
});

// Finaliza a entrega, salva a foto e registra o resultado.
app.patch(
  '/api/entregas/:id/finalizar',
  permitirPapeis('motorista'),
  receberFoto,
  async (req, res) => {
    const id = Number(req.params.id);
    const { resultado_entrega, comentario } = req.body;

    if (!Number.isInteger(id) || id < 1) {
      await removerFoto(req.file);
      return res.status(400).json({ erro: 'ID de entrega inválido.' });
    }

    if (!['entregue', 'devolvida'].includes(resultado_entrega)) {
      await removerFoto(req.file);
      return res.status(400).json({
        erro: 'Selecione se a entrega foi realizada ou devolvida.',
      });
    }

    let fotoUrl = null;
    const comentarioSeguro =
      typeof comentario === 'string' && comentario.trim()
        ? comentario.trim()
        : null;

    try {
      fotoUrl = await salvarFoto(req.file);
      const resultado = await banco.query(
        `UPDATE entregas
         SET status = 'entregue',
             resultado_entrega = $1,
             comentario = $2,
             foto_url = $3,
             entregue_em = NOW()
         WHERE id = $4 AND status = 'pendente' AND motorista = $5
           AND rota_enviada = TRUE
           AND EXISTS (
             SELECT 1 FROM usuarios u
             WHERE u.id = $6 AND u.rota_iniciada_em IS NOT NULL
               AND u.rota_finalizada_em IS NULL
               AND (u.rota_iniciada_em AT TIME ZONE 'America/Sao_Paulo')::date =
                   (NOW() AT TIME ZONE 'America/Sao_Paulo')::date
           )
         RETURNING *`,
        [
          resultado_entrega,
          comentarioSeguro,
          fotoUrl,
          id,
          req.usuario.nome,
          req.usuario.id,
        ]
      );

      if (resultado.rowCount === 0) {
        await removerFoto(req.file);
        await removerFotoSalva(fotoUrl);

        const existente = await banco.query(
          'SELECT * FROM entregas WHERE id = $1',
          [id]
        );

        if (existente.rowCount === 0) {
          return res.status(404).json({
            erro: 'Entrega não encontrada.',
          });
        }

        if (
          existente.rows[0].motorista === req.usuario.nome &&
          existente.rows[0].status === 'entregue'
        ) {
          return res.json({ ...existente.rows[0], sincronizado_anteriormente: true });
        }

        return res.status(409).json({ erro: 'Inicie a rota antes de registrar paradas. Se ela já foi iniciada, atualize a lista e tente novamente.' });
      }

      const restantes = await banco.query(
        `SELECT COUNT(*)::int AS total FROM entregas
         WHERE motorista = $1 AND status = 'pendente' AND rota_enviada = TRUE`,
        [req.usuario.nome]
      );
      if (!restantes.rows[0].total) {
        await banco.query(
          `UPDATE usuarios SET rota_finalizada_em = NOW()
           WHERE id = $1 AND rota_iniciada_em IS NOT NULL AND rota_finalizada_em IS NULL`,
          [req.usuario.id]
        );
      }

      res.json(resultado.rows[0]);
    } catch (erro) {
      await removerFoto(req.file);
      await removerFotoSalva(fotoUrl);
      console.error('Falha ao finalizar a entrega:', erro.message);
      res.status(500).json({
        erro: 'Não foi possível finalizar a entrega.',
      });
    }
  }
);

async function iniciarServidor() {
  await banco.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      nome TEXT NOT NULL,
      usuario TEXT NOT NULL UNIQUE,
      senha_hash TEXT NOT NULL,
      senha_salt TEXT NOT NULL,
      papel TEXT NOT NULL CHECK (papel IN ('master', 'roteirizador', 'motorista')),
      ativo BOOLEAN NOT NULL DEFAULT TRUE,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await banco.query(`
    CREATE TABLE IF NOT EXISTS entregas (
      id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      cliente TEXT NOT NULL,
      endereco TEXT NOT NULL,
      latitude DOUBLE PRECISION NOT NULL,
      longitude DOUBLE PRECISION NOT NULL,
      motorista TEXT,
      status TEXT NOT NULL DEFAULT 'pendente',
      resultado_entrega TEXT,
      comentario TEXT,
      foto_url TEXT,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      entregue_em TIMESTAMPTZ,
      rota_enviada BOOLEAN NOT NULL DEFAULT FALSE,
      rota_id UUID
    )
  `);

  await banco.query('ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS rota_iniciada_em TIMESTAMPTZ');
  await banco.query('ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS rota_finalizada_em TIMESTAMPTZ');
  await banco.query('ALTER TABLE entregas ADD COLUMN IF NOT EXISTS rota_enviada BOOLEAN NOT NULL DEFAULT TRUE');
  await banco.query('ALTER TABLE entregas ALTER COLUMN rota_enviada SET DEFAULT FALSE');
  await banco.query('ALTER TABLE entregas ALTER COLUMN motorista DROP NOT NULL');
  await banco.query('ALTER TABLE entregas ADD COLUMN IF NOT EXISTS rota_id UUID');
  await banco.query('CREATE INDEX IF NOT EXISTS entregas_rota_pendente_idx ON entregas (motorista, status, rota_enviada)');

  app.listen(porta, () => {
    console.log(`Servidor disponível em http://localhost:${porta}`);
    console.log('Tabela de usuários pronta para o primeiro acesso.');
  });
}

iniciarServidor().catch((erro) => {
  console.error('Não foi possível iniciar o servidor:', erro.message);
  process.exitCode = 1;
});
