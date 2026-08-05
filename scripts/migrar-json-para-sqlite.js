// Migração única e descartável: data/db.json (flat-file) -> data/db.sqlite (tabelas reais).
// Uso: node scripts/migrar-json-para-sqlite.js [caminho-json] [caminho-sqlite]
// Preserva os ids originais (INSERT explícito) para manter referências como pedidoId/reembolsoId.
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { createSchema } = require('../lib/schema');

const jsonPath = process.argv[2] || path.join(__dirname, '..', 'data', 'db.json');
const sqlitePath = process.argv[3] || path.join(__dirname, '..', 'data', 'db.sqlite');

if (fs.existsSync(sqlitePath)) {
  throw new Error(`${sqlitePath} já existe — apague-o antes de rodar a migração de novo (evita duplicar dados).`);
}

const old = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));

fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
const conn = new DatabaseSync(sqlitePath);
conn.exec('PRAGMA journal_mode = WAL');
createSchema(conn);

function bool(v) {
  return v ? 1 : 0;
}

conn.exec('BEGIN');
try {
  if (old.params) {
    conn.prepare('INSERT INTO params (id, tarifa_kwh, margem_padrao) VALUES (1, ?, ?)').run(old.params.tarifaKwh, old.params.margemPadrao);
  }

  const insUsuario = conn.prepare('INSERT INTO usuarios (id, nome, email, senha_salt, senha_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  (old.usuarios || []).forEach((u) => insUsuario.run(u.id, u.nome, u.email, u.senhaSalt, u.senhaHash, u.createdAt));

  const insImp = conn.prepare('INSERT INTO impressoras (id, nome, potencia_w, ativa) VALUES (?, ?, ?, ?)');
  (old.impressoras || []).forEach((i) => insImp.run(i.id, i.nome, i.potenciaW, bool(i.ativa)));

  const insFil = conn.prepare(
    'INSERT INTO filamentos (id, material, marca, cor, preco_por_kg, peso_rolo_gramas, estoque_atual_gramas, estoque_minimo_gramas) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  (old.filamentos || []).forEach((f) =>
    insFil.run(f.id, f.material, f.marca || '', f.cor, f.precoPorKg, f.pesoRoloGramas, f.estoqueAtualGramas, f.estoqueMinimoGramas)
  );

  const insMovEst = conn.prepare('INSERT INTO movimentacoes_estoque (id, filamento_id, tipo, gramas, data, obs) VALUES (?, ?, ?, ?, ?, ?)');
  (old.movimentacoesEstoque || []).forEach((m) => insMovEst.run(m.id, m.filamentoId, m.tipo, m.gramas, m.data, m.obs || ''));

  const insProduto = conn.prepare(
    'INSERT INTO produtos (id, nome, descricao, dimensoes, cor_filamento, modelo_ref, imagem, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  (old.produtos || []).forEach((p) =>
    insProduto.run(p.id, p.nome || '', p.descricao || '', p.dimensoes || '', p.corFilamento || '', p.modeloRef || '', p.imagem || null, p.createdAt)
  );

  const insCliente = conn.prepare(
    'INSERT INTO clientes (id, nome, contato, email, endereco, observacoes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  (old.clientes || []).forEach((c) =>
    insCliente.run(c.id, c.nome || '', c.contato || '', c.email || '', c.endereco || '', c.observacoes || '', c.createdAt)
  );

  const insConta = conn.prepare('INSERT INTO contas_financeiras (id, nome, tipo, saldo_inicial, saldo_atual) VALUES (?, ?, ?, ?, ?)');
  (old.contasFinanceiras || []).forEach((c) => insConta.run(c.id, c.nome, c.tipo, c.saldoInicial, c.saldoAtual));

  const insSocio = conn.prepare('INSERT INTO socios (id, nome) VALUES (?, ?)');
  (old.socios || []).forEach((s) => insSocio.run(s.id, s.nome));

  const insMovFin = conn.prepare(
    `INSERT INTO movimentacoes_financeiras
      (id, tipo, valor, conta_id, forma_pagamento, categoria, categoria_detalhe, descricao, pedido_id, responsavel_id, reembolsado, reembolso_id, estornado, estorno_de, data, criado_em)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  (old.movimentacoesFinanceiras || []).forEach((m) =>
    insMovFin.run(
      m.id,
      m.tipo,
      m.valor,
      m.contaId ?? null,
      m.formaPagamento,
      m.categoria,
      m.categoriaDetalhe ?? null,
      m.descricao || '',
      m.pedidoId ?? null,
      m.responsavelId ?? null,
      bool(m.reembolsado),
      m.reembolsoId ?? null,
      bool(m.estornado),
      m.estornoDe ?? null,
      m.data,
      m.criadoEm
    )
  );

  const insPedido = conn.prepare(
    `INSERT INTO pedidos
      (id, created_at, cliente_id, cliente, contato, vendedor, observacoes, status, status_pagamento, aprovado_em, forma_pagamento_combinada, motivo_recusa, status_entrega, entregue_em, forma_pagamento, conta_id, movimentacao_financeira_id, data_pagamento)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insItem = conn.prepare(
    `INSERT INTO itens
      (id, pedido_id, produto_id, peca_ja_feita, modelo_ref, descricao, dimensoes, variacao, cor_filamento, imagem, quantidade, status, orcamento_json, impressora_id, inicio_impressao, fim_impressao, falha_reimpressao, motivo_falha)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  (old.pedidos || []).forEach((p) => {
    insPedido.run(
      p.id,
      p.createdAt,
      p.clienteId ?? null,
      p.cliente || '',
      p.contato || '',
      p.vendedor || '',
      p.observacoes || '',
      p.status,
      p.statusPagamento,
      p.aprovadoEm ?? null,
      p.formaPagamentoCombinada ?? null,
      p.motivoRecusa ?? null,
      p.statusEntrega ?? null,
      p.entregueEm ?? null,
      p.formaPagamento ?? null,
      p.contaId ?? null,
      p.movimentacaoFinanceiraId ?? null,
      p.dataPagamento ?? null
    );
    (p.itens || []).forEach((it) =>
      insItem.run(
        it.id,
        p.id,
        it.produtoId ?? null,
        bool(it.pecaJaFeita),
        it.modeloRef || '',
        it.descricao || '',
        it.dimensoes || '',
        it.variacao || '',
        it.corFilamento || '',
        it.imagem ?? null,
        it.quantidade,
        it.status,
        it.orcamento ? JSON.stringify(it.orcamento) : null,
        it.impressoraId ?? null,
        it.inicioImpressao ?? null,
        it.fimImpressao ?? null,
        bool(it.falhaReimpressao),
        it.motivoFalha ?? null
      )
    );
  });

  conn.exec('COMMIT');
  console.log(`Migração concluída: ${sqlitePath}`);
} catch (e) {
  conn.exec('ROLLBACK');
  throw e;
}
