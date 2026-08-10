// Backfill único e idempotente: cria uma linha em pagamentos_pedido para cada pedido já pago no
// formato antigo (colunas forma_pagamento/conta_id/movimentacao_financeira_id/data_pagamento em
// pedidos), que o código novo não escreve mais. Pedidos que já têm alguma linha em
// pagamentos_pedido são pulados — pode ser rodado mais de uma vez sem duplicar.
// Uso: node scripts/backfill-pagamentos.js [caminho-sqlite]
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { createSchema } = require('../lib/schema');

const sqlitePath = process.argv[2] || path.join(__dirname, '..', 'data', 'db.sqlite');

const conn = new DatabaseSync(sqlitePath);
conn.exec('PRAGMA journal_mode = WAL');
createSchema(conn); // idempotente — garante que a tabela pagamentos_pedido existe

const pedidosPagos = conn
  .prepare("SELECT * FROM pedidos WHERE status_pagamento = 'pago' AND movimentacao_financeira_id IS NOT NULL")
  .all();

const jaTemPagamento = conn.prepare('SELECT COUNT(*) as n FROM pagamentos_pedido WHERE pedido_id = ?');
const itensDoPedido = conn.prepare('SELECT * FROM itens WHERE pedido_id = ?');
const insert = conn.prepare(
  `INSERT INTO pagamentos_pedido (pedido_id, valor, forma_pagamento, conta_id, movimentacao_financeira_id, data_pagamento)
   VALUES (?, ?, ?, ?, ?, ?)`
);

let inseridos = 0;
let pulados = 0;

conn.exec('BEGIN');
try {
  pedidosPagos.forEach((p) => {
    if (jaTemPagamento.get(p.id).n > 0) {
      pulados++;
      return;
    }
    const itensPedido = itensDoPedido.all(p.id);
    const valor = itensPedido.reduce((s, it) => {
      if (!it.orcamento_json) return s;
      const orc = JSON.parse(it.orcamento_json);
      return s + (orc.precoVenda || 0) * it.quantidade;
    }, 0);
    insert.run(
      p.id,
      Math.round(valor * 100) / 100,
      p.forma_pagamento || 'Pix',
      p.conta_id,
      p.movimentacao_financeira_id,
      p.data_pagamento || p.aprovado_em || p.created_at
    );
    inseridos++;
  });
  conn.exec('COMMIT');
} catch (e) {
  conn.exec('ROLLBACK');
  throw e;
}

console.log(`Backfill concluído: ${inseridos} pagamento(s) criado(s), ${pulados} pedido(s) já tinham pagamento (pulados).`);
