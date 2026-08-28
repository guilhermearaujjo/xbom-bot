// lib/cardapio.js
// -----------------------------------------------------------------------------
// Fonte única do cardápio.
//
// Em vez de copiar a lista de itens para dentro deste projeto (o que criaria
// duas tabelas de preço que iriam divergir na primeira alteração), este módulo
// LÊ o mesmo menu-data.js que o site usa e aplica por cima os item_overrides
// gravados pelo painel — exatamente como o scripts.js faz no navegador.
//
// Resultado: você continua editando o cardápio num lugar só.
// -----------------------------------------------------------------------------

const { db } = require("./firebase");
const {
  MENU_DATA_URL,
  PRECO_ADICIONAL,
  ADICIONAIS,
  CATEGORIAS_COM_ADICIONAL
} = require("./config");

// Cache em memória. Some quando a função serverless recicla, o que é bom:
// garante que o cardápio nunca fica velho por muito tempo.
let cache = null;
let cacheEm = 0;
const CACHE_MS = Number(process.env.CACHE_CARDAPIO_MIN || 1) * 60 * 1000;

// -----------------------------------------------------------------------------
// Carregamento do menu-data.js
// -----------------------------------------------------------------------------
// O arquivo é um script de navegador (declara const CATEGORIAS / const ITENS e
// joga em window). Aqui ele é avaliado num escopo isolado com um "window" falso,
// e devolvemos os dois arrays.
//
// Só apontar MENU_DATA_URL para um domínio seu. Não use URL de terceiro aqui.
async function carregarMenuData() {
  const resp = await fetch(MENU_DATA_URL, { cache: "no-store" });
  if (!resp.ok) {
    throw new Error(
      `Falha ao baixar o cardápio (${resp.status}) de ${MENU_DATA_URL}`
    );
  }
  const codigo = await resp.text();

  const janelaFalsa = {};
  const fn = new Function(
    "window",
    `${codigo}\n;return { CATEGORIAS: window.CATEGORIAS, ITENS: window.ITENS };`
  );
  const saida = fn(janelaFalsa);

  if (!saida || !Array.isArray(saida.ITENS) || !saida.ITENS.length) {
    throw new Error("menu-data.js carregou, mas não expôs window.ITENS.");
  }
  return saida;
}

// -----------------------------------------------------------------------------
// Overrides do painel (coleção item_overrides: { preco, pausado })
// -----------------------------------------------------------------------------
async function carregarOverrides() {
  if (!db) return {};
  try {
    const snap = await db.collection("item_overrides").get();
    const mapa = {};
    snap.forEach((doc) => {
      mapa[doc.id] = doc.data() || {};
    });
    return mapa;
  } catch (err) {
    // Se os overrides falharem, é melhor servir o cardápio base do que
    // derrubar o atendimento inteiro. Mas registra o erro.
    console.error("[cardapio] erro ao ler item_overrides:", err.message);
    return {};
  }
}

// -----------------------------------------------------------------------------
// Monta o cardápio efetivo
// -----------------------------------------------------------------------------
function ehCapa(item) {
  return item.tipo === "capa" || item.class === "capa";
}

// Mesma regra do getEffectiveItem() do scripts.js
function aplicarOverride(item, ov) {
  if (!ov) return { ...item };
  if (ov.preco !== undefined && ov.preco !== null && ov.preco !== "") {
    return { ...item, preco: Number(ov.preco) };
  }
  return { ...item };
}

// Mesma regra do isItemPausedNow() do scripts.js
function estaPausado(item, ov) {
  if (item && item.paused === true) return true; // pausa fixa no código
  return !!(ov && ov.pausado === true);
}

async function getCardapio({ forcar = false } = {}) {
  const agora = Date.now();
  if (!forcar && cache && agora - cacheEm < CACHE_MS) {
    return cache;
  }

  const [menu, overrides] = await Promise.all([
    carregarMenuData(),
    carregarOverrides()
  ]);

  const itens = menu.ITENS.filter((it) => !ehCapa(it)) // capas são imagem, não produto
    .map((it) => {
      const ov = overrides[it.id];
      const efetivo = aplicarOverride(it, ov);
      return {
        id: efetivo.id,
        cat: efetivo.cat,
        nome: (efetivo.nome || "").trim(),
        desc: (efetivo.desc || "").trim(),
        preco: Number(efetivo.preco),
        pausado: estaPausado(it, ov),
        aceitaAdicional: CATEGORIAS_COM_ADICIONAL.includes(efetivo.cat)
      };
    })
    // itens sem preço numérico não são vendáveis
    .filter((it) => it.nome && Number.isFinite(it.preco));

  cache = {
    categorias: (menu.CATEGORIAS || []).filter((c) => c && c.id),
    itens,
    porId: Object.fromEntries(itens.map((i) => [i.id, i])),
    adicionais: ADICIONAIS,
    precoAdicional: PRECO_ADICIONAL,
    carregadoEm: new Date().toISOString()
  };
  cacheEm = agora;
  return cache;
}

// -----------------------------------------------------------------------------
// Preço de uma linha do pedido — espelha lineUnitPrice() do scripts.js:
//   preço do item + (quantidade de adicionais * PRECO_ADICIONAL)
// -----------------------------------------------------------------------------
function precoUnitario(item, adicionais = []) {
  const qtdAdicionais = Array.isArray(adicionais) ? adicionais.length : 0;
  return Number(item.preco) + qtdAdicionais * PRECO_ADICIONAL;
}

module.exports = {
  getCardapio,
  precoUnitario,
  estaPausado,
  aplicarOverride
};
