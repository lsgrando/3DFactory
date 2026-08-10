// Importação única: zera pedidos/itens/movimentações financeiras/clientes de teste e
// reimporta o histórico real a partir do JSON extraído da planilha (Vendas + Saida + Cliente).
// Uso: node scripts/importar-planilha.js <caminho-json> [caminho-sqlite]
// Filamentos, produtos, impressoras e usuários NÃO são tocados.
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const jsonPath = process.argv[2];
const sqlitePath = process.argv[3] || path.join(__dirname, '..', 'data', 'db.sqlite');

if (!jsonPath) {
  throw new Error('Uso: node scripts/importar-planilha.js <caminho-json> [caminho-sqlite]');
}

const { clientes: clientesIn, vendas, saidas } = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));

const conn = new DatabaseSync(sqlitePath);
conn.exec('PRAGMA foreign_keys = ON');

function contaVenda(v) {
  if (v.canal === 'Shopee') return 'Carteira Shopee';
  if (v.canal === 'Site') return 'Carteira do Site';
  if (v.canal === 'Whatsapp') return v.formaPagamento === 'Dinheiro' ? 'Caixa (dinheiro físico)' : 'Banco Inter';
  throw new Error(`Canal não mapeado: ${v.canal}`);
}

conn.exec('BEGIN');
try {
  // ---------- limpeza (respeita FK: itens antes de pedidos) ----------
  conn.exec('DELETE FROM itens');
  conn.exec('DELETE FROM pedidos');
  conn.exec('DELETE FROM movimentacoes_financeiras');
  conn.exec('DELETE FROM clientes');

  // ---------- contas (zera saldo, garante Carteira do Site) ----------
  conn.exec("UPDATE contas_financeiras SET saldo_atual = saldo_inicial");
  const contaRow = conn.prepare('SELECT id FROM contas_financeiras WHERE nome = ?').get('Carteira do Site');
  if (!contaRow) {
    conn.prepare("INSERT INTO contas_financeiras (nome, tipo, saldo_inicial, saldo_atual) VALUES (?, 'carteira_digital', 0, 0)").run('Carteira do Site');
  }
  const contas = conn.prepare('SELECT id, nome FROM contas_financeiras').all();
  const contaIdPorNome = Object.fromEntries(contas.map((c) => [c.nome, c.id]));

  const socios = conn.prepare('SELECT id, nome FROM socios').all();
  const socioIdPorNome = Object.fromEntries(socios.map((s) => [s.nome, s.id]));

  function ajustarSaldo(contaId, delta) {
    conn.prepare('UPDATE contas_financeiras SET saldo_atual = saldo_atual + ? WHERE id = ?').run(delta, contaId);
  }

  // ---------- clientes ----------
  const insCliente = conn.prepare(
    'INSERT INTO clientes (nome, contato, email, endereco, observacoes, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const clienteIdPorNome = {};
  const agora = new Date().toISOString();
  clientesIn.forEach((c) => {
    const r = insCliente.run(c.nome, c.contato || '', '', c.endereco || '', '', agora);
    clienteIdPorNome[c.nome.trim().toLowerCase()] = Number(r.lastInsertRowid);
  });

  // ---------- vendas -> pedidos + itens + movimentação de entrada ----------
  const insPedido = conn.prepare(`
    INSERT INTO pedidos
      (created_at, cliente_id, cliente, contato, vendedor, observacoes, status, status_pagamento,
       aprovado_em, status_entrega, entregue_em, forma_pagamento, conta_id, movimentacao_financeira_id,
       data_pagamento, id_plataforma)
    VALUES (?, ?, ?, ?, '', ?, 'concluido', ?, ?, 'entregue', ?, ?, ?, ?, ?, ?)
  `);
  const insItem = conn.prepare(`
    INSERT INTO itens
      (pedido_id, produto_id, peca_ja_feita, modelo_ref, descricao, dimensoes, variacao, cor_filamento,
       imagem, quantidade, status, orcamento_json)
    VALUES (?, NULL, 0, '', ?, '', '', '', NULL, ?, 'concluido', ?)
  `);
  const insMov = conn.prepare(`
    INSERT INTO movimentacoes_financeiras
      (tipo, valor, conta_id, forma_pagamento, categoria, categoria_detalhe, descricao, pedido_id,
       responsavel_id, reembolsado, reembolso_id, estornado, estorno_de, data, criado_em)
    VALUES ('entrada', ?, ?, ?, 'Venda', NULL, ?, ?, NULL, 0, NULL, 0, NULL, ?, ?)
  `);
  const updPedidoPagamento = conn.prepare(`
    UPDATE pedidos SET forma_pagamento = ?, conta_id = ?, movimentacao_financeira_id = ?, data_pagamento = ?
    WHERE id = ?
  `);

  const clientesSemMatch = new Set();
  let totalPago = 0;
  let totalPendente = 0;

  vendas.forEach((v) => {
    const clienteNomeNorm = v.cliente ? v.cliente.trim().toLowerCase() : null;
    const clienteId = clienteNomeNorm ? clienteIdPorNome[clienteNomeNorm] || null : null;
    if (v.cliente && !clienteId) clientesSemMatch.add(v.cliente);

    const observacoes = `[${v.canal}]${v.observacao ? ' ' + v.observacao : ''}`;
    const custoTotal = Math.round((v.custoUnitario * v.quantidade + v.embalagem) * 100) / 100;
    const orcamento = {
      pesoGramas: 0,
      tempoHoras: 0,
      filamentoId: null,
      impressoraSugeridaId: null,
      potenciaW: 0,
      tarifaKwh: 0,
      margemPercentual: null,
      margemFixa: Math.round((v.valorFinal - custoTotal) * 100) / 100,
      custoFilamento: 0,
      custoEnergia: 0,
      custoTotal,
      precoVenda: v.valorFinal,
      validadeOrcamento: null,
      criadoEm: v.data
    };

    const rPedido = insPedido.run(
      v.data,
      clienteId,
      v.cliente || '',
      clienteId ? clientesIn.find((c) => c.nome.trim().toLowerCase() === clienteNomeNorm).contato || '' : '',
      observacoes,
      v.statusPagamento,
      v.data,
      v.data,
      v.statusPagamento === 'pago' ? v.formaPagamento : null,
      null,
      null,
      v.statusPagamento === 'pago' ? v.dataPagamento || v.data : null,
      v.idPlataforma
    );
    const pedidoId = Number(rPedido.lastInsertRowid);
    insItem.run(pedidoId, v.produto, v.quantidade, JSON.stringify(orcamento));

    if (v.statusPagamento === 'pago') {
      const contaNome = contaVenda(v);
      const contaId = contaIdPorNome[contaNome];
      const dataMov = v.dataPagamento || v.data;
      const rMov = insMov.run(v.valorFinal, contaId, v.formaPagamento, `Venda — pedido #${pedidoId} (${v.cliente || v.canal})`, pedidoId, dataMov, dataMov);
      updPedidoPagamento.run(v.formaPagamento, contaId, Number(rMov.lastInsertRowid), dataMov, pedidoId);
      ajustarSaldo(contaId, v.valorFinal);
      totalPago += v.valorFinal;
    } else {
      totalPendente += v.valorFinal;
    }
  });

  // ---------- saidas -> movimentação de saída ----------
  const insMovSaida = conn.prepare(`
    INSERT INTO movimentacoes_financeiras
      (tipo, valor, conta_id, forma_pagamento, categoria, categoria_detalhe, descricao, pedido_id,
       responsavel_id, reembolsado, reembolso_id, estornado, estorno_de, data, criado_em)
    VALUES ('saida', ?, ?, ?, ?, NULL, ?, NULL, ?, 0, NULL, 0, NULL, ?, ?)
  `);

  let totalSaida = 0;
  let pulados = [];
  saidas.forEach((s) => {
    if (s.status === 'A Pagar') {
      pulados.push(s);
      return;
    }
    const socioId = socioIdPorNome[s.pagoPor] || null;
    const contaId = socioId ? null : contaIdPorNome[s.formaPagamento === 'Dinheiro' ? 'Caixa (dinheiro físico)' : 'Banco Inter'];
    const descricao = s.descricao + (s.observacao ? ` — ${s.observacao}` : '');
    insMovSaida.run(s.valor, contaId, s.formaPagamento, s.categoria, descricao, socioId, s.data, s.data);
    if (contaId) ajustarSaldo(contaId, -s.valor);
    totalSaida += s.valor;
  });

  conn.exec('COMMIT');

  const saldosFinal = conn.prepare('SELECT nome, saldo_atual FROM contas_financeiras').all();
  console.log('--- Importação concluída ---');
  console.log(`Clientes importados: ${clientesIn.length}`);
  console.log(`Pedidos importados: ${vendas.length} (pago: ${vendas.filter((v) => v.statusPagamento === 'pago').length}, pendente: ${vendas.filter((v) => v.statusPagamento === 'pendente').length})`);
  console.log(`Total recebido (entradas): R$ ${totalPago.toFixed(2)}`);
  console.log(`Total a receber (pendente): R$ ${totalPendente.toFixed(2)}`);
  console.log(`Movimentações de saída importadas: ${saidas.length - pulados.length} — total R$ ${totalSaida.toFixed(2)}`);
  if (pulados.length) console.log(`Saídas puladas (status "A Pagar"): ${JSON.stringify(pulados)}`);
  console.log('Saldos finais das contas:');
  saldosFinal.forEach((c) => console.log(`  ${c.nome}: R$ ${c.saldo_atual.toFixed(2)}`));
  if (clientesSemMatch.size) {
    console.log(`Nomes de cliente na aba Vendas sem match no cadastro (ficaram sem clienteId, só texto): ${[...clientesSemMatch].join(', ')}`);
  }
} catch (e) {
  conn.exec('ROLLBACK');
  throw e;
} finally {
  conn.close();
}
