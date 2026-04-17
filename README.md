# 🧩 Sistema de Gestão para Impressão 3D (ERP 3D)

Sistema completo de gestão (ERP) desenvolvido para operações de impressão 3D, com foco em automação de orçamentos, controle de produção via Kanban, gestão de estoque com custo médio e controle financeiro.

---

## 🎯 Objetivo

Centralizar e automatizar os principais processos de uma operação de impressão 3D:

* 📦 Controle de estoque (com custo médio e lotes)
* 🧱 Cadastro de produtos com variações
* 💰 Geração de orçamentos automáticos
* 🛠️ Gestão de produção via Kanban
* 📋 Controle de pedidos
* 💸 Contas a pagar e receber
* 🏭 Gestão de fornecedores
* 📄 Geração de PDF de orçamento com identidade visual

---

## 🏗️ Arquitetura (Visão Geral)

O sistema foi projetado de forma modular e escalável:

* **Backend:** API responsável pelas regras de negócio
* **Frontend:** Interface para operação diária
* **Banco de Dados:** Persistência estruturada e relacional

> Arquitetura sugerida: RESTful + separação clara de camadas (Controller → Service → Repository)

---

## 📦 Módulos do Sistema

### 👤 Clientes

Gerenciamento de clientes.

Campos:

* Nome (obrigatório)
* Telefone
* CPF
* Endereço

---

### 📦 Estoque

Controle completo com rastreabilidade.

#### Funcionalidades:

* Controle por **lote**
* Cálculo de **custo médio**
* Histórico de movimentações
* Alerta de estoque mínimo

#### Conceitos:

* Item (ex: PLA Preto)
* Lote (compra específica)
* Movimentação (entrada, saída, ajuste)

---

### 🧱 Produtos

Estrutura baseada em variações.

#### Inclui:

* Produto base
* Variações (tamanho/dimensões)
* Consumo de material por variação

---

### 💰 Orçamentos

Geração automatizada com base em custos reais.

#### Cálculo automático:

* Material (baseado no estoque)
* Tempo de máquina
* Energia

#### Recursos:

* Ajuste manual de valores
* Margem de lucro
* Snapshot dos dados
* Conversão em pedido

---

### 📄 PDF de Orçamento

Geração automática de documento profissional.

#### Inclui:

* Logo da empresa
* Dados do cliente
* Itens orçados
* Valor final
* Rodapé personalizado

---

### 📋 Pedidos

Controle do ciclo completo da produção.

#### Status:

* Orçamento aprovado
* Aguardando produção
* Em produção
* Finalizado
* Entregue
* Cancelado

#### Regras:

* Snapshot dos dados no momento da criação
* Integração com estoque (baixa automática)

---

### 🛠️ Kanban de Produção

Visualização operacional do fluxo.

#### Características:

* Baseado no status do pedido
* Drag & drop
* Atualização automática
* Priorização

---

### 💸 Contas a Pagar

Controle de despesas e obrigações.

* Vencimento
* Status (pendente, pago, atrasado)
* Integração com compras

---

### 💰 Contas a Receber

Controle de receitas.

* Vinculado ao pedido
* Controle de recebimento
* Status automático

---

### 🏭 Fornecedores

Gestão de parceiros e compras.

* Cadastro completo
* Histórico de compras
* Integração com estoque e financeiro

---

### ⚙️ Configurações

Personalização do sistema.

#### Inclui:

* Dados da empresa
* Upload de logo
* Configuração de PDF
* Texto de rodapé

---

## 🔗 Integrações entre Módulos

* Produto → define consumo
* Estoque → fornece custo
* Orçamento → calcula preço
* Pedido → executa produção
* Kanban → controla fluxo
* Financeiro → controla entradas e saídas
* Configurações → personaliza documentos

---

## ⚙️ Regras de Negócio Importantes

* Todo movimento de estoque deve ser rastreável
* Nunca alterar estoque diretamente
* Orçamentos e pedidos usam **snapshot**
* Permitir ajustes manuais em cálculos
* Sistema deve ser operacional (fácil uso)

---

## 🚀 Roadmap (Evolução)

### MVP

* Estoque (custo médio)
* Produtos
* Orçamento automático
* Pedido + Kanban básico

### Próximas fases

* Controle por lote completo (FIFO)
* PDF avançado
* Dashboard financeiro
* Integração com WhatsApp
* Integração com slicer (peso real)
* Multi-impressoras

---

## 🧠 Filosofia do Sistema

* Simples para o usuário
* Robusto nas regras
* Flexível para exceções
* Escalável para crescimento

---

## 🛠️ Tecnologias Sugeridas

### Backend:

* Node.js (NestJS) ou Java (Spring Boot)

### Frontend:

* React (com Tailwind ou Material UI)

### Banco:

* PostgreSQL

### PDF:

* HTML → PDF (ex: Puppeteer)

---

## ▶️ Como Começar

1. Definir stack (backend + frontend)
2. Criar modelagem do banco
3. Implementar módulo de estoque
4. Evoluir para orçamento
5. Integrar pedidos + Kanban

---

## 📌 Status do Projeto

🚧 Em desenvolvimento — arquitetura definida e módulos estruturados.

---

## 🤝 Contribuição

Este é um sistema sob medida para operação de impressão 3D, mas pode ser adaptado para outros tipos de manufatura leve.

---

## 📄 Licença

Uso privado / projeto proprietário.
