function escapeHtml(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
window.escapeHtml = escapeHtml;
function escapeAttr(v) {
  return escapeHtml(v);
}
window.escapeAttr = escapeAttr;

// Só permite abrir links http(s) — bloqueia esquemas como javascript: em campos de
// URL preenchidos pelo usuário (ex.: link do modelo 3D).
function safeUrl(v) {
  const s = String(v ?? '').trim();
  return /^https?:\/\//i.test(s) ? s : '#';
}
window.safeUrl = safeUrl;

function toast(message, type = 'ok') {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 250);
  }, 3000);
}

function isLoginPage() {
  return location.pathname.endsWith('login.html');
}

async function handleResponse(r, defaultMsg) {
  let data;
  try { data = await r.json(); } catch (e) { data = {}; }
  if (r.status === 401) {
    if (!isLoginPage()) window.location.href = 'login.html';
    throw new Error(data.error || 'Não autenticado');
  }
  if (!r.ok) {
    toast(data.error || defaultMsg, 'error');
    throw new Error(data.error || defaultMsg);
  }
  return data;
}

async function apiGet(url) {
  const r = await fetch(url);
  return handleResponse(r, 'Erro ao carregar dados');
}
async function apiPost(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return handleResponse(r, 'Erro ao salvar');
}
async function apiPatch(url, body) {
  const r = await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return handleResponse(r, 'Erro ao salvar');
}
async function apiDelete(url) {
  const r = await fetch(url, { method: 'DELETE' });
  return handleResponse(r, 'Erro ao excluir');
}
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

const STATUS_LABEL = {
  novo: 'Novo',
  orcamento_pronto: 'Orçamento pronto',
  aprovado: 'Aprovado',
  recusado: 'Recusado',
  expirado: 'Expirado',
  na_fila: 'Na fila',
  imprimindo: 'Imprimindo',
  concluido: 'Concluído',
  em_entrega: 'Em entrega',
  entregue: 'Entregue'
};

function badge(status, labelOverride) {
  const label = labelOverride || STATUS_LABEL[status] || status;
  return `<span class="badge ${status}">${label}</span>`;
}

function money(v) {
  return (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

// Combobox de produto com miniatura — substitui um <select> nativo (que não suporta
// <img> dentro de <option>) por um campo de busca + lista customizada.
// root deve conter: input.produto-combobox-input e div.produto-combobox-list
function wireProdutoCombobox(root, produtos, onSelect, valorInicial) {
  const input = root.querySelector('.produto-combobox-input');
  const list = root.querySelector('.produto-combobox-list');
  const ordenados = produtos.slice().sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  let selecionadoId = valorInicial || null;

  function rotulo(id) {
    const p = ordenados.find((x) => x.id === id);
    return p ? p.nome : '';
  }
  input.value = rotulo(selecionadoId);

  function renderLista(filtro) {
    const termo = (filtro || '').trim().toLowerCase();
    const filtrados = !termo ? ordenados : ordenados.filter((p) => p.nome.toLowerCase().includes(termo));
    const limpar = `<div class="produto-combobox-item" data-id="">— Nenhum / digitar manualmente —</div>`;
    const itens = filtrados.map((p) => `
      <div class="produto-combobox-item" data-id="${p.id}">
        ${p.imagem ? `<img class="thumb" src="${escapeAttr(p.imagem)}" />` : '<span class="produto-combobox-sem-imagem"></span>'}
        <span>${escapeHtml(p.nome)}</span>
      </div>
    `).join('') || '<div class="muted" style="padding:6px 10px;font-size:13px">Nenhum produto encontrado.</div>';
    list.innerHTML = limpar + itens;
    list.style.display = 'block';
  }

  input.addEventListener('focus', () => {
    input.select();
    renderLista('');
  });
  input.addEventListener('input', () => renderLista(input.value));
  list.addEventListener('mousedown', (e) => {
    const item = e.target.closest('.produto-combobox-item');
    if (!item) return;
    e.preventDefault();
    selecionadoId = item.dataset.id ? Number(item.dataset.id) : null;
    input.value = rotulo(selecionadoId);
    list.style.display = 'none';
    onSelect(selecionadoId);
  });
  input.addEventListener('blur', () => {
    setTimeout(() => {
      list.style.display = 'none';
      input.value = rotulo(selecionadoId);
    }, 150);
  });
}
window.wireProdutoCombobox = wireProdutoCombobox;

// Seletor genérico com busca por trecho (não só prefixo) — substitui <select> nativos
// com listas longas. root deve conter: input.search-select-input e div.search-select-list.
// items: [{ value, label }]. onSelect(value) é chamado a cada escolha (value === '' se
// o item de placeholder for escolhido).
function normalizarBusca(s) {
  return (s || '').toString().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}
function wireSearchSelect(root, items, onSelect, valorInicial, placeholder) {
  const input = root.querySelector('.search-select-input');
  const list = root.querySelector('.search-select-list');
  let selecionado = (valorInicial === null || valorInicial === undefined) ? '' : String(valorInicial);

  function rotulo(valor) {
    if (!valor) return '';
    const it = items.find((x) => String(x.value) === String(valor));
    return it ? it.label : String(valor); // fallback: mostra o valor bruto se não achar mais na lista (ex.: item removido do estoque)
  }
  input.value = rotulo(selecionado);
  onSelect(selecionado); // mantém o estado externo (ex.: input hidden) em sincronia com o valor inicial

  function renderLista(filtro) {
    const termo = normalizarBusca(filtro);
    const filtrados = !termo ? items : items.filter((it) => normalizarBusca(it.label).includes(termo));
    const vazio = placeholder ? `<div class="search-select-item muted" data-value="">${placeholder}</div>` : '';
    const itens = filtrados.map((it) => {
      const swatch = it.hex ? `<span class="color-swatch" style="background:${escapeAttr(it.hex)}"></span>` : '';
      return `<div class="search-select-item" data-value="${escapeAttr(it.value)}">${swatch}${escapeHtml(it.label)}</div>`;
    }).join('') ||
      '<div class="muted" style="padding:6px 10px;font-size:13px">Nada encontrado.</div>';
    list.innerHTML = vazio + itens;
    list.style.display = 'block';
  }

  input.addEventListener('focus', () => {
    input.select();
    renderLista('');
  });
  input.addEventListener('input', () => renderLista(input.value));
  list.addEventListener('mousedown', (e) => {
    const item = e.target.closest('.search-select-item');
    if (!item) return;
    e.preventDefault();
    selecionado = item.dataset.value || '';
    input.value = rotulo(selecionado);
    list.style.display = 'none';
    onSelect(selecionado);
  });
  input.addEventListener('blur', () => {
    setTimeout(() => {
      list.style.display = 'none';
      input.value = rotulo(selecionado);
    }, 150);
  });

  return {
    getValue: () => selecionado,
    setValue: (valor) => {
      selecionado = (valor === null || valor === undefined) ? '' : String(valor);
      input.value = rotulo(selecionado);
      onSelect(selecionado);
    }
  };
}
window.wireSearchSelect = wireSearchSelect;

const NAV_ITEMS = [
  { href: 'index.html', label: 'Dashboard' },
  { href: 'vendas.html', label: 'Vendas' },
  { href: 'board.html', label: 'Board' },
  { href: 'produtos.html', label: 'Produtos' },
  { href: 'orcamento.html', label: 'Orçamentos' },
  { href: 'financeiro.html', label: 'Financeiro' },
  {
    label: 'Cadastros',
    children: [
      { href: 'impressoras.html', label: 'Impressoras' },
      { href: 'filamentos.html', label: 'Filamentos' },
      { href: 'catalogo-cores.html', label: 'Catálogo de Cores' },
      { href: 'clientes.html', label: 'Clientes' },
      { href: 'contas-financeiras.html', label: 'Contas Financeiras' },
      { href: 'socios.html', label: 'Sócios' },
      { href: 'usuarios.html', label: 'Usuários' }
    ]
  }
];

const FORMA_PAGAMENTO = ['Pix', 'Dinheiro', 'Cartão de Crédito', 'Cartão de Débito'];
const CATEGORIAS_SAIDA = ['Filamento', 'Material de embalagem', 'Despesas Gerais', 'Impressora 3D', 'Frete para cliente', 'Ferramentas de marketing', 'Anúncios pagos', 'Aluguel', 'Outro'];
const CATEGORIAS_ENTRADA = ['Aporte de sócio', 'Outro'];

function renderNavItem(it, active) {
  if (!it.children) {
    return `<a href="${it.href}" class="${it.href === active ? 'active' : ''}">${it.label}</a>`;
  }
  const isActive = it.children.some((c) => c.href === active);
  return `
    <div class="nav-dropdown">
      <a href="#" class="${isActive ? 'active' : ''}" onclick="event.preventDefault(); toggleNavDropdown(this)">${it.label} ▾</a>
      <div class="nav-dropdown-menu">
        ${it.children.map((c) => `<a href="${c.href}" class="${c.href === active ? 'active' : ''}">${c.label}</a>`).join('')}
      </div>
    </div>
  `;
}

function toggleNavDropdown(trigger) {
  const dropdown = trigger.closest('.nav-dropdown');
  const isOpen = dropdown.classList.contains('open');
  document.querySelectorAll('.nav-dropdown.open').forEach((d) => d.classList.remove('open'));
  if (!isOpen) dropdown.classList.add('open');
}
window.toggleNavDropdown = toggleNavDropdown;

document.addEventListener('click', (e) => {
  if (!e.target.closest('.nav-dropdown')) {
    document.querySelectorAll('.nav-dropdown.open').forEach((d) => d.classList.remove('open'));
  }
});

function closeModal() {
  const bg = document.getElementById('modal-bg');
  if (bg) bg.style.display = 'none';
}
window.closeModal = closeModal;

(function wireModalBackdrop() {
  const bg = document.getElementById('modal-bg');
  if (!bg) return;
  bg.addEventListener('click', (e) => {
    if (e.target === bg) closeModal();
  });
})();

async function renderNav(active) {
  const el = document.getElementById('nav');
  if (!el) return;
  el.innerHTML =
    '<span class="brand">🖨 Impressão 3D</span>' +
    NAV_ITEMS.map((it) => renderNavItem(it, active)).join('') +
    '<span class="nav-user" id="nav-user"></span>';
  try {
    const usuario = await apiGet('/api/auth/me');
    window.currentUser = usuario;
    document.getElementById('nav-user').innerHTML = `${escapeHtml(usuario.nome)} <a onclick="logout()">Sair</a>`;
  } catch (e) {
    // apiGet já redireciona para login.html em caso de 401
  }
}

async function logout() {
  await apiPost('/api/auth/logout', {});
  window.location.href = 'login.html';
}
window.logout = logout;
