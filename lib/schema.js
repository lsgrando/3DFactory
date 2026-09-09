function createSchema(conn) {
  conn.exec('PRAGMA foreign_keys = ON');
  conn.exec(`
    CREATE TABLE IF NOT EXISTS params (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      tarifa_kwh REAL NOT NULL,
      margem_padrao REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      senha_salt TEXT NOT NULL,
      senha_hash TEXT NOT NULL,
      papel TEXT NOT NULL DEFAULT 'vendas',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS impressoras (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      potencia_w REAL NOT NULL,
      ativa INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS filamentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      material TEXT NOT NULL,
      marca TEXT NOT NULL DEFAULT '',
      cor TEXT NOT NULL,
      cor_hex TEXT NOT NULL DEFAULT '',
      preco_por_kg REAL NOT NULL,
      peso_rolo_gramas REAL NOT NULL,
      estoque_atual_gramas REAL NOT NULL,
      estoque_minimo_gramas REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS catalogo_cores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      material TEXT NOT NULL,
      marca TEXT NOT NULL DEFAULT '',
      cor TEXT NOT NULL,
      cor_hex TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_catalogo_cores_marca ON catalogo_cores(marca);

    CREATE TABLE IF NOT EXISTS movimentacoes_estoque (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filamento_id INTEGER NOT NULL REFERENCES filamentos(id),
      tipo TEXT NOT NULL,
      gramas REAL NOT NULL,
      data TEXT NOT NULL,
      obs TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_movest_filamento ON movimentacoes_estoque(filamento_id);

    CREATE TABLE IF NOT EXISTS categorias_produto (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS produtos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL DEFAULT '',
      descricao TEXT NOT NULL DEFAULT '',
      dimensoes TEXT NOT NULL DEFAULT '',
      cor_filamento TEXT NOT NULL DEFAULT '',
      modelo_ref TEXT NOT NULL DEFAULT '',
      imagem TEXT,
      ativo INTEGER NOT NULL DEFAULT 1,
      categoria_id INTEGER REFERENCES categorias_produto(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS variacoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      produto_id INTEGER NOT NULL REFERENCES produtos(id),
      nome TEXT NOT NULL,
      descricao TEXT NOT NULL DEFAULT '',
      modelo_ref TEXT NOT NULL DEFAULT '',
      dimensoes TEXT NOT NULL DEFAULT '',
      peso_gramas REAL,
      tempo_horas REAL,
      filamento_id_sugerido INTEGER,
      impressora_id_sugerida INTEGER,
      preco_venda REAL
    );
    CREATE INDEX IF NOT EXISTS idx_variacoes_produto ON variacoes(produto_id);

    CREATE TABLE IF NOT EXISTS clientes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL DEFAULT '',
      contato TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      endereco TEXT NOT NULL DEFAULT '',
      observacoes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS contas_financeiras (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      tipo TEXT NOT NULL,
      saldo_inicial REAL NOT NULL DEFAULT 0,
      saldo_atual REAL NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS socios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS taxas_cartao (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tipo TEXT NOT NULL,
      parcelas INTEGER NOT NULL DEFAULT 1,
      taxa_percentual REAL NOT NULL,
      UNIQUE(tipo, parcelas)
    );

    CREATE TABLE IF NOT EXISTS movimentacoes_financeiras (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tipo TEXT NOT NULL,
      valor REAL NOT NULL,
      conta_id INTEGER REFERENCES contas_financeiras(id),
      forma_pagamento TEXT NOT NULL,
      categoria TEXT NOT NULL,
      categoria_detalhe TEXT,
      descricao TEXT NOT NULL DEFAULT '',
      pedido_id INTEGER,
      responsavel_id INTEGER REFERENCES socios(id),
      reembolsado INTEGER NOT NULL DEFAULT 0,
      reembolso_id INTEGER,
      estornado INTEGER NOT NULL DEFAULT 0,
      estorno_de INTEGER,
      data TEXT NOT NULL,
      criado_em TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_movfin_conta ON movimentacoes_financeiras(conta_id);
    CREATE INDEX IF NOT EXISTS idx_movfin_responsavel ON movimentacoes_financeiras(responsavel_id);
    CREATE INDEX IF NOT EXISTS idx_movfin_tipo ON movimentacoes_financeiras(tipo);
    CREATE INDEX IF NOT EXISTS idx_movfin_data ON movimentacoes_financeiras(data);

    CREATE TABLE IF NOT EXISTS pedidos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      cliente_id INTEGER,
      cliente TEXT NOT NULL DEFAULT '',
      contato TEXT NOT NULL DEFAULT '',
      vendedor TEXT NOT NULL DEFAULT '',
      observacoes TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      status_pagamento TEXT NOT NULL,
      aprovado_em TEXT,
      forma_pagamento_combinada TEXT,
      motivo_recusa TEXT,
      status_entrega TEXT,
      entregue_em TEXT,
      forma_pagamento TEXT,
      conta_id INTEGER,
      movimentacao_financeira_id INTEGER,
      data_pagamento TEXT,
      id_plataforma TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pedidos_status ON pedidos(status);

    CREATE TABLE IF NOT EXISTS pagamentos_pedido (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pedido_id INTEGER NOT NULL REFERENCES pedidos(id),
      valor REAL NOT NULL,
      desconto REAL NOT NULL DEFAULT 0,
      forma_pagamento TEXT NOT NULL,
      conta_id INTEGER REFERENCES contas_financeiras(id),
      movimentacao_financeira_id INTEGER,
      data_pagamento TEXT NOT NULL,
      estornado INTEGER NOT NULL DEFAULT 0,
      comprovante TEXT,
      parcelas_cartao INTEGER,
      taxa_percentual REAL,
      valor_liquido REAL,
      taxa_movimentacao_financeira_id INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_pagpedido_pedido ON pagamentos_pedido(pedido_id);

    CREATE TABLE IF NOT EXISTS despesas_pedido (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pedido_id INTEGER NOT NULL REFERENCES pedidos(id),
      descricao TEXT NOT NULL DEFAULT '',
      categoria TEXT NOT NULL,
      categoria_detalhe TEXT,
      valor REAL NOT NULL,
      forma_pagamento TEXT NOT NULL,
      conta_id INTEGER REFERENCES contas_financeiras(id),
      responsavel_id INTEGER REFERENCES socios(id),
      movimentacao_financeira_id INTEGER,
      estornado INTEGER NOT NULL DEFAULT 0,
      criado_em TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_despesaspedido_pedido ON despesas_pedido(pedido_id);

    CREATE TABLE IF NOT EXISTS itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pedido_id INTEGER NOT NULL REFERENCES pedidos(id),
      produto_id INTEGER,
      peca_ja_feita INTEGER NOT NULL DEFAULT 0,
      modelo_ref TEXT NOT NULL DEFAULT '',
      descricao TEXT NOT NULL DEFAULT '',
      dimensoes TEXT NOT NULL DEFAULT '',
      variacao TEXT NOT NULL DEFAULT '',
      cor_filamento TEXT NOT NULL DEFAULT '',
      imagem TEXT,
      quantidade REAL NOT NULL DEFAULT 1,
      status TEXT NOT NULL,
      orcamento_json TEXT,
      impressora_id INTEGER,
      inicio_impressao TEXT,
      fim_impressao TEXT,
      falha_reimpressao INTEGER NOT NULL DEFAULT 0,
      motivo_falha TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_itens_pedido ON itens(pedido_id);

    CREATE TABLE IF NOT EXISTS contas_a_pagar (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      descricao TEXT NOT NULL,
      categoria TEXT NOT NULL,
      categoria_detalhe TEXT,
      criado_em TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS contas_a_pagar_parcelas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conta_a_pagar_id INTEGER NOT NULL REFERENCES contas_a_pagar(id),
      numero INTEGER NOT NULL,
      total_parcelas INTEGER NOT NULL,
      valor REAL NOT NULL,
      vencimento TEXT NOT NULL,
      paga INTEGER NOT NULL DEFAULT 0,
      cancelada INTEGER NOT NULL DEFAULT 0,
      movimentacao_financeira_id INTEGER,
      data_pagamento TEXT,
      comprovante TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_parcelas_conta ON contas_a_pagar_parcelas(conta_a_pagar_id);
    CREATE INDEX IF NOT EXISTS idx_parcelas_vencimento ON contas_a_pagar_parcelas(vencimento);
  `);
}

function ensureColumn(conn, table, column, definition) {
  const cols = conn.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) {
    conn.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

module.exports = { createSchema, ensureColumn };
