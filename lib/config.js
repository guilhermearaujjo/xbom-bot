// lib/config.js
// -----------------------------------------------------------------------------
// Toda configuração que muda entre AMBIENTE DE TESTE e PRODUÇÃO DO CLIENTE fica
// aqui, lendo de variáveis de ambiente. Nada de valor fixo espalhado no código.
//
// Quando chegar a hora de migrar para as credenciais reais do X-Bom, a mudança
// é trocar as variáveis no painel da Vercel — não mexer em arquivo nenhum.
// -----------------------------------------------------------------------------

// URL do backend que JÁ EXISTE e já funciona (grava o pedido, atualiza o
// diretório de clientes e manda para a fila da impressora).
// O bot não fala com o Firestore para criar pedido — ele usa este endpoint,
// exatamente como o site faz.
const BACKEND_URL = process.env.BACKEND_URL || "https://xbom-backend.vercel.app";

// De onde ler o cardápio. Aponta para o MESMO menu-data.js que o site usa,
// para não existir duas listas de preço em lugares diferentes.
const MENU_DATA_URL =
  process.env.MENU_DATA_URL || "https://xbom.com.br/menu-data.js";

// Identifica a origem do pedido no painel/cupom. O site manda "site".
const ORIGEM = process.env.ORIGEM_PEDIDO || "whatsapp";

// -----------------------------------------------------------------------------
// ENTREGA — espelha exatamente o que está no scripts.js do site.
// -----------------------------------------------------------------------------
const ENTREGA = {
  // Taxa fixa de entrega (o site usa 9 fixo; retirada é 0)
  taxa: Number(process.env.TAXA_ENTREGA || 9),

  // Faixa de CEP atendida (Votorantim: 18110-xxx até 18119-xxx)
  prefixosPermitidos: (
    process.env.CEP_PREFIXOS ||
    "18110,18111,18112,18113,18114,18115,18116,18117,18118,18119"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  // CEPs liberados individualmente, fora da faixa acima
  cepsPermitidos: (process.env.CEPS_EXTRAS || "")
    .split(",")
    .map((s) => s.replace(/\D/g, ""))
    .filter(Boolean),

  // Coordenadas da loja e raio máximo, para a checagem de distância
  loja: {
    lat: Number(process.env.LOJA_LAT || -23.5436),
    lon: Number(process.env.LOJA_LON || -47.4475)
  },
  raioKm: Number(process.env.RAIO_KM || 5),

  // Se o geocoding falhar ou não achar o CEP, aceitamos assim mesmo?
  // O site hoje aceita (o erro cai num catch e o pedido segue), então o
  // padrão aqui é true para o bot não ficar mais rígido que o site.
  aceitarSeGeocodeFalhar: process.env.GEOCODE_TOLERANTE !== "false"
};

// -----------------------------------------------------------------------------
// ADICIONAIS — espelha ADDONS e ADDON_PRICE do scripts.js
// -----------------------------------------------------------------------------
const ADICIONAIS = [
  { id: "catupiry", nome: "Catupiry" },
  { id: "bacon", nome: "Bacon" },
  { id: "cheddar", nome: "Cheddar" },
  { id: "provolone", nome: "Provolone" },
  { id: "ovo", nome: "Ovo frito" },
  { id: "calabresa", nome: "Calabresa" },
  { id: "alface", nome: "Alface" }
];

const PRECO_ADICIONAL = Number(process.env.PRECO_ADICIONAL || 3);

// Categorias que aceitam adicional (mesma regra do isLanche/isCombo do site).
// PENDENTE DE CONFIRMAÇÃO: conferir se porções e bebidas realmente não aceitam.
const CATEGORIAS_COM_ADICIONAL = [
  "combos",
  "artesanais",
  "xb_classicos",
  "presunto",
  "semcarne",
  "bovino",
  "calabresa",
  "frango",
  "suina",
  "salsicha",
  "hamburguer",
  "junior"
];

// -----------------------------------------------------------------------------
// HORÁRIO — no scripts.js está {abre:'17:00', fecha:'23:30'} com um comentário
// dizendo "24h aberto". Deixei configurável até você confirmar qual vale.
// BLOQUEAR_FORA_HORARIO=false faz o bot só avisar, sem recusar o pedido.
// -----------------------------------------------------------------------------
const HORARIO = {
  abre: process.env.HORA_ABRE || "17:00",
  fecha: process.env.HORA_FECHA || "23:30",
  bloquear: process.env.BLOQUEAR_FORA_HORARIO !== "false",
  fusoOffsetHoras: Number(process.env.FUSO_OFFSET || -3) // Brasil (UTC-3)
};

// -----------------------------------------------------------------------------
// SABOR DE BEBIDA — itens que exigem o sabor preenchido no campo "soda".
// Combos já vêm com refrigerante, então também entram.
// EXIGIR_SABOR=false desliga a obrigatoriedade (volta a ser só um aviso).
// -----------------------------------------------------------------------------
const SABOR = {
  exigir: process.env.EXIGIR_SABOR !== "false",
  categorias: (process.env.SABOR_CATEGORIAS || "combos,sucos")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  prefixosId: (process.env.SABOR_PREFIXOS || "refri-")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
};

module.exports = {
  SABOR,
  BACKEND_URL,
  MENU_DATA_URL,
  ORIGEM,
  ENTREGA,
  ADICIONAIS,
  PRECO_ADICIONAL,
  CATEGORIAS_COM_ADICIONAL,
  HORARIO
};
