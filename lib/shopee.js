const crypto = require('crypto');
const { shopeeConexao } = require('./db');

// Integração com a Shopee Open Platform (API v2). Credenciais vêm de variáveis de ambiente:
// SHOPEE_PARTNER_ID e SHOPEE_PARTNER_KEY; SHOPEE_AMBIENTE=producao usa a API real, qualquer
// outro valor usa o sandbox (chaves de teste).
const HOSTS = {
  teste: 'https://openplatform.sandbox.test-stable.shopee.sg',
  producao: 'https://openplatform.shopee.com.br'
};
// Renova o access_token (vale ~4h) quando faltar menos que isso pra expirar.
const MARGEM_RENOVACAO_MS = 10 * 60 * 1000;

function config() {
  const partnerId = Number(process.env.SHOPEE_PARTNER_ID);
  const partnerKey = process.env.SHOPEE_PARTNER_KEY;
  if (!partnerId || !partnerKey) return null;
  const ambiente = process.env.SHOPEE_AMBIENTE === 'producao' ? 'producao' : 'teste';
  return { partnerId, partnerKey, ambiente, host: HOSTS[ambiente] };
}

// Assinatura HMAC-SHA256 exigida em toda chamada: partner_id + caminho + timestamp
// (+ access_token + shop_id nas chamadas feitas em nome da loja).
function assinar(cfg, caminho, timestamp, accessToken = '', shopId = '') {
  return crypto.createHmac('sha256', cfg.partnerKey)
    .update(`${cfg.partnerId}${caminho}${timestamp}${accessToken}${shopId}`)
    .digest('hex');
}

function agora() {
  return Math.floor(Date.now() / 1000);
}

// Link que o administrador abre pra autorizar a loja; a Shopee volta pra `redirect` com ?code=&shop_id=.
function linkAutorizacao(cfg, redirect) {
  const caminho = '/api/v2/shop/auth_partner';
  const ts = agora();
  const qs = new URLSearchParams({ partner_id: cfg.partnerId, timestamp: ts, sign: assinar(cfg, caminho, ts), redirect });
  return `${cfg.host}${caminho}?${qs}`;
}

async function chamar(cfg, metodo, caminho, { query = {}, body, accessToken, shopId } = {}) {
  const ts = agora();
  const qs = new URLSearchParams({ partner_id: cfg.partnerId, timestamp: ts, sign: assinar(cfg, caminho, ts, accessToken, shopId) });
  if (accessToken) {
    qs.set('access_token', accessToken);
    qs.set('shop_id', shopId);
  }
  for (const [k, v] of Object.entries(query)) qs.set(k, v);
  const resp = await fetch(`${cfg.host}${caminho}?${qs}`, {
    method: metodo,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  // IDs como transaction_id passam de 2^53 e perderiam precisão como número — viram texto.
  const texto = await resp.text();
  let data;
  try {
    data = JSON.parse(texto.replace(/"(\w+_id)":\s*(\d{16,})/g, '"$1":"$2"'));
  } catch (e) {
    data = { error: `http_${resp.status}`, message: 'Resposta inválida da Shopee' };
  }
  if (data.error) throw new Error(`Shopee: ${data.message || data.error} (${data.error})`);
  return data;
}

function salvarTokens(shopId, data) {
  return shopeeConexao.salvar({
    shopId,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiraEm: new Date(Date.now() + data.expire_in * 1000).toISOString()
  });
}

// Troca o `code` recebido no retorno da autorização pelos tokens da loja e guarda no banco.
// Autorizando com a conta principal, a Shopee devolve main_account_id em vez de shop_id, e a
// loja vem em shop_id_list na resposta do token.
async function conectar(cfg, code, shopId, mainAccountId) {
  const data = await chamar(cfg, 'POST', '/api/v2/auth/token/get', {
    body: shopId
      ? { code, shop_id: shopId, partner_id: cfg.partnerId }
      : { code, main_account_id: mainAccountId, partner_id: cfg.partnerId }
  });
  const loja = shopId || (data.shop_id_list || [])[0];
  if (!loja) throw new Error('Nenhuma loja autorizada nessa conta Shopee');
  return salvarTokens(loja, data);
}

// Devolve a conexão com access_token válido, renovando antes se estiver perto de expirar.
async function conexaoValida(cfg) {
  const conexao = shopeeConexao.get();
  if (!conexao) return null;
  if (new Date(conexao.expiraEm).getTime() - Date.now() > MARGEM_RENOVACAO_MS) return conexao;
  const data = await chamar(cfg, 'POST', '/api/v2/auth/access_token/get', {
    body: { refresh_token: conexao.refreshToken, shop_id: conexao.shopId, partner_id: cfg.partnerId }
  });
  return salvarTokens(conexao.shopId, data);
}

// Chamada GET em nome da loja conectada (ex.: '/api/v2/shop/get_shop_info').
async function getLoja(cfg, caminho, query) {
  const conexao = await conexaoValida(cfg);
  if (!conexao) throw new Error('Loja Shopee não conectada');
  return chamar(cfg, 'GET', caminho, { query, accessToken: conexao.accessToken, shopId: conexao.shopId });
}

// Pedidos da loja atualizados no intervalo [desde, ate] (timestamps em segundos; a Shopee
// aceita no máximo 15 dias por consulta). Devolve [{ order_sn, order_status }].
async function pedidosAtualizados(cfg, desde, ate) {
  const lista = [];
  let cursor = '';
  do {
    const data = await getLoja(cfg, '/api/v2/order/get_order_list', {
      time_range_field: 'update_time', time_from: desde, time_to: ate,
      page_size: 100, cursor, response_optional_fields: 'order_status'
    });
    lista.push(...(data.response.order_list || []));
    cursor = data.response.more ? data.response.next_cursor : '';
  } while (cursor);
  return lista;
}

// Detalhes completos (comprador, itens, valores) de até 50 pedidos por chamada.
async function detalhesPedidos(cfg, orderSns) {
  const detalhes = [];
  for (let i = 0; i < orderSns.length; i += 50) {
    const data = await getLoja(cfg, '/api/v2/order/get_order_detail', {
      order_sn_list: orderSns.slice(i, i + 50).join(','),
      response_optional_fields: 'buyer_username,item_list,total_amount,cancel_reason,buyer_cancel_reason,note'
    });
    detalhes.push(...(data.response.order_list || []));
  }
  return detalhes;
}

// Movimentações da carteira da loja com create_time em [desde, ate] (segundos), da mais antiga
// pra mais recente. A Shopee recusa períodos acima de ~14 dias, então busca em janelas de 7.
const JANELA_CARTEIRA_S = 7 * 24 * 60 * 60;
async function movimentacoesCarteira(cfg, desde, ate) {
  const porId = new Map();
  for (let fim = ate; fim > desde; fim -= JANELA_CARTEIRA_S) {
    const inicio = Math.max(desde, fim - JANELA_CARTEIRA_S);
    for (let pagina = 0; ; pagina++) {
      const data = await getLoja(cfg, '/api/v2/payment/get_wallet_transaction_list', {
        page_no: pagina, page_size: 100, create_time_from: inicio, create_time_to: fim
      });
      const lista = data.response.transaction_list || [];
      lista.forEach((t) => porId.set(String(t.transaction_id), t));
      if (!data.response.more || !lista.length) break;
    }
  }
  return [...porId.values()].sort((a, b) => a.create_time - b.create_time);
}

// Aviso (push) da Shopee: o header Authorization traz HMAC-SHA256 de "<url de callback>|<corpo bruto>",
// assinado com a Push Partner Key da tela de Push do console (SHOPEE_PUSH_KEY) — não a partner key.
function assinaturaPushValida(cfg, urlCallback, corpoBruto, authorization) {
  const chave = process.env.SHOPEE_PUSH_KEY || cfg.partnerKey;
  const esperado = crypto.createHmac('sha256', chave).update(`${urlCallback}|${corpoBruto}`).digest('hex');
  const recebido = String(authorization || '');
  return recebido.length === esperado.length && crypto.timingSafeEqual(Buffer.from(recebido), Buffer.from(esperado));
}

module.exports = { config, linkAutorizacao, conectar, getLoja, pedidosAtualizados, detalhesPedidos, movimentacoesCarteira, assinaturaPushValida };
