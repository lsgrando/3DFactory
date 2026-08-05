# Sistema de Gestão — Impressão 3D

Aplicação web simples para gerir todo o fluxo: solicitação de orçamento (vendas) → precificação → aprovação do cliente → fila de produção (5 impressoras) → entrega → pagamento, com baixa automática de estoque de filamento por gramatura.

Feita em **Node.js puro** (sem frameworks ou dependências externas) — roda em qualquer computador com Node instalado, sem passo de instalação.

## Como rodar

Requisito: [Node.js](https://nodejs.org) versão 18 ou superior.

```bash
node server.js
```

Depois acesse **http://localhost:3000** no navegador. Isso é tudo — não há `npm install` a fazer, pois o projeto não usa bibliotecas externas.

No primeiro acesso, o sistema cria um usuário inicial e imprime o e-mail e uma senha temporária no console (defina `SEED_ADMIN_EMAIL` antes de rodar para escolher o e-mail). Troque a senha assim que entrar, em Usuários.

Os dados ficam salvos em `data/db.json` (criado automaticamente no primeiro acesso, já com 5 impressoras e 3 filamentos de exemplo cadastrados). Para começar do zero, basta apagar esse arquivo.

## Telas

- **Dashboard** (`/`) — visão geral, contadores por status e alertas.
- **Vendas** (`/vendas.html`) — criar solicitação de orçamento, ver status, registrar aprovação/recusa do cliente, marcar entrega e pagamento.
- **Orçamento** (`/orcamento.html`) — orçar pedidos pendentes (a fórmula de preço é calculada automaticamente) e ajustar parâmetros (tarifa de kWh, margem padrão).
- **Produção** (`/producao.html`) — fila de impressão, atribuição às 5 impressoras, início/conclusão (dá baixa automática no estoque) e registro de falhas/reimpressão.
- **Estoque** (`/estoque.html`) — cadastro de filamentos por material/cor, registro de compras (entradas) e alerta de estoque mínimo.

## Fórmula de precificação

Mesma lógica da planilha usada hoje na empresa:

```
custoFilamento = (precoPorKg / 1000) * pesoGramas
custoEnergia   = (potenciaW * tempoHoras / 1000) * tarifaKwh
custoTotal     = custoFilamento + custoEnergia
precoVenda     = custoTotal * (1 + margemPercentual / 100)
```

A margem padrão e a tarifa de kWh ficam em Orçamento → Parâmetros, mas podem ser sobrescritas por orçamento individual.

## Limitações e próximos passos

Este é um MVP funcional, pensado para uso interno na rede local da empresa:

- **Sem login/senha.** Qualquer pessoa com acesso ao endereço consegue usar o sistema. Se for expor na internet (fora da rede local), vale adicionar autenticação antes.
- **Armazenamento em arquivo JSON** (`data/db.json`), adequado para o volume de uma pequena empresa. Para crescer bastante ou usar em nuvem com múltiplos servidores, migrar para um banco de dados (Postgres, SQLite, etc.) é o próximo passo natural.
- **Alertas são apenas visuais** (badges no Dashboard). Notificações por WhatsApp/e-mail podem ser adicionadas depois.
- **Backup:** faça cópias periódicas do arquivo `data/db.json`.

## Hospedar para acesso remoto (opcional)

Para as duas pessoas de vendas acessarem de outro lugar (não só na rede da loja), dá para hospedar em serviços gratuitos/baratos que rodam Node.js diretamente, como Render ou Railway — não é necessário nenhum ajuste no código, só publicar a pasta e rodar `node server.js`.

Ao hospedar na internet, defina a variável de ambiente `NODE_ENV=production` — isso faz o cookie de sessão exigir HTTPS (flag `Secure`).
