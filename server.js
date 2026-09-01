const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  usuarios,
  params,
  impressoras,
  filamentos,
  catalogoCores,
  movimentacoesEstoque,
  produtos,
  variacoes,
  clientes,
  contasFinanceiras,
  socios,
  movimentacoesFinanceiras,
  pagamentosPedido,
  contasAPagar,
  parcelasContaAPagar,
  pedidos,
  itens
} = require('./lib/db');
const { calcularPrecificacao } = require('./lib/pricing');
const { hashPassword, verifyPassword } = require('./lib/auth');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOADS_DIR = path.join(__dirname, 'data', 'uploads');
const SESSION_COOKIE = 'sid';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const sessions = new Map(); // token -> { usuarioId, criadoEm }
const COOKIE_SECURE = process.env.NODE_ENV === 'production' ? '; Secure' : '';

const LOGIN_MAX_TENTATIVAS = 8;
const LOGIN_JANELA_MS = 10 * 60 * 1000; // 10 minutos
const loginTentativas = new Map(); // "ip|email" -> { count, primeiraEm }

function loginBloqueado(chave) {
  const registro = loginTentativas.get(chave);
  if (!registro) return false;
  if (Date.now() - registro.primeiraEm > LOGIN_JANELA_MS) {
    loginTentativas.delete(chave);
    return false;
  }
  return registro.count >= LOGIN_MAX_TENTATIVAS;
}
function registrarTentativaFalha(chave) {
  const registro = loginTentativas.get(chave);
  if (!registro || Date.now() - registro.primeiraEm > LOGIN_JANELA_MS) {
    loginTentativas.set(chave, { count: 1, primeiraEm: Date.now() });
  } else {
    registro.count += 1;
  }
}
function limparTentativas(chave) {
  loginTentativas.delete(chave);
}

const FORMA_PAGAMENTO = ['Pix', 'Dinheiro', 'Cartão de Crédito', 'Cartão de Débito'];
const CATEGORIAS_SAIDA = ['Filamento', 'Material de embalagem', 'Despesas Gerais', 'Impressora 3D', 'Frete para cliente', 'Ferramentas de marketing', 'Anúncios pagos', 'Aluguel', 'Outro'];
const CATEGORIAS_ENTRADA = ['Aporte de sócio', 'Outro'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
};

function sendJSON(res, status, data, extraHeaders) {
  const body = JSON.stringify(data);
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, extraHeaders || {}));
  res.end(body);
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const cookies = {};
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    if (key) cookies[key] = decodeURIComponent(val);
  });
  return cookies;
}

const MAX_BODY_BYTES = 8 * 1024 * 1024; // 8MB — cobre upload de imagem em base64 com folga

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('Corpo da requisição excede o limite permitido'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (size > MAX_BODY_BYTES) return;
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks)));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  if (pathname.startsWith('/uploads/')) {
    const filePath = path.join(UPLOADS_DIR, pathname.slice('/uploads/'.length));
    if (!filePath.startsWith(UPLOADS_DIR)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    return fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('Not found');
      }
      const ext = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(data);
    });
  }
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(PUBLIC_DIR, filePath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function findItem(pedido, itemId) {
  return pedido.itens.find((it) => it.id === Number(itemId));
}
// Um pedido com pagamento parcial ou total registrado não pode ter seus itens alterados — mudar
// preço/quantidade/composição por baixo de um pagamento já feito é o tipo de bug que desalinha o
// valor cobrado do valor realmente recebido. Precisa estornar o pagamento primeiro.
function pedidoTemPagamentoAtivo(pedido) {
  return pedido.statusPagamento !== 'pendente';
}
const ERRO_PAGAMENTO_ATIVO = 'Este pedido já tem pagamento registrado — estorne o pagamento antes de alterar os produtos.';
function checkOrcamentoCompleto(pedido) {
  if (pedido.status === 'novo' && pedido.itens.every((it) => it.status !== 'novo')) {
    pedido.status = 'orcamento_pronto';
  }
}
// Valida um array bruto [{filamentoId, pesoGramas}, ...] e resolve cada filamento — 400 (via
// retorno null) se o array for vazio ou algum filamentoId não existir. Usado por toda rota que
// recebe um orçamento com múltiplos filamentos.
function resolverFilamentosDoOrcamento(filamentosInput) {
  if (!Array.isArray(filamentosInput) || filamentosInput.length === 0) return null;
  const resolvidos = [];
  for (const f of filamentosInput) {
    const filamento = filamentos.findById(f.filamentoId);
    if (!filamento || !f.pesoGramas || Number(f.pesoGramas) <= 0) return null;
    resolvidos.push({ filamentoId: filamento.id, pesoGramas: Number(f.pesoGramas), precoPorKg: filamento.precoPorKg });
  }
  return resolvidos;
}
// Monta o objeto orcamento a partir dos dados brutos de um item (peso/tempo/filamentos/margem) —
// mesmo cálculo usado tanto ao orçar um item já salvo quanto ao orçar direto na criação do pedido.
// Assume que `filamentosResolvidos` já foi validado pelo chamador (resolverFilamentosDoOrcamento).
function montarOrcamento(body, filamentosResolvidos) {
  const impressora = body.impressoraId ? impressoras.findById(body.impressoraId) : null;
  const potenciaW = body.potenciaW ? Number(body.potenciaW) : (impressora ? impressora.potenciaW : 200);
  const paramsAtuais = params.get();
  const tarifaKwh = body.tarifaKwh !== undefined && body.tarifaKwh !== '' ? Number(body.tarifaKwh) : paramsAtuais.tarifaKwh;
  const margemPercentual = body.margemPercentual !== undefined && body.margemPercentual !== '' ? Number(body.margemPercentual) : paramsAtuais.margemPadrao;

  const calc = calcularPrecificacao({
    filamentos: filamentosResolvidos,
    tempoHoras: body.tempoHoras,
    potenciaW,
    tarifaKwh,
    margemPercentual,
    margemFixa: body.margemFixa
  });

  return {
    filamentos: filamentosResolvidos.map((f) => ({ filamentoId: f.filamentoId, pesoGramas: f.pesoGramas })),
    tempoHoras: Number(body.tempoHoras),
    impressoraSugeridaId: impressora ? impressora.id : null,
    potenciaW,
    tarifaKwh,
    margemPercentual: body.margemFixa ? null : margemPercentual,
    margemFixa: body.margemFixa ? Number(body.margemFixa) : null,
    ...calc,
    validadeOrcamento: body.validadeOrcamento || null,
    criadoEm: new Date().toISOString()
  };
}
// Usado ao criar pedido/item já com orçamento embutido: se os dados vierem incompletos ou algum
// filamento for inválido, simplesmente trata como "ainda não orçado" em vez de dar erro — orçar
// na criação é opcional, só quem preencheu tudo ganha o cálculo.
function orcamentoEStatusDoInput(orcamentoInput) {
  if (!orcamentoInput || !orcamentoInput.tempoHoras) return { orcamento: null, status: 'novo' };
  const filamentosResolvidos = resolverFilamentosDoOrcamento(orcamentoInput.filamentos);
  if (!filamentosResolvidos) return { orcamento: null, status: 'novo' };
  return { orcamento: montarOrcamento(orcamentoInput, filamentosResolvidos), status: 'orcamento_pronto' };
}
// Um orçamento salvo antes da mudança pra múltiplos filamentos ainda tem o formato antigo
// (filamentoId/pesoGramas singulares, sem `filamentos`) — trata como lista de 1 item.
function filamentosDoOrcamento(orcamento) {
  if (!orcamento) return [];
  if (orcamento.filamentos) return orcamento.filamentos;
  if (orcamento.filamentoId) return [{ filamentoId: orcamento.filamentoId, pesoGramas: orcamento.pesoGramas }];
  return [];
}
// Se um item orçado pertence a um produto do catálogo e tem um texto de variação, mantém o
// catálogo de variações daquele produto atualizado com os dados do orçamento — evita ter que
// cadastrar a variação de novo manualmente em Produtos toda vez que ela é usada num pedido.
// O catálogo de variações continua single-filamento: grava o primeiro filamento da lista e a
// soma dos pesos, só como valor de partida pra próxima vez.
function sincronizarVariacaoDoItem({ produtoId, variacao, orcamento }) {
  if (!produtoId || !variacao || !variacao.trim() || !orcamento) return;
  const filamentosOrc = filamentosDoOrcamento(orcamento);
  if (!filamentosOrc.length) return;
  const nomeNormalizado = variacao.trim().toLowerCase();
  const existente = variacoes.porProduto(produtoId).find((v) => v.nome.trim().toLowerCase() === nomeNormalizado);
  const dados = {
    pesoGramas: filamentosOrc.reduce((s, f) => s + f.pesoGramas, 0),
    tempoHoras: orcamento.tempoHoras,
    filamentoIdSugerido: filamentosOrc[0].filamentoId,
    impressoraIdSugerida: orcamento.impressoraSugeridaId,
    precoVenda: orcamento.precoVenda
  };
  if (existente) {
    variacoes.update(existente.id, dados);
  } else {
    variacoes.insert({ produtoId, nome: variacao.trim(), ...dados });
  }
}
function saveImagemBase64(dataUrl, filenameBase) {
  const match = /^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/.exec(dataUrl || '');
  if (!match) return null;
  const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  const filename = `${filenameBase}.${ext}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, filename), Buffer.from(match[2], 'base64'));
  return `/uploads/${filename}`;
}
function recomputeStatusProducao(pedido) {
  if (!['na_fila', 'imprimindo', 'concluido'].includes(pedido.status)) return;
  const statuses = pedido.itens.map((it) => it.status);
  if (statuses.every((s) => s === 'concluido')) pedido.status = 'concluido';
  else if (statuses.some((s) => s === 'imprimindo' || s === 'concluido')) pedido.status = 'imprimindo';
  else pedido.status = 'na_fila';
}
// Cria o lançamento inverso de uma movimentação financeira e corrige o saldo da conta — usado
// tanto pra estorno manual de movimentações quanto pra desfazer um pagamento de pedido.
function estornarMovimentacao(movimentacaoId) {
  const original = movimentacoesFinanceiras.findById(movimentacaoId);
  if (!original || original.estornado) return;
  const tipoInverso = original.tipo === 'entrada' ? 'saida' : 'entrada';
  const estorno = movimentacoesFinanceiras.insert({
    tipo: tipoInverso,
    valor: original.valor,
    contaId: original.contaId,
    formaPagamento: original.formaPagamento,
    categoria: original.categoria,
    categoriaDetalhe: original.categoriaDetalhe,
    descricao: `Estorno de #${original.id}: ${original.descricao}`,
    pedidoId: original.pedidoId,
    responsavelId: original.responsavelId,
    reembolsado: false,
    reembolsoId: null,
    estornado: false,
    estornoDe: original.id,
    data: new Date().toISOString(),
    criadoEm: new Date().toISOString()
  });
  if (original.contaId) contasFinanceiras.ajustarSaldo(original.contaId, tipoInverso === 'entrada' ? estorno.valor : -estorno.valor);
  movimentacoesFinanceiras.marcarEstornado(original.id);
}
// Soma o preço dos itens já orçados de um pedido — fonte de verdade do valor total, usada tanto
// pra validar pagamentos quanto pra decidir se o pedido já está totalmente pago.
function calcularValorPedido(pedido) {
  return pedido.itens.reduce((s, it) => s + (it.orcamento ? it.orcamento.precoVenda * it.quantidade : 0), 0);
}
// Recalcula pendente/parcial/pago a partir da soma dos pagamentos não estornados do pedido
// e persiste. Chamado depois de qualquer registro ou estorno de pagamento.
function recomputeStatusPagamento(pedido) {
  const total = calcularValorPedido(pedido);
  const pago = pedido.pagamentos.filter((p) => !p.estornado).reduce((s, p) => s + p.valor, 0);
  const status = pago <= 0.001 ? 'pendente' : pago >= total - 0.01 ? 'pago' : 'parcial';
  pedido.statusPagamento = status;
  pedidos.update(pedido.id, { statusPagamento: status });
}
// Estorna todos os pagamentos ainda não estornados de um pedido — usado ao excluir o pedido.
function estornarTodosPagamentosDoPedido(pedido) {
  pedido.pagamentos.filter((p) => !p.estornado).forEach((p) => {
    estornarMovimentacao(p.movimentacaoFinanceiraId);
    pagamentosPedido.marcarEstornado(p.id);
  });
}

async function api(req, res, pathname, query) {
  const parts = pathname.split('/').filter(Boolean); // ['api', 'pedidos', '12', 'orcamento']

  try {
    // ---------- AUTENTICAÇÃO ----------
    if (parts[1] === 'auth' && parts[2] === 'login' && req.method === 'POST') {
      const body = await readBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      const ip = req.socket.remoteAddress || '';
      const chaveTentativa = `${ip}|${email}`;
      if (loginBloqueado(chaveTentativa)) {
        return sendJSON(res, 429, { error: 'Muitas tentativas de login. Aguarde alguns minutos e tente novamente.' });
      }
      const usuario = usuarios.findByEmail(email);
      if (!usuario || !verifyPassword(body.senha || '', usuario.senhaSalt, usuario.senhaHash)) {
        registrarTentativaFalha(chaveTentativa);
        return sendJSON(res, 401, { error: 'E-mail ou senha inválidos' });
      }
      limparTentativas(chaveTentativa);
      const token = crypto.randomBytes(24).toString('hex');
      sessions.set(token, { usuarioId: usuario.id, criadoEm: Date.now() });
      return sendJSON(res, 200, { id: usuario.id, nome: usuario.nome, email: usuario.email }, {
        'Set-Cookie': `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${COOKIE_SECURE}`
      });
    }

    const sessionToken = parseCookies(req)[SESSION_COOKIE];
    const session = sessionToken && sessions.get(sessionToken);
    const sessionValida = session && Date.now() - session.criadoEm <= SESSION_TTL_MS;
    if (!sessionValida && sessionToken) sessions.delete(sessionToken);
    const usuarioAtual = sessionValida ? usuarios.findById(session.usuarioId) : null;

    if (!usuarioAtual) {
      return sendJSON(res, 401, { error: 'Não autenticado' });
    }

    if (parts[1] === 'auth' && parts[2] === 'logout' && req.method === 'POST') {
      if (sessionToken) sessions.delete(sessionToken);
      return sendJSON(res, 200, { ok: true }, {
        'Set-Cookie': `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${COOKIE_SECURE}`
      });
    }
    if (parts[1] === 'auth' && parts[2] === 'me' && req.method === 'GET') {
      return sendJSON(res, 200, { id: usuarioAtual.id, nome: usuarioAtual.nome, email: usuarioAtual.email, papel: usuarioAtual.papel });
    }

    // ---------- USUÁRIOS ----------
    if (parts[1] === 'usuarios' && parts.length === 2 && req.method === 'GET') {
      return sendJSON(res, 200, usuarios.all().map((u) => ({ id: u.id, nome: u.nome, email: u.email, papel: u.papel, createdAt: u.createdAt })));
    }
    if (parts[1] === 'usuarios' && parts.length === 2 && req.method === 'POST') {
      if (usuarioAtual.papel !== 'admin') {
        return sendJSON(res, 403, { error: 'Apenas administradores podem cadastrar novos usuários' });
      }
      const body = await readBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      if (!body.senha || String(body.senha).length < 6) {
        return sendJSON(res, 400, { error: 'Senha deve ter ao menos 6 caracteres' });
      }
      if (!email || usuarios.findByEmail(email)) {
        return sendJSON(res, 400, { error: 'Já existe um usuário com esse e-mail' });
      }
      const { salt, hash } = hashPassword(body.senha);
      const usuario = usuarios.insert({
        nome: body.nome || '',
        email: body.email || '',
        senhaSalt: salt,
        senhaHash: hash,
        papel: body.papel === 'admin' ? 'admin' : 'vendas',
        createdAt: new Date().toISOString()
      });
      return sendJSON(res, 201, { id: usuario.id, nome: usuario.nome, email: usuario.email, papel: usuario.papel, createdAt: usuario.createdAt });
    }
    if (parts[1] === 'usuarios' && parts[3] === 'senha' && req.method === 'PATCH') {
      const usuario = usuarios.findById(parts[2]);
      if (!usuario) return sendJSON(res, 404, { error: 'Usuário não encontrado' });
      if (usuario.id !== usuarioAtual.id) return sendJSON(res, 403, { error: 'Só é possível alterar a própria senha' });
      const body = await readBody(req);
      if (!body.senhaNova || String(body.senhaNova).length < 6) {
        return sendJSON(res, 400, { error: 'Senha deve ter ao menos 6 caracteres' });
      }
      const { salt, hash } = hashPassword(body.senhaNova);
      usuarios.updateSenha(usuario.id, { senhaSalt: salt, senhaHash: hash });
      return sendJSON(res, 200, { id: usuario.id, nome: usuario.nome, email: usuario.email });
    }

    // ---------- PARAMS ----------
    if (parts[1] === 'params' && req.method === 'GET') {
      return sendJSON(res, 200, params.get());
    }
    if (parts[1] === 'params' && req.method === 'PATCH') {
      const body = await readBody(req);
      return sendJSON(res, 200, params.update(body));
    }

    // ---------- IMPRESSORAS ----------
    if (parts[1] === 'impressoras' && req.method === 'GET') {
      return sendJSON(res, 200, impressoras.all());
    }
    if (parts[1] === 'impressoras' && req.method === 'POST') {
      const body = await readBody(req);
      const item = impressoras.insert({ nome: body.nome, potenciaW: Number(body.potenciaW), ativa: true });
      return sendJSON(res, 201, item);
    }
    if (parts[1] === 'impressoras' && parts.length === 3 && req.method === 'PATCH') {
      const existente = impressoras.findById(parts[2]);
      if (!existente) return sendJSON(res, 404, { error: 'Impressora não encontrada' });
      const body = await readBody(req);
      if (body.potenciaW !== undefined) body.potenciaW = Number(body.potenciaW);
      return sendJSON(res, 200, impressoras.update(existente.id, body));
    }
    if (parts[1] === 'impressoras' && parts.length === 3 && req.method === 'DELETE') {
      const existente = impressoras.findById(parts[2]);
      if (!existente) return sendJSON(res, 404, { error: 'Impressora não encontrada' });
      impressoras.remove(existente.id);
      return sendJSON(res, 200, { ok: true });
    }

    // ---------- FILAMENTOS ----------
    if (parts[1] === 'filamentos' && parts.length === 2 && req.method === 'GET') {
      return sendJSON(res, 200, filamentos.all());
    }
    if (parts[1] === 'filamentos' && parts.length === 2 && req.method === 'POST') {
      const body = await readBody(req);
      const item = filamentos.insert({
        material: body.material,
        marca: body.marca || '',
        cor: body.cor,
        corHex: body.corHex || '',
        precoPorKg: Number(body.precoPorKg),
        pesoRoloGramas: Number(body.pesoRoloGramas || 1000),
        estoqueAtualGramas: Number(body.estoqueAtualGramas || 0),
        estoqueMinimoGramas: Number(body.estoqueMinimoGramas || 200)
      });
      return sendJSON(res, 201, item);
    }
    if (parts[1] === 'filamentos' && parts[3] === 'entrada' && req.method === 'PATCH') {
      const item = filamentos.findById(parts[2]);
      if (!item) return sendJSON(res, 404, { error: 'Filamento não encontrado' });
      const body = await readBody(req);
      const gramas = Number(body.gramas || 0);
      filamentos.ajustarEstoque(item.id, gramas);
      if (body.novoPrecoPorKg) filamentos.update(item.id, { precoPorKg: Number(body.novoPrecoPorKg) });
      movimentacoesEstoque.insert({
        filamentoId: item.id,
        tipo: 'entrada',
        gramas,
        data: new Date().toISOString(),
        obs: body.obs || 'Compra de filamento'
      });
      return sendJSON(res, 200, filamentos.findById(item.id));
    }
    if (parts[1] === 'filamentos' && parts.length === 3 && req.method === 'PATCH') {
      const item = filamentos.findById(parts[2]);
      if (!item) return sendJSON(res, 404, { error: 'Filamento não encontrado' });
      const body = await readBody(req);
      if (body.precoPorKg !== undefined) body.precoPorKg = Number(body.precoPorKg);
      if (body.pesoRoloGramas !== undefined) body.pesoRoloGramas = Number(body.pesoRoloGramas);
      if (body.estoqueMinimoGramas !== undefined) body.estoqueMinimoGramas = Number(body.estoqueMinimoGramas);
      return sendJSON(res, 200, filamentos.update(item.id, body));
    }

    // ---------- CATÁLOGO DE CORES (referência, não é estoque) ----------
    if (parts[1] === 'catalogo-cores' && parts.length === 2 && req.method === 'GET') {
      return sendJSON(res, 200, catalogoCores.all());
    }
    if (parts[1] === 'catalogo-cores' && parts.length === 2 && req.method === 'POST') {
      const body = await readBody(req);
      const item = catalogoCores.insert({
        material: body.material,
        marca: body.marca || '',
        cor: body.cor,
        corHex: body.corHex || ''
      });
      return sendJSON(res, 201, item);
    }
    if (parts[1] === 'catalogo-cores' && parts.length === 3 && req.method === 'PATCH') {
      const item = catalogoCores.findById(parts[2]);
      if (!item) return sendJSON(res, 404, { error: 'Cor de catálogo não encontrada' });
      const body = await readBody(req);
      return sendJSON(res, 200, catalogoCores.update(item.id, body));
    }
    if (parts[1] === 'catalogo-cores' && parts.length === 3 && req.method === 'DELETE') {
      const item = catalogoCores.findById(parts[2]);
      if (!item) return sendJSON(res, 404, { error: 'Cor de catálogo não encontrada' });
      catalogoCores.remove(item.id);
      return sendJSON(res, 200, { ok: true });
    }

    // ---------- PRODUTOS ----------
    if (parts[1] === 'produtos' && parts.length === 2 && req.method === 'GET') {
      return sendJSON(res, 200, produtos.all());
    }
    if (parts[1] === 'produtos' && parts.length === 2 && req.method === 'POST') {
      const body = await readBody(req);
      let produto = produtos.insert({
        nome: body.nome || '',
        descricao: body.descricao || '',
        dimensoes: body.dimensoes || '',
        corFilamento: body.corFilamento || '',
        modeloRef: body.modeloRef || '',
        imagem: null,
        createdAt: new Date().toISOString()
      });
      if (body.imagemBase64) {
        const imagem = saveImagemBase64(body.imagemBase64, `produto-${produto.id}`);
        produto = produtos.update(produto.id, { imagem });
      }
      return sendJSON(res, 201, produto);
    }
    if (parts[1] === 'produtos' && parts.length === 3 && req.method === 'PATCH') {
      const produto = produtos.findById(parts[2]);
      if (!produto) return sendJSON(res, 404, { error: 'Produto não encontrado' });
      const body = await readBody(req);
      if (body.imagemBase64) body.imagem = saveImagemBase64(body.imagemBase64, `produto-${produto.id}`);
      delete body.imagemBase64;
      return sendJSON(res, 200, produtos.update(produto.id, body));
    }

    // ---------- VARIAÇÕES ----------
    if (parts[1] === 'variacoes' && parts.length === 2 && req.method === 'GET') {
      if (query.produtoId) return sendJSON(res, 200, variacoes.porProduto(query.produtoId));
      return sendJSON(res, 200, variacoes.all());
    }
    if (parts[1] === 'variacoes' && parts.length === 2 && req.method === 'POST') {
      const body = await readBody(req);
      const produto = produtos.findById(body.produtoId);
      if (!produto) return sendJSON(res, 400, { error: 'Produto inválido' });
      const variacao = variacoes.insert({
        produtoId: produto.id,
        nome: body.nome || '',
        descricao: body.descricao || '',
        modeloRef: body.modeloRef || '',
        dimensoes: body.dimensoes || '',
        pesoGramas: body.pesoGramas,
        tempoHoras: body.tempoHoras,
        filamentoIdSugerido: body.filamentoIdSugerido,
        impressoraIdSugerida: body.impressoraIdSugerida,
        precoVenda: body.precoVenda
      });
      return sendJSON(res, 201, variacao);
    }
    if (parts[1] === 'variacoes' && parts.length === 3 && req.method === 'PATCH') {
      const variacao = variacoes.findById(parts[2]);
      if (!variacao) return sendJSON(res, 404, { error: 'Variação não encontrada' });
      const body = await readBody(req);
      return sendJSON(res, 200, variacoes.update(variacao.id, body));
    }
    if (parts[1] === 'variacoes' && parts.length === 3 && req.method === 'DELETE') {
      const variacao = variacoes.findById(parts[2]);
      if (!variacao) return sendJSON(res, 404, { error: 'Variação não encontrada' });
      variacoes.remove(variacao.id);
      return sendJSON(res, 200, { ok: true });
    }

    // ---------- CLIENTES ----------
    if (parts[1] === 'clientes' && parts.length === 2 && req.method === 'GET') {
      return sendJSON(res, 200, clientes.all());
    }
    if (parts[1] === 'clientes' && parts.length === 2 && req.method === 'POST') {
      const body = await readBody(req);
      const cliente = clientes.insert({
        nome: body.nome || '',
        contato: body.contato || '',
        email: body.email || '',
        endereco: body.endereco || '',
        observacoes: body.observacoes || '',
        createdAt: new Date().toISOString()
      });
      return sendJSON(res, 201, cliente);
    }
    if (parts[1] === 'clientes' && parts.length === 3 && req.method === 'PATCH') {
      const cliente = clientes.findById(parts[2]);
      if (!cliente) return sendJSON(res, 404, { error: 'Cliente não encontrado' });
      const body = await readBody(req);
      return sendJSON(res, 200, clientes.update(cliente.id, body));
    }

    // ---------- CONTAS FINANCEIRAS ----------
    if (parts[1] === 'contas-financeiras' && parts.length === 2 && req.method === 'GET') {
      return sendJSON(res, 200, contasFinanceiras.all());
    }
    if (parts[1] === 'contas-financeiras' && parts.length === 2 && req.method === 'POST') {
      const body = await readBody(req);
      const conta = contasFinanceiras.insert({
        nome: body.nome || '',
        tipo: body.tipo || 'outro',
        saldoInicial: Number(body.saldoInicial || 0)
      });
      return sendJSON(res, 201, conta);
    }
    if (parts[1] === 'contas-financeiras' && parts.length === 3 && req.method === 'PATCH') {
      const conta = contasFinanceiras.findById(parts[2]);
      if (!conta) return sendJSON(res, 404, { error: 'Conta não encontrada' });
      const body = await readBody(req);
      const patch = {};
      if (body.nome !== undefined) patch.nome = body.nome;
      if (body.tipo !== undefined) patch.tipo = body.tipo;
      return sendJSON(res, 200, contasFinanceiras.update(conta.id, patch));
    }

    // ---------- SÓCIOS ----------
    if (parts[1] === 'socios' && parts.length === 2 && req.method === 'GET') {
      return sendJSON(res, 200, socios.all());
    }
    if (parts[1] === 'socios' && parts.length === 2 && req.method === 'POST') {
      const body = await readBody(req);
      return sendJSON(res, 201, socios.insert({ nome: body.nome || '' }));
    }
    if (parts[1] === 'socios' && parts.length === 3 && req.method === 'PATCH') {
      const socio = socios.findById(parts[2]);
      if (!socio) return sendJSON(res, 404, { error: 'Sócio não encontrado' });
      const body = await readBody(req);
      const patch = {};
      if (body.nome !== undefined) patch.nome = body.nome;
      return sendJSON(res, 200, socios.update(socio.id, patch));
    }

    // ---------- MOVIMENTAÇÕES FINANCEIRAS ----------
    if (parts[1] === 'movimentacoes-financeiras' && parts.length === 2 && req.method === 'GET') {
      return sendJSON(res, 200, movimentacoesFinanceiras.all(query));
    }
    if (parts[1] === 'movimentacoes-financeiras' && parts.length === 2 && req.method === 'POST') {
      const body = await readBody(req);
      if (body.tipo !== 'entrada' && body.tipo !== 'saida') {
        return sendJSON(res, 400, { error: 'Tipo inválido' });
      }
      const valor = Number(body.valor);
      if (!valor || valor <= 0) return sendJSON(res, 400, { error: 'Valor inválido' });
      if (!FORMA_PAGAMENTO.includes(body.formaPagamento)) {
        return sendJSON(res, 400, { error: 'Forma de pagamento inválida' });
      }
      const categoriasValidas = body.tipo === 'saida' ? CATEGORIAS_SAIDA : CATEGORIAS_ENTRADA;
      if (!categoriasValidas.includes(body.categoria)) {
        return sendJSON(res, 400, { error: 'Categoria inválida' });
      }
      if (body.categoria === 'Outro' && !body.categoriaDetalhe) {
        return sendJSON(res, 400, { error: 'Descreva a categoria em "Outro"' });
      }
      const responsavelId = body.responsavelId ? Number(body.responsavelId) : null;
      if (responsavelId && body.contaId) {
        return sendJSON(res, 400, { error: 'Despesa paga por sócio não deve informar conta — vira dívida da empresa com o sócio até o reembolso' });
      }
      if (!responsavelId && !body.contaId) {
        return sendJSON(res, 400, { error: 'Informe a conta ou o sócio responsável pelo pagamento' });
      }
      const conta = body.contaId ? contasFinanceiras.findById(body.contaId) : null;
      if (body.contaId && !conta) return sendJSON(res, 400, { error: 'Conta inválida' });
      const socio = responsavelId ? socios.findById(responsavelId) : null;
      if (responsavelId && !socio) return sendJSON(res, 400, { error: 'Sócio inválido' });

      const mov = movimentacoesFinanceiras.insert({
        tipo: body.tipo,
        valor,
        contaId: conta ? conta.id : null,
        formaPagamento: body.formaPagamento,
        categoria: body.categoria,
        categoriaDetalhe: body.categoria === 'Outro' ? body.categoriaDetalhe : null,
        descricao: body.descricao || '',
        pedidoId: null,
        responsavelId: socio ? socio.id : null,
        reembolsado: false,
        reembolsoId: null,
        estornado: false,
        estornoDe: null,
        data: body.data ? new Date(body.data).toISOString() : new Date().toISOString(),
        criadoEm: new Date().toISOString()
      });
      if (conta) contasFinanceiras.ajustarSaldo(conta.id, mov.tipo === 'entrada' ? valor : -valor);
      return sendJSON(res, 201, mov);
    }
    if (parts[1] === 'movimentacoes-financeiras' && parts[3] === 'estorno' && req.method === 'POST') {
      const original = movimentacoesFinanceiras.findById(parts[2]);
      if (!original) return sendJSON(res, 404, { error: 'Movimentação não encontrada' });
      if (original.estornado) return sendJSON(res, 400, { error: 'Movimentação já estornada' });
      const tipoInverso = original.tipo === 'entrada' ? 'saida' : 'entrada';
      const estorno = movimentacoesFinanceiras.insert({
        tipo: tipoInverso,
        valor: original.valor,
        contaId: original.contaId,
        formaPagamento: original.formaPagamento,
        categoria: original.categoria,
        categoriaDetalhe: original.categoriaDetalhe,
        descricao: `Estorno de #${original.id}: ${original.descricao}`,
        pedidoId: original.pedidoId,
        responsavelId: original.responsavelId,
        reembolsado: false,
        reembolsoId: null,
        estornado: false,
        estornoDe: original.id,
        data: new Date().toISOString(),
        criadoEm: new Date().toISOString()
      });
      if (original.contaId) contasFinanceiras.ajustarSaldo(original.contaId, tipoInverso === 'entrada' ? estorno.valor : -estorno.valor);
      movimentacoesFinanceiras.marcarEstornado(original.id);
      // se essa movimentação era o pagamento de uma parcela de conta a pagar, desfaz a marcação —
      // sem isso a parcela ficaria "paga" apontando pra um pagamento que já foi estornado.
      const parcelaLigada = parcelasContaAPagar.findByMovimentacaoId(original.id);
      if (parcelaLigada) parcelasContaAPagar.marcarNaoPaga(parcelaLigada.id);
      return sendJSON(res, 201, estorno);
    }

    // ---------- CONTAS A PAGAR ----------
    if (parts[1] === 'contas-a-pagar' && parts.length === 2 && req.method === 'GET') {
      return sendJSON(res, 200, contasAPagar.all());
    }
    if (parts[1] === 'contas-a-pagar' && parts.length === 2 && req.method === 'POST') {
      const body = await readBody(req);
      if (!CATEGORIAS_SAIDA.includes(body.categoria)) {
        return sendJSON(res, 400, { error: 'Categoria inválida' });
      }
      if (body.categoria === 'Outro' && !body.categoriaDetalhe) {
        return sendJSON(res, 400, { error: 'Descreva a categoria em "Outro"' });
      }
      const valorParcela = Number(body.valorParcela);
      if (!valorParcela || valorParcela <= 0) return sendJSON(res, 400, { error: 'Valor da parcela inválido' });
      const quantidadeParcelas = Number(body.quantidadeParcelas);
      if (!Number.isInteger(quantidadeParcelas) || quantidadeParcelas < 1) {
        return sendJSON(res, 400, { error: 'Quantidade de parcelas inválida' });
      }
      if (!body.descricao) return sendJSON(res, 400, { error: 'Descrição obrigatória' });
      const primeiroVencimento = body.primeiroVencimento ? new Date(body.primeiroVencimento) : null;
      if (!primeiroVencimento || isNaN(primeiroVencimento.getTime())) {
        return sendJSON(res, 400, { error: 'Vencimento da 1ª parcela inválido' });
      }

      const conta = contasAPagar.insert({
        descricao: body.descricao,
        categoria: body.categoria,
        categoriaDetalhe: body.categoria === 'Outro' ? body.categoriaDetalhe : null
      });
      for (let i = 0; i < quantidadeParcelas; i++) {
        const vencimento = new Date(primeiroVencimento);
        vencimento.setUTCMonth(vencimento.getUTCMonth() + i);
        parcelasContaAPagar.insert({
          contaAPagarId: conta.id,
          numero: i + 1,
          totalParcelas: quantidadeParcelas,
          valor: valorParcela,
          vencimento: vencimento.toISOString()
        });
      }
      return sendJSON(res, 201, contasAPagar.findById(conta.id));
    }
    if (parts[1] === 'contas-a-pagar' && parts[3] === 'cancelar-restante' && req.method === 'PATCH') {
      const conta = contasAPagar.findById(parts[2]);
      if (!conta) return sendJSON(res, 404, { error: 'Conta a pagar não encontrada' });
      parcelasContaAPagar.cancelarPendentes(conta.id);
      return sendJSON(res, 200, contasAPagar.findById(conta.id));
    }
    if (parts[1] === 'contas-a-pagar' && parts.length === 3 && req.method === 'DELETE') {
      const conta = contasAPagar.findById(parts[2]);
      if (!conta) return sendJSON(res, 404, { error: 'Conta a pagar não encontrada' });
      if (conta.parcelas.some((p) => p.paga)) {
        return sendJSON(res, 400, { error: 'Já existe parcela paga — cancele as pendentes em vez de excluir' });
      }
      contasAPagar.remove(conta.id);
      return sendJSON(res, 200, { ok: true });
    }
    if (parts[1] === 'contas-a-pagar' && parts[2] === 'parcelas' && parts[4] === 'pagar' && req.method === 'PATCH') {
      const parcela = parcelasContaAPagar.findById(parts[3]);
      if (!parcela) return sendJSON(res, 404, { error: 'Parcela não encontrada' });
      if (parcela.paga) return sendJSON(res, 400, { error: 'Parcela já está paga' });
      if (parcela.cancelada) return sendJSON(res, 400, { error: 'Parcela cancelada' });
      const conta = contasAPagar.findById(parcela.contaAPagarId);
      const body = await readBody(req);
      const contaFinanceira = contasFinanceiras.findById(body.contaId);
      if (!contaFinanceira) return sendJSON(res, 400, { error: 'Conta financeira inválida' });
      if (!FORMA_PAGAMENTO.includes(body.formaPagamento)) {
        return sendJSON(res, 400, { error: 'Forma de pagamento inválida' });
      }
      const data = body.data ? new Date(body.data).toISOString() : new Date().toISOString();
      const mov = movimentacoesFinanceiras.insert({
        tipo: 'saida',
        valor: parcela.valor,
        contaId: contaFinanceira.id,
        formaPagamento: body.formaPagamento,
        categoria: conta.categoria,
        categoriaDetalhe: conta.categoriaDetalhe,
        descricao: `${conta.descricao} — parcela ${parcela.numero}/${parcela.totalParcelas}`,
        pedidoId: null,
        responsavelId: null,
        reembolsado: false,
        reembolsoId: null,
        estornado: false,
        estornoDe: null,
        data,
        criadoEm: new Date().toISOString()
      });
      contasFinanceiras.ajustarSaldo(contaFinanceira.id, -parcela.valor);
      parcelasContaAPagar.marcarPaga(parcela.id, { movimentacaoFinanceiraId: mov.id, dataPagamento: data });
      return sendJSON(res, 200, contasAPagar.findById(conta.id));
    }

    // ---------- TRANSFERÊNCIA ENTRE CONTAS ----------
    if (parts[1] === 'transferencias' && req.method === 'POST') {
      const body = await readBody(req);
      const contaOrigem = contasFinanceiras.findById(body.contaOrigemId);
      const contaDestino = contasFinanceiras.findById(body.contaDestinoId);
      if (!contaOrigem || !contaDestino) return sendJSON(res, 400, { error: 'Conta de origem ou destino inválida' });
      if (contaOrigem.id === contaDestino.id) return sendJSON(res, 400, { error: 'Conta de origem e destino não podem ser a mesma' });
      const valor = Number(body.valor);
      if (!valor || valor <= 0) return sendJSON(res, 400, { error: 'Valor inválido' });
      if (!FORMA_PAGAMENTO.includes(body.formaPagamento)) {
        return sendJSON(res, 400, { error: 'Forma de pagamento inválida' });
      }
      const data = body.data ? new Date(body.data).toISOString() : new Date().toISOString();
      const criadoEm = new Date().toISOString();

      const saida = movimentacoesFinanceiras.insert({
        tipo: 'saida',
        valor,
        contaId: contaOrigem.id,
        formaPagamento: body.formaPagamento,
        categoria: 'Outro',
        categoriaDetalhe: `Transferência para ${contaDestino.nome}`,
        descricao: body.descricao || `Transferência para ${contaDestino.nome}`,
        pedidoId: null,
        responsavelId: null,
        reembolsado: false,
        reembolsoId: null,
        estornado: false,
        estornoDe: null,
        data,
        criadoEm
      });
      const entrada = movimentacoesFinanceiras.insert({
        tipo: 'entrada',
        valor,
        contaId: contaDestino.id,
        formaPagamento: body.formaPagamento,
        categoria: 'Outro',
        categoriaDetalhe: `Transferência de ${contaOrigem.nome}`,
        descricao: body.descricao || `Transferência de ${contaOrigem.nome}`,
        pedidoId: null,
        responsavelId: null,
        reembolsado: false,
        reembolsoId: null,
        estornado: false,
        estornoDe: null,
        data,
        criadoEm
      });
      contasFinanceiras.ajustarSaldo(contaOrigem.id, -valor);
      contasFinanceiras.ajustarSaldo(contaDestino.id, valor);
      return sendJSON(res, 201, { saida, entrada });
    }

    // ---------- REEMBOLSO DE SÓCIO ----------
    if (parts[1] === 'socios' && parts[3] === 'reembolso' && req.method === 'POST') {
      const socio = socios.findById(parts[2]);
      if (!socio) return sendJSON(res, 404, { error: 'Sócio não encontrado' });
      const body = await readBody(req);
      const conta = contasFinanceiras.findById(body.contaId);
      if (!conta) return sendJSON(res, 400, { error: 'Conta inválida' });
      if (!FORMA_PAGAMENTO.includes(body.formaPagamento)) {
        return sendJSON(res, 400, { error: 'Forma de pagamento inválida' });
      }
      const ids = Array.isArray(body.movimentacaoIds) ? body.movimentacaoIds.map(Number) : [];
      const pendencias = movimentacoesFinanceiras.pendenciasSocio(socio.id, ids);
      if (!pendencias.length) return sendJSON(res, 400, { error: 'Nenhuma pendência válida selecionada' });
      const total = pendencias.reduce((s, m) => s + m.valor, 0);
      const reembolso = movimentacoesFinanceiras.insert({
        tipo: 'saida',
        valor: total,
        contaId: conta.id,
        formaPagamento: body.formaPagamento,
        categoria: 'Reembolso a sócio',
        categoriaDetalhe: null,
        descricao: body.descricao || `Reembolso a ${socio.nome}`,
        pedidoId: null,
        responsavelId: socio.id,
        reembolsado: false,
        reembolsoId: null,
        estornado: false,
        estornoDe: null,
        data: new Date().toISOString(),
        criadoEm: new Date().toISOString()
      });
      contasFinanceiras.ajustarSaldo(conta.id, -total);
      movimentacoesFinanceiras.marcarReembolsado(pendencias.map((m) => m.id), reembolso.id);
      return sendJSON(res, 201, reembolso);
    }

    // ---------- ALERTAS ----------
    if (parts[1] === 'alertas' && req.method === 'GET') {
      const orcamentosProntos = pedidos.all({ status: 'orcamento_pronto' });
      const estoqueBaixo = filamentos.all().filter((f) => f.estoqueAtualGramas <= f.estoqueMinimoGramas);
      const naFila = pedidos.all({ status: 'na_fila' });
      return sendJSON(res, 200, { orcamentosProntos, estoqueBaixo, naFila });
    }

    // ---------- PEDIDOS ----------
    if (parts[1] === 'pedidos' && parts.length === 2 && req.method === 'GET') {
      return sendJSON(res, 200, pedidos.all(query.status ? { status: query.status } : {}));
    }

    if (parts[1] === 'pedidos' && parts.length === 2 && req.method === 'POST') {
      const body = await readBody(req);
      const itensBody = Array.isArray(body.itens) ? body.itens : [];
      const itensMapeados = itensBody.map((it) => {
        const { orcamento, status } = orcamentoEStatusDoInput(it.orcamentoInput);
        return {
          produtoId: it.produtoId ? Number(it.produtoId) : null,
          pecaJaFeita: !!it.pecaJaFeita,
          modeloRef: it.modeloRef || '',
          descricao: it.descricao || '',
          dimensoes: it.dimensoes || '',
          variacao: it.variacao || '',
          corFilamento: it.corFilamento || '',
          imagem: it.imagem || null,
          quantidade: Number(it.quantidade || 1),
          status,
          orcamento
        };
      });
      const pedido = pedidos.insert({
        clienteId: body.clienteId ? Number(body.clienteId) : null,
        cliente: body.cliente || '',
        contato: body.contato || '',
        vendedor: body.vendedor || '',
        observacoes: body.observacoes || '',
        createdAt: new Date().toISOString(),
        status: itensMapeados.length && itensMapeados.every((it) => it.status !== 'novo') ? 'orcamento_pronto' : 'novo',
        statusPagamento: 'pendente',
        idPlataforma: body.idPlataforma || null,
        itens: itensMapeados
      });
      itensMapeados.forEach((it) => {
        if (it.orcamento) sincronizarVariacaoDoItem({ produtoId: it.produtoId, variacao: it.variacao, orcamento: it.orcamento });
      });
      return sendJSON(res, 201, pedido);
    }

    if (parts[1] === 'pedidos' && parts.length === 3 && req.method === 'GET') {
      const pedido = pedidos.findById(parts[2]);
      if (!pedido) return sendJSON(res, 404, { error: 'Pedido não encontrado' });
      return sendJSON(res, 200, pedido);
    }

    if (parts[1] === 'pedidos' && parts.length === 3 && req.method === 'PATCH') {
      const pedido = pedidos.findById(parts[2]);
      if (!pedido) return sendJSON(res, 404, { error: 'Pedido não encontrado' });
      const body = await readBody(req);
      const patch = {};
      if (body.cliente !== undefined) patch.cliente = body.cliente;
      if (body.clienteId !== undefined) patch.clienteId = body.clienteId ? Number(body.clienteId) : null;
      if (body.contato !== undefined) patch.contato = body.contato;
      if (body.vendedor !== undefined) patch.vendedor = body.vendedor;
      if (body.observacoes !== undefined) patch.observacoes = body.observacoes;
      if (body.idPlataforma !== undefined) patch.idPlataforma = body.idPlataforma || null;
      pedidos.update(pedido.id, patch);
      return sendJSON(res, 200, pedidos.findById(pedido.id));
    }

    if (parts[1] === 'pedidos' && parts.length === 3 && req.method === 'DELETE') {
      const pedido = pedidos.findById(parts[2]);
      if (!pedido) return sendJSON(res, 404, { error: 'Pedido não encontrado' });

      estornarTodosPagamentosDoPedido(pedido);

      pedido.itens.forEach((item) => {
        if (item.status === 'concluido' && item.orcamento) {
          filamentosDoOrcamento(item.orcamento).forEach((f) => {
            const filamento = filamentos.findById(f.filamentoId);
            if (!filamento) return;
            const gramas = f.pesoGramas * item.quantidade;
            filamentos.ajustarEstoque(filamento.id, gramas);
            movimentacoesEstoque.insert({
              filamentoId: filamento.id,
              tipo: 'entrada',
              gramas,
              data: new Date().toISOString(),
              obs: `Estoque devolvido — pedido #${pedido.id} (${pedido.cliente}) excluído`
            });
          });
        }
        itens.remove(item.id);
      });

      pedidos.remove(pedido.id);
      return sendJSON(res, 200, { ok: true });
    }

    if (parts[1] === 'pedidos' && parts[3] === 'itens' && parts.length === 5 && req.method === 'PATCH') {
      const pedido = pedidos.findById(parts[2]);
      if (!pedido) return sendJSON(res, 404, { error: 'Pedido não encontrado' });
      const item = findItem(pedido, parts[4]);
      if (!item) return sendJSON(res, 404, { error: 'Produto não encontrado' });
      if (pedidoTemPagamentoAtivo(pedido)) return sendJSON(res, 400, { error: ERRO_PAGAMENTO_ATIVO });
      const body = await readBody(req);
      const patch = {};
      if (body.descricao !== undefined) patch.descricao = body.descricao;
      if (body.dimensoes !== undefined) patch.dimensoes = body.dimensoes;
      if (body.variacao !== undefined) patch.variacao = body.variacao;
      if (body.corFilamento !== undefined) patch.corFilamento = body.corFilamento;
      if (body.modeloRef !== undefined) patch.modeloRef = body.modeloRef;
      if (body.quantidade !== undefined) patch.quantidade = Number(body.quantidade);
      if (body.produtoId !== undefined) patch.produtoId = body.produtoId ? Number(body.produtoId) : null;
      itens.update(item.id, patch);
      return sendJSON(res, 200, pedidos.findById(pedido.id));
    }

    if (parts[1] === 'pedidos' && parts[3] === 'itens' && parts.length === 4 && req.method === 'POST') {
      const pedido = pedidos.findById(parts[2]);
      if (!pedido) return sendJSON(res, 404, { error: 'Pedido não encontrado' });
      if (!['novo', 'orcamento_pronto'].includes(pedido.status)) {
        return sendJSON(res, 400, { error: 'Só é possível adicionar produtos antes da aprovação do pedido' });
      }
      if (pedidoTemPagamentoAtivo(pedido)) return sendJSON(res, 400, { error: ERRO_PAGAMENTO_ATIVO });
      const body = await readBody(req);
      const produtoId = body.produtoId ? Number(body.produtoId) : null;
      const variacaoTexto = body.variacao || '';
      const { orcamento, status } = orcamentoEStatusDoInput(body.orcamentoInput);
      itens.insert({
        pedidoId: pedido.id,
        produtoId,
        pecaJaFeita: !!body.pecaJaFeita,
        modeloRef: body.modeloRef || '',
        descricao: body.descricao || '',
        dimensoes: body.dimensoes || '',
        variacao: variacaoTexto,
        corFilamento: body.corFilamento || '',
        imagem: body.imagem || null,
        quantidade: Number(body.quantidade || 1),
        status,
        orcamento
      });
      if (orcamento) {
        sincronizarVariacaoDoItem({ produtoId, variacao: variacaoTexto, orcamento });
        const pedidoAtualizado = pedidos.findById(pedido.id);
        const statusAntes = pedidoAtualizado.status;
        checkOrcamentoCompleto(pedidoAtualizado);
        if (pedidoAtualizado.status !== statusAntes) pedidos.update(pedido.id, { status: pedidoAtualizado.status });
      } else if (pedido.status === 'orcamento_pronto') {
        pedidos.update(pedido.id, { status: 'novo' });
      }
      return sendJSON(res, 201, pedidos.findById(pedido.id));
    }

    if (parts[1] === 'pedidos' && parts[3] === 'itens' && parts.length === 5 && req.method === 'DELETE') {
      const pedido = pedidos.findById(parts[2]);
      if (!pedido) return sendJSON(res, 404, { error: 'Pedido não encontrado' });
      if (!['novo', 'orcamento_pronto'].includes(pedido.status)) {
        return sendJSON(res, 400, { error: 'Só é possível remover produtos antes da aprovação do pedido' });
      }
      if (pedidoTemPagamentoAtivo(pedido)) return sendJSON(res, 400, { error: ERRO_PAGAMENTO_ATIVO });
      const item = findItem(pedido, parts[4]);
      if (!item) return sendJSON(res, 404, { error: 'Produto não encontrado' });
      if (pedido.itens.length <= 1) {
        return sendJSON(res, 400, { error: 'O pedido precisa ter ao menos um produto' });
      }
      itens.remove(item.id);
      const pedidoAtualizado = pedidos.findById(pedido.id);
      const statusAntes = pedidoAtualizado.status;
      checkOrcamentoCompleto(pedidoAtualizado);
      if (pedidoAtualizado.status !== statusAntes) pedidos.update(pedidoAtualizado.id, { status: pedidoAtualizado.status });
      return sendJSON(res, 200, pedidos.findById(pedido.id));
    }

    if (parts[1] === 'pedidos' && parts[3] === 'itens' && parts[5] === 'orcamento' && req.method === 'PATCH') {
      const pedido = pedidos.findById(parts[2]);
      if (!pedido) return sendJSON(res, 404, { error: 'Pedido não encontrado' });
      const item = findItem(pedido, parts[4]);
      if (!item) return sendJSON(res, 404, { error: 'Produto não encontrado' });
      if (pedidoTemPagamentoAtivo(pedido)) return sendJSON(res, 400, { error: ERRO_PAGAMENTO_ATIVO });
      const body = await readBody(req);
      const filamentosResolvidos = resolverFilamentosDoOrcamento(body.filamentos);
      if (!filamentosResolvidos) return sendJSON(res, 400, { error: 'Filamento(s) inválido(s)' });

      item.orcamento = montarOrcamento(body, filamentosResolvidos);
      const patchItem = { orcamento: item.orcamento };
      // Só força o item de volta pra "orçamento pronto" se o pedido ainda não foi aprovado —
      // reorçar a peça de um pedido já em produção (pra corrigir preço, por ex.) não pode
      // tirar o item da fila/impressão/concluído em que ele já está.
      if (['novo', 'orcamento_pronto'].includes(pedido.status)) {
        item.status = 'orcamento_pronto';
        patchItem.status = item.status;
      } else if (!item.impressoraId && item.orcamento.impressoraSugeridaId) {
        // Item já aprovado/em produção sendo reorçado agora, sem impressora de produção
        // definida ainda — usa a sugestão do orçamento como atribuição real, mesma lógica
        // da aprovação (evita ter que escolher a mesma impressora de novo na Fila de produção).
        item.impressoraId = item.orcamento.impressoraSugeridaId;
        patchItem.impressoraId = item.impressoraId;
      }
      itens.update(item.id, patchItem);
      sincronizarVariacaoDoItem({ produtoId: item.produtoId, variacao: item.variacao, orcamento: item.orcamento });

      const statusAntes = pedido.status;
      checkOrcamentoCompleto(pedido);
      if (pedido.status !== statusAntes) pedidos.update(pedido.id, { status: pedido.status });

      return sendJSON(res, 200, pedido);
    }

    if (parts[1] === 'pedidos' && parts[3] === 'aprovacao' && req.method === 'PATCH') {
      const pedido = pedidos.findById(parts[2]);
      if (!pedido) return sendJSON(res, 404, { error: 'Pedido não encontrado' });
      const body = await readBody(req);
      if (body.decisao === 'aprovado') {
        pedido.status = 'na_fila';
        pedido.aprovadoEm = new Date().toISOString();
        pedido.formaPagamentoCombinada = body.formaPagamentoCombinada || '';
        pedido.itens.forEach((it) => {
          it.status = 'na_fila';
          const patch = { status: 'na_fila' };
          // A impressora sugerida no orçamento vira a atribuição real de produção — evita ter
          // que escolher a mesma impressora de novo na Fila de produção depois de aprovar.
          // Ainda pode ser trocada lá se a impressora sugerida não estiver disponível.
          if (!it.impressoraId && it.orcamento && it.orcamento.impressoraSugeridaId) {
            it.impressoraId = it.orcamento.impressoraSugeridaId;
            patch.impressoraId = it.impressoraId;
          }
          itens.update(it.id, patch);
        });
        pedidos.update(pedido.id, {
          status: pedido.status,
          aprovadoEm: pedido.aprovadoEm,
          formaPagamentoCombinada: pedido.formaPagamentoCombinada
        });
      } else if (body.decisao === 'recusado') {
        pedido.status = 'recusado';
        pedido.motivoRecusa = body.motivo || '';
        pedidos.update(pedido.id, { status: pedido.status, motivoRecusa: pedido.motivoRecusa });
      } else if (body.decisao === 'expirado') {
        pedido.status = 'expirado';
        pedidos.update(pedido.id, { status: pedido.status });
      }
      return sendJSON(res, 200, pedido);
    }

    if (parts[1] === 'pedidos' && parts[3] === 'itens' && parts[5] === 'producao' && req.method === 'PATCH') {
      const pedido = pedidos.findById(parts[2]);
      if (!pedido) return sendJSON(res, 404, { error: 'Pedido não encontrado' });
      const item = findItem(pedido, parts[4]);
      if (!item) return sendJSON(res, 404, { error: 'Produto não encontrado' });
      const body = await readBody(req);

      if (body.action === 'atribuir_impressora') {
        item.impressoraId = Number(body.impressoraId);
        itens.update(item.id, { impressoraId: item.impressoraId });
      } else if (body.action === 'iniciar') {
        item.status = 'imprimindo';
        item.inicioImpressao = new Date().toISOString();
        itens.update(item.id, { status: item.status, inicioImpressao: item.inicioImpressao });
      } else if (body.action === 'concluir') {
        item.status = 'concluido';
        item.fimImpressao = new Date().toISOString();
        itens.update(item.id, { status: item.status, fimImpressao: item.fimImpressao });
        // baixa automática de estoque — uma movimentação por filamento usado na peça
        if (item.orcamento) {
          filamentosDoOrcamento(item.orcamento).forEach((f) => {
            const filamento = filamentos.findById(f.filamentoId);
            if (!filamento) return;
            const gramasUsadas = f.pesoGramas * item.quantidade;
            filamentos.ajustarEstoque(filamento.id, -gramasUsadas);
            movimentacoesEstoque.insert({
              filamentoId: filamento.id,
              tipo: 'saida',
              gramas: gramasUsadas,
              data: new Date().toISOString(),
              obs: `Produção pedido #${pedido.id} (${pedido.cliente}) — ${item.descricao}`
            });
          });
        }
      } else if (body.action === 'falha') {
        item.falhaReimpressao = true;
        item.motivoFalha = body.motivo || '';
        itens.update(item.id, { falhaReimpressao: item.falhaReimpressao, motivoFalha: item.motivoFalha });
        if (body.gramasReimpressao && item.orcamento) {
          const primeiroFilamento = filamentosDoOrcamento(item.orcamento)[0];
          const filamento = primeiroFilamento ? filamentos.findById(primeiroFilamento.filamentoId) : null;
          if (filamento) {
            const gramas = Number(body.gramasReimpressao);
            filamentos.ajustarEstoque(filamento.id, -gramas);
            movimentacoesEstoque.insert({
              filamentoId: filamento.id,
              tipo: 'saida',
              gramas,
              data: new Date().toISOString(),
              obs: `Reimpressão pedido #${pedido.id} (${item.descricao}) — ${body.motivo || ''}`
            });
          }
        }
      }
      const statusAntes = pedido.status;
      recomputeStatusProducao(pedido);
      if (pedido.status !== statusAntes) pedidos.update(pedido.id, { status: pedido.status });
      return sendJSON(res, 200, pedido);
    }

    if (parts[1] === 'pedidos' && parts[3] === 'entrega' && req.method === 'PATCH') {
      const pedido = pedidos.findById(parts[2]);
      if (!pedido) return sendJSON(res, 404, { error: 'Pedido não encontrado' });
      const body = await readBody(req);
      pedido.statusEntrega = body.statusEntrega;
      const patch = { statusEntrega: pedido.statusEntrega };
      if (body.statusEntrega === 'entregue') {
        pedido.entregueEm = new Date().toISOString();
        patch.entregueEm = pedido.entregueEm;
      }
      pedidos.update(pedido.id, patch);
      return sendJSON(res, 200, pedido);
    }

    if (parts[1] === 'pedidos' && parts[3] === 'pagamentos' && parts.length === 4 && req.method === 'POST') {
      const pedido = pedidos.findById(parts[2]);
      if (!pedido) return sendJSON(res, 404, { error: 'Pedido não encontrado' });
      if (pedido.statusPagamento === 'pago') {
        return sendJSON(res, 400, { error: 'Pedido já está marcado como pago' });
      }
      const body = await readBody(req);
      const conta = contasFinanceiras.findById(body.contaId);
      if (!conta) return sendJSON(res, 400, { error: 'Conta financeira inválida' });
      if (!FORMA_PAGAMENTO.includes(body.formaPagamento)) {
        return sendJSON(res, 400, { error: 'Forma de pagamento inválida' });
      }
      const valor = Number(body.valor);
      if (!valor || valor <= 0) {
        return sendJSON(res, 400, { error: 'Valor inválido' });
      }
      const totalPedido = calcularValorPedido(pedido);
      const jaPago = pedido.pagamentos.filter((p) => !p.estornado).reduce((s, p) => s + p.valor, 0);
      const saldoDevedor = totalPedido - jaPago;
      if (valor > saldoDevedor + 0.01) {
        return sendJSON(res, 400, { error: `Valor maior que o saldo devedor (R$ ${saldoDevedor.toFixed(2)})` });
      }

      const dataPagamento = body.data ? new Date(body.data).toISOString() : new Date().toISOString();
      const mov = movimentacoesFinanceiras.insert({
        tipo: 'entrada',
        valor,
        contaId: conta.id,
        formaPagamento: body.formaPagamento,
        categoria: 'Venda',
        categoriaDetalhe: null,
        descricao: `Venda — pedido #${pedido.id} (${pedido.cliente})`,
        pedidoId: pedido.id,
        responsavelId: null,
        reembolsado: false,
        reembolsoId: null,
        estornado: false,
        estornoDe: null,
        data: dataPagamento,
        criadoEm: new Date().toISOString()
      });
      contasFinanceiras.ajustarSaldo(conta.id, valor);
      pagamentosPedido.insert({
        pedidoId: pedido.id,
        valor,
        formaPagamento: body.formaPagamento,
        contaId: conta.id,
        movimentacaoFinanceiraId: mov.id,
        dataPagamento
      });

      const pedidoAtualizado = pedidos.findById(pedido.id);
      recomputeStatusPagamento(pedidoAtualizado);
      return sendJSON(res, 200, pedidos.findById(pedido.id));
    }

    if (parts[1] === 'pedidos' && parts[3] === 'pagamentos' && parts[5] === 'estorno' && req.method === 'POST') {
      const pedido = pedidos.findById(parts[2]);
      if (!pedido) return sendJSON(res, 404, { error: 'Pedido não encontrado' });
      const pagamento = pedido.pagamentos.find((p) => p.id === Number(parts[4]));
      if (!pagamento) return sendJSON(res, 404, { error: 'Pagamento não encontrado' });
      if (pagamento.estornado) return sendJSON(res, 400, { error: 'Pagamento já estornado' });

      estornarMovimentacao(pagamento.movimentacaoFinanceiraId);
      pagamentosPedido.marcarEstornado(pagamento.id);

      const pedidoAtualizado = pedidos.findById(pedido.id);
      recomputeStatusPagamento(pedidoAtualizado);
      return sendJSON(res, 200, pedidos.findById(pedido.id));
    }

    return sendJSON(res, 404, { error: 'Rota não encontrada' });
  } catch (e) {
    console.error(e);
    return sendJSON(res, 500, { error: 'Erro interno, tente novamente' });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const query = Object.fromEntries(url.searchParams);

  if (pathname.startsWith('/api/')) {
    return api(req, res, pathname, query);
  }
  return serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  console.log(`Sistema de gestão rodando em http://localhost:${PORT}`);
});
