const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createSchema, ensureColumn } = require('./schema');
const { hashPassword } = require('./auth');

const DB_PATH = path.join(__dirname, '..', 'data', 'db.sqlite');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const conn = new DatabaseSync(DB_PATH);
conn.exec('PRAGMA journal_mode = WAL');
createSchema(conn);
ensureColumn(conn, 'pedidos', 'id_plataforma', 'TEXT');
conn.exec('CREATE INDEX IF NOT EXISTS idx_pedidos_id_plataforma ON pedidos(id_plataforma)');
ensureColumn(conn, 'variacoes', 'preco_venda', 'REAL');
ensureColumn(conn, 'filamentos', 'cor_hex', "TEXT NOT NULL DEFAULT ''");
ensureColumn(conn, 'usuarios', 'papel', "TEXT NOT NULL DEFAULT 'vendas'");

function toInt(bool) {
  return bool ? 1 : 0;
}
function fromInt(v) {
  return !!v;
}

function updateRow(table, id, patch, columnMap) {
  const sets = [];
  const params = [];
  for (const key of Object.keys(patch)) {
    if (!(key in columnMap)) continue;
    sets.push(`${columnMap[key]} = ?`);
    params.push(patch[key]);
  }
  if (!sets.length) return;
  params.push(id);
  conn.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

// ---------- PARAMS ----------
function rowToParams(row) {
  return { tarifaKwh: row.tarifa_kwh, margemPadrao: row.margem_padrao };
}
const params = {
  get() {
    return rowToParams(conn.prepare('SELECT * FROM params WHERE id = 1').get());
  },
  update(patch) {
    const atual = params.get();
    const novo = Object.assign({}, atual, patch);
    conn.prepare('UPDATE params SET tarifa_kwh = ?, margem_padrao = ? WHERE id = 1').run(novo.tarifaKwh, novo.margemPadrao);
    return params.get();
  }
};

// ---------- USUÁRIOS ----------
function rowToUsuario(row) {
  return { id: row.id, nome: row.nome, email: row.email, senhaSalt: row.senha_salt, senhaHash: row.senha_hash, papel: row.papel, createdAt: row.created_at };
}
const usuarios = {
  all() {
    return conn.prepare('SELECT * FROM usuarios ORDER BY id').all().map(rowToUsuario);
  },
  findById(id) {
    const row = conn.prepare('SELECT * FROM usuarios WHERE id = ?').get(Number(id));
    return row ? rowToUsuario(row) : null;
  },
  findByEmail(email) {
    const row = conn.prepare('SELECT * FROM usuarios WHERE lower(email) = lower(?)').get(email);
    return row ? rowToUsuario(row) : null;
  },
  insert({ nome, email, senhaSalt, senhaHash, papel, createdAt }) {
    const r = conn
      .prepare('INSERT INTO usuarios (nome, email, senha_salt, senha_hash, papel, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(nome || '', email, senhaSalt, senhaHash, papel === 'admin' ? 'admin' : 'vendas', createdAt);
    return usuarios.findById(r.lastInsertRowid);
  },
  updateSenha(id, { senhaSalt, senhaHash }) {
    conn.prepare('UPDATE usuarios SET senha_salt = ?, senha_hash = ? WHERE id = ?').run(senhaSalt, senhaHash, Number(id));
  }
};

// ---------- IMPRESSORAS ----------
function rowToImpressora(row) {
  return { id: row.id, nome: row.nome, potenciaW: row.potencia_w, ativa: fromInt(row.ativa) };
}
const impressoras = {
  all() {
    return conn.prepare('SELECT * FROM impressoras ORDER BY id').all().map(rowToImpressora);
  },
  findById(id) {
    const row = conn.prepare('SELECT * FROM impressoras WHERE id = ?').get(Number(id));
    return row ? rowToImpressora(row) : null;
  },
  insert({ nome, potenciaW, ativa }) {
    const r = conn
      .prepare('INSERT INTO impressoras (nome, potencia_w, ativa) VALUES (?, ?, ?)')
      .run(nome, potenciaW, toInt(ativa !== false));
    return impressoras.findById(r.lastInsertRowid);
  },
  update(id, patch) {
    const conv = Object.assign({}, patch);
    if ('ativa' in conv) conv.ativa = toInt(conv.ativa);
    updateRow('impressoras', Number(id), conv, { nome: 'nome', potenciaW: 'potencia_w', ativa: 'ativa' });
    return impressoras.findById(id);
  },
  remove(id) {
    conn.prepare('DELETE FROM impressoras WHERE id = ?').run(Number(id));
  }
};

// ---------- FILAMENTOS ----------
function rowToFilamento(row) {
  return {
    id: row.id,
    material: row.material,
    marca: row.marca,
    cor: row.cor,
    corHex: row.cor_hex,
    precoPorKg: row.preco_por_kg,
    pesoRoloGramas: row.peso_rolo_gramas,
    estoqueAtualGramas: row.estoque_atual_gramas,
    estoqueMinimoGramas: row.estoque_minimo_gramas
  };
}
const filamentos = {
  all() {
    return conn.prepare('SELECT * FROM filamentos ORDER BY id').all().map(rowToFilamento);
  },
  findById(id) {
    const row = conn.prepare('SELECT * FROM filamentos WHERE id = ?').get(Number(id));
    return row ? rowToFilamento(row) : null;
  },
  insert({ material, marca, cor, corHex, precoPorKg, pesoRoloGramas, estoqueAtualGramas, estoqueMinimoGramas }) {
    const r = conn
      .prepare(
        'INSERT INTO filamentos (material, marca, cor, cor_hex, preco_por_kg, peso_rolo_gramas, estoque_atual_gramas, estoque_minimo_gramas) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(material, marca || '', cor, corHex || '', precoPorKg, pesoRoloGramas, estoqueAtualGramas, estoqueMinimoGramas);
    return filamentos.findById(r.lastInsertRowid);
  },
  update(id, patch) {
    updateRow('filamentos', Number(id), patch, {
      material: 'material',
      marca: 'marca',
      cor: 'cor',
      corHex: 'cor_hex',
      precoPorKg: 'preco_por_kg',
      pesoRoloGramas: 'peso_rolo_gramas',
      estoqueAtualGramas: 'estoque_atual_gramas',
      estoqueMinimoGramas: 'estoque_minimo_gramas'
    });
    return filamentos.findById(id);
  },
  ajustarEstoque(id, deltaGramas) {
    conn.prepare('UPDATE filamentos SET estoque_atual_gramas = estoque_atual_gramas + ? WHERE id = ?').run(deltaGramas, Number(id));
    return filamentos.findById(id);
  }
};

// ---------- CATÁLOGO DE CORES (referência, não é estoque) ----------
function rowToCatalogoCor(row) {
  return {
    id: row.id,
    material: row.material,
    marca: row.marca,
    cor: row.cor,
    corHex: row.cor_hex
  };
}
const catalogoCores = {
  all() {
    return conn.prepare('SELECT * FROM catalogo_cores ORDER BY marca, material, cor').all().map(rowToCatalogoCor);
  },
  findById(id) {
    const row = conn.prepare('SELECT * FROM catalogo_cores WHERE id = ?').get(Number(id));
    return row ? rowToCatalogoCor(row) : null;
  },
  insert({ material, marca, cor, corHex }) {
    const r = conn
      .prepare('INSERT INTO catalogo_cores (material, marca, cor, cor_hex) VALUES (?, ?, ?, ?)')
      .run(material || '', marca || '', cor || '', corHex || '');
    return catalogoCores.findById(r.lastInsertRowid);
  },
  update(id, patch) {
    updateRow('catalogo_cores', Number(id), patch, {
      material: 'material',
      marca: 'marca',
      cor: 'cor',
      corHex: 'cor_hex'
    });
    return catalogoCores.findById(id);
  },
  remove(id) {
    conn.prepare('DELETE FROM catalogo_cores WHERE id = ?').run(Number(id));
  }
};

// ---------- MOVIMENTAÇÕES DE ESTOQUE ----------
const movimentacoesEstoque = {
  insert({ filamentoId, tipo, gramas, data, obs }) {
    const r = conn
      .prepare('INSERT INTO movimentacoes_estoque (filamento_id, tipo, gramas, data, obs) VALUES (?, ?, ?, ?, ?)')
      .run(Number(filamentoId), tipo, gramas, data, obs || '');
    return { id: r.lastInsertRowid, filamentoId: Number(filamentoId), tipo, gramas, data, obs: obs || '' };
  }
};

// ---------- PRODUTOS ----------
function rowToProduto(row) {
  return {
    id: row.id,
    nome: row.nome,
    descricao: row.descricao,
    dimensoes: row.dimensoes,
    corFilamento: row.cor_filamento,
    modeloRef: row.modelo_ref,
    imagem: row.imagem,
    createdAt: row.created_at
  };
}
const produtos = {
  all() {
    return conn.prepare('SELECT * FROM produtos ORDER BY id').all().map(rowToProduto);
  },
  findById(id) {
    const row = conn.prepare('SELECT * FROM produtos WHERE id = ?').get(Number(id));
    return row ? rowToProduto(row) : null;
  },
  insert({ nome, descricao, dimensoes, corFilamento, modeloRef, imagem, createdAt }) {
    const r = conn
      .prepare(
        'INSERT INTO produtos (nome, descricao, dimensoes, cor_filamento, modelo_ref, imagem, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(nome || '', descricao || '', dimensoes || '', corFilamento || '', modeloRef || '', imagem || null, createdAt);
    return produtos.findById(r.lastInsertRowid);
  },
  update(id, patch) {
    updateRow('produtos', Number(id), patch, {
      nome: 'nome',
      descricao: 'descricao',
      dimensoes: 'dimensoes',
      corFilamento: 'cor_filamento',
      modeloRef: 'modelo_ref',
      imagem: 'imagem'
    });
    return produtos.findById(id);
  }
};

// ---------- VARIAÇÕES ----------
function rowToVariacao(row) {
  return {
    id: row.id,
    produtoId: row.produto_id,
    nome: row.nome,
    descricao: row.descricao,
    modeloRef: row.modelo_ref,
    dimensoes: row.dimensoes,
    pesoGramas: row.peso_gramas,
    tempoHoras: row.tempo_horas,
    filamentoIdSugerido: row.filamento_id_sugerido,
    impressoraIdSugerida: row.impressora_id_sugerida,
    precoVenda: row.preco_venda
  };
}
const variacoes = {
  all() {
    return conn.prepare('SELECT * FROM variacoes ORDER BY id').all().map(rowToVariacao);
  },
  porProduto(produtoId) {
    return conn.prepare('SELECT * FROM variacoes WHERE produto_id = ? ORDER BY id').all(Number(produtoId)).map(rowToVariacao);
  },
  findById(id) {
    const row = conn.prepare('SELECT * FROM variacoes WHERE id = ?').get(Number(id));
    return row ? rowToVariacao(row) : null;
  },
  insert({ produtoId, nome, descricao, modeloRef, dimensoes, pesoGramas, tempoHoras, filamentoIdSugerido, impressoraIdSugerida, precoVenda }) {
    const r = conn
      .prepare(
        `INSERT INTO variacoes
          (produto_id, nome, descricao, modelo_ref, dimensoes, peso_gramas, tempo_horas, filamento_id_sugerido, impressora_id_sugerida, preco_venda)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        Number(produtoId),
        nome || '',
        descricao || '',
        modeloRef || '',
        dimensoes || '',
        pesoGramas === undefined || pesoGramas === '' ? null : Number(pesoGramas),
        tempoHoras === undefined || tempoHoras === '' ? null : Number(tempoHoras),
        filamentoIdSugerido ? Number(filamentoIdSugerido) : null,
        impressoraIdSugerida ? Number(impressoraIdSugerida) : null,
        precoVenda === undefined || precoVenda === '' || precoVenda === null ? null : Number(precoVenda)
      );
    return variacoes.findById(r.lastInsertRowid);
  },
  update(id, patch) {
    const conv = Object.assign({}, patch);
    ['pesoGramas', 'tempoHoras', 'precoVenda'].forEach((k) => {
      if (k in conv) conv[k] = conv[k] === '' || conv[k] === null ? null : Number(conv[k]);
    });
    ['filamentoIdSugerido', 'impressoraIdSugerida'].forEach((k) => {
      if (k in conv) conv[k] = conv[k] ? Number(conv[k]) : null;
    });
    updateRow('variacoes', Number(id), conv, {
      nome: 'nome',
      descricao: 'descricao',
      modeloRef: 'modelo_ref',
      dimensoes: 'dimensoes',
      pesoGramas: 'peso_gramas',
      tempoHoras: 'tempo_horas',
      filamentoIdSugerido: 'filamento_id_sugerido',
      impressoraIdSugerida: 'impressora_id_sugerida',
      precoVenda: 'preco_venda'
    });
    return variacoes.findById(id);
  },
  remove(id) {
    conn.prepare('DELETE FROM variacoes WHERE id = ?').run(Number(id));
  }
};

// ---------- CLIENTES ----------
function rowToCliente(row) {
  return {
    id: row.id,
    nome: row.nome,
    contato: row.contato,
    email: row.email,
    endereco: row.endereco,
    observacoes: row.observacoes,
    createdAt: row.created_at
  };
}
const clientes = {
  all() {
    return conn.prepare('SELECT * FROM clientes ORDER BY id').all().map(rowToCliente);
  },
  findById(id) {
    const row = conn.prepare('SELECT * FROM clientes WHERE id = ?').get(Number(id));
    return row ? rowToCliente(row) : null;
  },
  insert({ nome, contato, email, endereco, observacoes, createdAt }) {
    const r = conn
      .prepare('INSERT INTO clientes (nome, contato, email, endereco, observacoes, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(nome || '', contato || '', email || '', endereco || '', observacoes || '', createdAt);
    return clientes.findById(r.lastInsertRowid);
  },
  update(id, patch) {
    updateRow('clientes', Number(id), patch, {
      nome: 'nome',
      contato: 'contato',
      email: 'email',
      endereco: 'endereco',
      observacoes: 'observacoes'
    });
    return clientes.findById(id);
  }
};

// ---------- CONTAS FINANCEIRAS ----------
function rowToConta(row) {
  return { id: row.id, nome: row.nome, tipo: row.tipo, saldoInicial: row.saldo_inicial, saldoAtual: row.saldo_atual };
}
const contasFinanceiras = {
  all() {
    return conn.prepare('SELECT * FROM contas_financeiras ORDER BY id').all().map(rowToConta);
  },
  findById(id) {
    const row = conn.prepare('SELECT * FROM contas_financeiras WHERE id = ?').get(Number(id));
    return row ? rowToConta(row) : null;
  },
  insert({ nome, tipo, saldoInicial }) {
    const saldo = Number(saldoInicial || 0);
    const r = conn
      .prepare('INSERT INTO contas_financeiras (nome, tipo, saldo_inicial, saldo_atual) VALUES (?, ?, ?, ?)')
      .run(nome || '', tipo || 'outro', saldo, saldo);
    return contasFinanceiras.findById(r.lastInsertRowid);
  },
  update(id, patch) {
    updateRow('contas_financeiras', Number(id), patch, { nome: 'nome', tipo: 'tipo' });
    return contasFinanceiras.findById(id);
  },
  ajustarSaldo(id, delta) {
    conn.prepare('UPDATE contas_financeiras SET saldo_atual = saldo_atual + ? WHERE id = ?').run(delta, Number(id));
    return contasFinanceiras.findById(id);
  }
};

// ---------- SÓCIOS ----------
function rowToSocio(row) {
  return { id: row.id, nome: row.nome };
}
const socios = {
  all() {
    return conn.prepare('SELECT * FROM socios ORDER BY id').all().map(rowToSocio);
  },
  findById(id) {
    const row = conn.prepare('SELECT * FROM socios WHERE id = ?').get(Number(id));
    return row ? rowToSocio(row) : null;
  },
  insert({ nome }) {
    const r = conn.prepare('INSERT INTO socios (nome) VALUES (?)').run(nome || '');
    return socios.findById(r.lastInsertRowid);
  },
  update(id, patch) {
    updateRow('socios', Number(id), patch, { nome: 'nome' });
    return socios.findById(id);
  }
};

// ---------- MOVIMENTAÇÕES FINANCEIRAS ----------
function rowToMov(row) {
  return {
    id: row.id,
    tipo: row.tipo,
    valor: row.valor,
    contaId: row.conta_id,
    formaPagamento: row.forma_pagamento,
    categoria: row.categoria,
    categoriaDetalhe: row.categoria_detalhe,
    descricao: row.descricao,
    pedidoId: row.pedido_id,
    responsavelId: row.responsavel_id,
    reembolsado: fromInt(row.reembolsado),
    reembolsoId: row.reembolso_id,
    estornado: fromInt(row.estornado),
    estornoDe: row.estorno_de,
    data: row.data,
    criadoEm: row.criado_em
  };
}
const movimentacoesFinanceiras = {
  all(filtros) {
    filtros = filtros || {};
    const clauses = [];
    const bind = [];
    if (filtros.contaId) {
      clauses.push('conta_id = ?');
      bind.push(Number(filtros.contaId));
    }
    if (filtros.tipo) {
      clauses.push('tipo = ?');
      bind.push(filtros.tipo);
    }
    if (filtros.formaPagamento) {
      clauses.push('forma_pagamento = ?');
      bind.push(filtros.formaPagamento);
    }
    if (filtros.categoria) {
      clauses.push('categoria = ?');
      bind.push(filtros.categoria);
    }
    if (filtros.socioId) {
      clauses.push('responsavel_id = ?');
      bind.push(Number(filtros.socioId));
    }
    if (filtros.de) {
      clauses.push('data >= ?');
      bind.push(filtros.de);
    }
    if (filtros.ate) {
      clauses.push('data <= ?');
      bind.push(filtros.ate + 'T23:59:59.999Z');
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return conn
      .prepare(`SELECT * FROM movimentacoes_financeiras ${where} ORDER BY data DESC, id DESC`)
      .all(...bind)
      .map(rowToMov);
  },
  findById(id) {
    const row = conn.prepare('SELECT * FROM movimentacoes_financeiras WHERE id = ?').get(Number(id));
    return row ? rowToMov(row) : null;
  },
  insert(m) {
    const r = conn
      .prepare(
        `INSERT INTO movimentacoes_financeiras
          (tipo, valor, conta_id, forma_pagamento, categoria, categoria_detalhe, descricao, pedido_id, responsavel_id, reembolsado, reembolso_id, estornado, estorno_de, data, criado_em)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        m.tipo,
        m.valor,
        m.contaId || null,
        m.formaPagamento,
        m.categoria,
        m.categoriaDetalhe || null,
        m.descricao || '',
        m.pedidoId || null,
        m.responsavelId || null,
        toInt(m.reembolsado),
        m.reembolsoId || null,
        toInt(m.estornado),
        m.estornoDe || null,
        m.data,
        m.criadoEm
      );
    return movimentacoesFinanceiras.findById(r.lastInsertRowid);
  },
  marcarEstornado(id) {
    conn.prepare('UPDATE movimentacoes_financeiras SET estornado = 1 WHERE id = ?').run(Number(id));
  },
  marcarReembolsado(ids, reembolsoId) {
    const stmt = conn.prepare('UPDATE movimentacoes_financeiras SET reembolsado = 1, reembolso_id = ? WHERE id = ?');
    ids.forEach((id) => stmt.run(Number(reembolsoId), Number(id)));
  },
  pendenciasSocio(socioId, ids) {
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(',');
    return conn
      .prepare(
        `SELECT * FROM movimentacoes_financeiras
          WHERE responsavel_id = ? AND conta_id IS NULL AND tipo = 'saida' AND reembolsado = 0 AND estornado = 0 AND id IN (${placeholders})`
      )
      .all(Number(socioId), ...ids.map(Number))
      .map(rowToMov);
  }
};

// ---------- PAGAMENTOS DE PEDIDO ----------
function rowToPagamentoPedido(row) {
  return {
    id: row.id,
    pedidoId: row.pedido_id,
    valor: row.valor,
    formaPagamento: row.forma_pagamento,
    contaId: row.conta_id,
    movimentacaoFinanceiraId: row.movimentacao_financeira_id,
    dataPagamento: row.data_pagamento,
    estornado: fromInt(row.estornado)
  };
}
const pagamentosPedido = {
  porPedido(pedidoId) {
    return conn
      .prepare('SELECT * FROM pagamentos_pedido WHERE pedido_id = ? ORDER BY id')
      .all(Number(pedidoId))
      .map(rowToPagamentoPedido);
  },
  findById(id) {
    const row = conn.prepare('SELECT * FROM pagamentos_pedido WHERE id = ?').get(Number(id));
    return row ? rowToPagamentoPedido(row) : null;
  },
  insert(p) {
    const r = conn
      .prepare(
        `INSERT INTO pagamentos_pedido
          (pedido_id, valor, forma_pagamento, conta_id, movimentacao_financeira_id, data_pagamento)
          VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(Number(p.pedidoId), p.valor, p.formaPagamento, p.contaId || null, p.movimentacaoFinanceiraId || null, p.dataPagamento);
    return pagamentosPedido.findById(r.lastInsertRowid);
  },
  marcarEstornado(id) {
    conn.prepare('UPDATE pagamentos_pedido SET estornado = 1 WHERE id = ?').run(Number(id));
  }
};

// ---------- PEDIDOS + ITENS ----------
function rowToItem(row) {
  return {
    id: row.id,
    produtoId: row.produto_id,
    pecaJaFeita: fromInt(row.peca_ja_feita),
    modeloRef: row.modelo_ref,
    descricao: row.descricao,
    dimensoes: row.dimensoes,
    variacao: row.variacao,
    corFilamento: row.cor_filamento,
    imagem: row.imagem,
    quantidade: row.quantidade,
    status: row.status,
    orcamento: row.orcamento_json ? JSON.parse(row.orcamento_json) : null,
    impressoraId: row.impressora_id,
    inicioImpressao: row.inicio_impressao,
    fimImpressao: row.fim_impressao,
    falhaReimpressao: fromInt(row.falha_reimpressao),
    motivoFalha: row.motivo_falha
  };
}
function rowToPedido(row, itensDoPedido) {
  return {
    id: row.id,
    createdAt: row.created_at,
    clienteId: row.cliente_id,
    cliente: row.cliente,
    contato: row.contato,
    vendedor: row.vendedor,
    observacoes: row.observacoes,
    status: row.status,
    statusPagamento: row.status_pagamento,
    aprovadoEm: row.aprovado_em,
    formaPagamentoCombinada: row.forma_pagamento_combinada,
    motivoRecusa: row.motivo_recusa,
    statusEntrega: row.status_entrega,
    entregueEm: row.entregue_em,
    formaPagamento: row.forma_pagamento,
    contaId: row.conta_id,
    movimentacaoFinanceiraId: row.movimentacao_financeira_id,
    dataPagamento: row.data_pagamento,
    idPlataforma: row.id_plataforma,
    itens: itensDoPedido,
    pagamentos: pagamentosPedido.porPedido(row.id)
  };
}
function itensDoPedido(pedidoId) {
  return conn.prepare('SELECT * FROM itens WHERE pedido_id = ? ORDER BY id').all(Number(pedidoId)).map(rowToItem);
}

const pedidos = {
  all(filtros) {
    filtros = filtros || {};
    const clauses = [];
    const bind = [];
    if (filtros.status) {
      clauses.push('status = ?');
      bind.push(filtros.status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = conn.prepare(`SELECT * FROM pedidos ${where} ORDER BY created_at DESC, id DESC`).all(...bind);
    return rows.map((row) => rowToPedido(row, itensDoPedido(row.id)));
  },
  findById(id) {
    const row = conn.prepare('SELECT * FROM pedidos WHERE id = ?').get(Number(id));
    if (!row) return null;
    return rowToPedido(row, itensDoPedido(row.id));
  },
  insert({ clienteId, cliente, contato, vendedor, observacoes, itens: itensBody, createdAt, status, statusPagamento, idPlataforma }) {
    conn.exec('BEGIN');
    try {
      const r = conn
        .prepare(
          'INSERT INTO pedidos (created_at, cliente_id, cliente, contato, vendedor, observacoes, status, status_pagamento, id_plataforma) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(createdAt, clienteId || null, cliente || '', contato || '', vendedor || '', observacoes || '', status, statusPagamento, idPlataforma || null);
      const pedidoId = r.lastInsertRowid;
      const insertItem = conn.prepare(
        `INSERT INTO itens
          (pedido_id, produto_id, peca_ja_feita, modelo_ref, descricao, dimensoes, variacao, cor_filamento, imagem, quantidade, status, orcamento_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      (itensBody || []).forEach((it) => {
        insertItem.run(
          pedidoId,
          it.produtoId || null,
          toInt(it.pecaJaFeita),
          it.modeloRef || '',
          it.descricao || '',
          it.dimensoes || '',
          it.variacao || '',
          it.corFilamento || '',
          it.imagem || null,
          it.quantidade,
          it.status,
          it.orcamento ? JSON.stringify(it.orcamento) : null
        );
      });
      conn.exec('COMMIT');
      return pedidos.findById(pedidoId);
    } catch (e) {
      conn.exec('ROLLBACK');
      throw e;
    }
  },
  update(id, patch) {
    updateRow('pedidos', Number(id), patch, {
      status: 'status',
      statusPagamento: 'status_pagamento',
      aprovadoEm: 'aprovado_em',
      formaPagamentoCombinada: 'forma_pagamento_combinada',
      motivoRecusa: 'motivo_recusa',
      statusEntrega: 'status_entrega',
      entregueEm: 'entregue_em',
      formaPagamento: 'forma_pagamento',
      contaId: 'conta_id',
      movimentacaoFinanceiraId: 'movimentacao_financeira_id',
      dataPagamento: 'data_pagamento',
      idPlataforma: 'id_plataforma',
      cliente: 'cliente',
      clienteId: 'cliente_id',
      contato: 'contato',
      vendedor: 'vendedor',
      observacoes: 'observacoes'
    });
    return pedidos.findById(id);
  },
  remove(id) {
    conn.prepare('DELETE FROM pagamentos_pedido WHERE pedido_id = ?').run(Number(id));
    conn.prepare('DELETE FROM pedidos WHERE id = ?').run(Number(id));
  }
};

const itens = {
  insert({ pedidoId, produtoId, pecaJaFeita, modeloRef, descricao, dimensoes, variacao, corFilamento, imagem, quantidade, status, orcamento }) {
    const r = conn
      .prepare(
        `INSERT INTO itens
          (pedido_id, produto_id, peca_ja_feita, modelo_ref, descricao, dimensoes, variacao, cor_filamento, imagem, quantidade, status, orcamento_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        Number(pedidoId),
        produtoId || null,
        toInt(pecaJaFeita),
        modeloRef || '',
        descricao || '',
        dimensoes || '',
        variacao || '',
        corFilamento || '',
        imagem || null,
        quantidade,
        status,
        orcamento ? JSON.stringify(orcamento) : null
      );
    return r.lastInsertRowid;
  },
  remove(id) {
    conn.prepare('DELETE FROM itens WHERE id = ?').run(Number(id));
  },
  update(id, patch) {
    const conv = Object.assign({}, patch);
    if ('falhaReimpressao' in conv) conv.falhaReimpressao = toInt(conv.falhaReimpressao);
    if ('orcamento' in conv) {
      conn
        .prepare('UPDATE itens SET orcamento_json = ? WHERE id = ?')
        .run(conv.orcamento ? JSON.stringify(conv.orcamento) : null, Number(id));
      delete conv.orcamento;
    }
    updateRow('itens', Number(id), conv, {
      status: 'status',
      impressoraId: 'impressora_id',
      inicioImpressao: 'inicio_impressao',
      fimImpressao: 'fim_impressao',
      falhaReimpressao: 'falha_reimpressao',
      motivoFalha: 'motivo_falha',
      descricao: 'descricao',
      dimensoes: 'dimensoes',
      variacao: 'variacao',
      corFilamento: 'cor_filamento',
      modeloRef: 'modelo_ref',
      quantidade: 'quantidade',
      produtoId: 'produto_id',
      imagem: 'imagem'
    });
  }
};

// ---------- CONTAS A PAGAR ----------
function rowToParcela(row) {
  return {
    id: row.id,
    contaAPagarId: row.conta_a_pagar_id,
    numero: row.numero,
    totalParcelas: row.total_parcelas,
    valor: row.valor,
    vencimento: row.vencimento,
    paga: fromInt(row.paga),
    cancelada: fromInt(row.cancelada),
    movimentacaoFinanceiraId: row.movimentacao_financeira_id,
    dataPagamento: row.data_pagamento
  };
}
const parcelasContaAPagar = {
  porConta(contaAPagarId) {
    return conn
      .prepare('SELECT * FROM contas_a_pagar_parcelas WHERE conta_a_pagar_id = ? ORDER BY numero')
      .all(Number(contaAPagarId))
      .map(rowToParcela);
  },
  findById(id) {
    const row = conn.prepare('SELECT * FROM contas_a_pagar_parcelas WHERE id = ?').get(Number(id));
    return row ? rowToParcela(row) : null;
  },
  insert({ contaAPagarId, numero, totalParcelas, valor, vencimento }) {
    conn
      .prepare(
        `INSERT INTO contas_a_pagar_parcelas (conta_a_pagar_id, numero, total_parcelas, valor, vencimento)
          VALUES (?, ?, ?, ?, ?)`
      )
      .run(Number(contaAPagarId), numero, totalParcelas, valor, vencimento);
  },
  marcarPaga(id, { movimentacaoFinanceiraId, dataPagamento }) {
    conn
      .prepare('UPDATE contas_a_pagar_parcelas SET paga = 1, movimentacao_financeira_id = ?, data_pagamento = ? WHERE id = ?')
      .run(Number(movimentacaoFinanceiraId), dataPagamento, Number(id));
  },
  marcarNaoPaga(id) {
    conn
      .prepare('UPDATE contas_a_pagar_parcelas SET paga = 0, movimentacao_financeira_id = NULL, data_pagamento = NULL WHERE id = ?')
      .run(Number(id));
  },
  cancelarPendentes(contaAPagarId) {
    conn
      .prepare('UPDATE contas_a_pagar_parcelas SET cancelada = 1 WHERE conta_a_pagar_id = ? AND paga = 0')
      .run(Number(contaAPagarId));
  },
  findByMovimentacaoId(movimentacaoId) {
    const row = conn.prepare('SELECT * FROM contas_a_pagar_parcelas WHERE movimentacao_financeira_id = ?').get(Number(movimentacaoId));
    return row ? rowToParcela(row) : null;
  }
};

function rowToContaAPagar(row, parcelas) {
  return {
    id: row.id,
    descricao: row.descricao,
    categoria: row.categoria,
    categoriaDetalhe: row.categoria_detalhe,
    criadoEm: row.criado_em,
    parcelas
  };
}
const contasAPagar = {
  all() {
    return conn
      .prepare('SELECT * FROM contas_a_pagar ORDER BY id DESC')
      .all()
      .map((row) => rowToContaAPagar(row, parcelasContaAPagar.porConta(row.id)));
  },
  findById(id) {
    const row = conn.prepare('SELECT * FROM contas_a_pagar WHERE id = ?').get(Number(id));
    return row ? rowToContaAPagar(row, parcelasContaAPagar.porConta(row.id)) : null;
  },
  insert({ descricao, categoria, categoriaDetalhe }) {
    const r = conn
      .prepare('INSERT INTO contas_a_pagar (descricao, categoria, categoria_detalhe, criado_em) VALUES (?, ?, ?, ?)')
      .run(descricao, categoria, categoriaDetalhe || null, new Date().toISOString());
    return contasAPagar.findById(r.lastInsertRowid);
  },
  remove(id) {
    conn.prepare('DELETE FROM contas_a_pagar_parcelas WHERE conta_a_pagar_id = ?').run(Number(id));
    conn.prepare('DELETE FROM contas_a_pagar WHERE id = ?').run(Number(id));
  }
};

// ---------- SEED (instalação nova) ----------
function seedIfEmpty() {
  const count = conn.prepare('SELECT COUNT(*) AS c FROM usuarios').get().c;
  if (count > 0) return;
  const epoch = new Date(0).toISOString();
  conn.prepare('INSERT INTO params (id, tarifa_kwh, margem_padrao) VALUES (1, ?, ?)').run(0.5, 100);

  const adminEmail = process.env.SEED_ADMIN_EMAIL || 'admin@admin.com';
  const senhaInicial = crypto.randomBytes(9).toString('base64url');
  const { salt, hash } = hashPassword(senhaInicial);
  conn
    .prepare('INSERT INTO usuarios (id, nome, email, senha_salt, senha_hash, papel, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(1, 'Admin', adminEmail, salt, hash, 'admin', epoch);
  console.log('==========================================================');
  console.log(`Usuário inicial criado: ${adminEmail}`);
  console.log(`Senha temporária: ${senhaInicial}`);
  console.log('Troque a senha assim que entrar (Usuários → clique na sua linha).');
  console.log('==========================================================');
  const insImp = conn.prepare('INSERT INTO impressoras (id, nome, potencia_w, ativa) VALUES (?, ?, ?, 1)');
  [
    [1, 'Impressora 1', 200],
    [2, 'Impressora 2', 200],
    [3, 'Impressora 3', 250],
    [4, 'Impressora 4', 250],
    [5, 'Impressora 5', 300]
  ].forEach(([id, nome, w]) => insImp.run(id, nome, w));
  const insFil = conn.prepare(
    'INSERT INTO filamentos (id, material, marca, cor, preco_por_kg, peso_rolo_gramas, estoque_atual_gramas, estoque_minimo_gramas) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  insFil.run(1, 'PLA', '', 'Preto', 120, 1000, 1000, 200);
  insFil.run(2, 'PLA', '', 'Branco', 120, 1000, 1000, 200);
  insFil.run(3, 'PETG', '', 'Preto', 150, 1000, 1000, 200);
  const insConta = conn.prepare('INSERT INTO contas_financeiras (id, nome, tipo, saldo_inicial, saldo_atual) VALUES (?, ?, ?, 0, 0)');
  insConta.run(1, 'Caixa (dinheiro físico)', 'caixa');
  insConta.run(2, 'Banco Inter', 'banco');
  insConta.run(3, 'Carteira Shopee', 'carteira_digital');
  const insSocio = conn.prepare('INSERT INTO socios (id, nome) VALUES (?, ?)');
  insSocio.run(1, 'Lucas');
  insSocio.run(2, 'Murilo');
}
seedIfEmpty();

module.exports = {
  DB_PATH,
  params,
  usuarios,
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
};
