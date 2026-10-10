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
  const data = await resp.json().catch(() => ({ error: `http_${resp.status}`, message: 'Resposta inválida da Shopee' }));
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
async function conectar(cfg, code, shopId) {
  const data = await chamar(cfg, 'POST', '/api/v2/auth/token/get', {
    body: { code, shop_id: shopId, partner_id: cfg.partnerId }
  });
  return salvarTokens(shopId, data);
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

module.exports = { config, linkAutorizacao, conectar, getLoja };
