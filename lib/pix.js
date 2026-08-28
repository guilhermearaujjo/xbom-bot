// lib/pix.js
// -----------------------------------------------------------------------------
// Pix, reaproveitando o /api/mp/create-pix que já existe no backend.
//
// ATENÇÃO a uma diferença importante em relação ao pagamento na entrega:
// o create-pix JÁ CRIA O PEDIDO por dentro (ele chama createOrder antes de
// gerar o pagamento). Então para Pix NÃO se chama /api/orders — seria pedido
// duplicado. Uma chamada só faz as duas coisas.
//
// O pedido nasce com status PENDENTE_PAGAMENTO e não imprime. Quem manda
// imprimir é o webhook do Mercado Pago, quando o pagamento é aprovado — a
// mesma regra que o site já usa.
// -----------------------------------------------------------------------------

const { BACKEND_URL, ORIGEM } = require("./config");
const { db } = require("./firebase");

const MODO_TESTE = process.env.MODO_TESTE === "true";

// Mesmo padrão que o site usa (scripts.js): 'XB' + timestamp.
function gerarOrderId() {
  return "XB" + Date.now();
}

// -----------------------------------------------------------------------------
// Cria o pedido e gera o Pix numa tacada.
// Devolve { ok, orderId, copiaECola, qrBase64, expiraEm, erro }.
// -----------------------------------------------------------------------------
async function criarPedidoComPix({ pedido }) {
  const orderId = gerarOrderId();

  const items = pedido.itens.map((i) => ({
    id: i.id,
    name: i.nome,
    quantity: i.qtd,
    unit_price: i.preco_unit,
    addons: i.adicionais || [],
    soda: i.soda || "",
    obs: i.obs || ""
  }));

  const nome = MODO_TESTE ? `TESTE — ${pedido.nome}` : pedido.nome;

  // O create-pix grava origem: "site" fixo, então não dá para marcar
  // origem: "whatsapp" por ali. Deixamos a marca na observação, que aparece
  // no cupom e no painel.
  const marcaCanal = ORIGEM === "site" ? "" : `[${ORIGEM.toUpperCase()}] `;
  const obs = `${marcaCanal}${pedido.observacoes || ""}`.trim();

  const corpo = {
    orderId,
    customer: {
      name: nome,
      phone: pedido.telefone,
      address: pedido.endereco || "",
      cep: pedido.cep || ""
    },
    items,
    subtotal: pedido.subtotal,
    taxa: pedido.taxa,
    total: pedido.total,
    deliveryType: pedido.formaEntrega === "entrega" ? "ENTREGA" : "RETIRADA",
    obs
  };

  const url = `${BACKEND_URL.replace(/\/$/, "")}/api/mp/create-pix`;

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(corpo)
    });

    const texto = await resp.text();
    let dados = null;
    try {
      dados = JSON.parse(texto);
    } catch (_) {}

    if (!resp.ok || !dados?.qr_code) {
      console.error("[pix] falhou", resp.status, texto.slice(0, 400));
      return {
        ok: false,
        erro: dados?.error || `Backend respondeu ${resp.status}`
      };
    }

    return {
      ok: true,
      orderId,
      paymentId: dados.paymentId,
      copiaECola: dados.qr_code,
      qrBase64: dados.qr_code_base64 || null,
      expiraEm: dados.expira_em || null
    };
  } catch (err) {
    console.error("[pix] falha de rede:", err.message);
    return { ok: false, erro: err.message };
  }
}

// -----------------------------------------------------------------------------
// Consulta se o Pix já foi pago, lendo o documento do pedido no Firestore.
//
// Quem muda esse status é o webhook do Mercado Pago — não precisamos tocar
// nele. Aqui só olhamos o resultado.
// -----------------------------------------------------------------------------
const STATUS_PAGO = ["PAGO", "APROVADO", "AGUARDANDO_PREPARO", "APPROVED"];

async function consultarPagamento(orderId) {
  if (!db || !orderId) return { ok: false, erro: "sem banco ou orderId" };

  try {
    // O documento pode estar sob o próprio orderId ou ter o campo orderId.
    let snap = await db.collection("orders").doc(String(orderId)).get();

    if (!snap.exists) {
      const busca = await db
        .collection("orders")
        .where("orderId", "==", String(orderId))
        .limit(1)
        .get();
      if (busca.empty) return { ok: false, erro: "pedido não encontrado" };
      snap = busca.docs[0];
    }

    const dados = snap.data() || {};
    const status = String(dados.status || "").toUpperCase();

    return {
      ok: true,
      status,
      pago: STATUS_PAGO.includes(status),
      total: dados.total,
      pedido: dados
    };
  } catch (err) {
    console.error("[pix] erro ao consultar:", err.message);
    return { ok: false, erro: err.message };
  }
}

module.exports = { criarPedidoComPix, consultarPagamento, gerarOrderId };
