// lib/pedido.js
// -----------------------------------------------------------------------------
// Cria o pedido chamando o MESMO endpoint que o site usa: POST /api/orders do
// xbom-backend.
//
// Por que não gravar direto no Firestore: aquele endpoint já grava o pedido,
// já atualiza o diretório de clientes e já manda para a fila da impressora,
// com a regra de não imprimir pedido online antes do webhook confirmar.
// Replicar isso aqui seria duplicar lógica que já funciona — e divergir dela
// na primeira alteração.
// -----------------------------------------------------------------------------

const { BACKEND_URL, ORIGEM } = require("./config");

// MODO_TESTE=true põe "TESTE —" no nome do cliente, para ficar evidente no
// cupom e na esteira que ninguém precisa montar aquele pedido.
const MODO_TESTE = process.env.MODO_TESTE === "true";

// -----------------------------------------------------------------------------
// Converte o pedido validado para o formato exato que o backend espera.
//
// Repare nos nomes: o backend usa quantity/unit_price/name (inglês), enquanto
// o validador trabalha com qtd/preco_unit/nome. A tradução acontece aqui, num
// lugar só.
// -----------------------------------------------------------------------------
function montarCorpo({ pedido, pagamento }) {
  const items = pedido.itens.map((i) => ({
    id: i.id,
    name: i.nome,
    quantity: i.qtd,
    unit_price: i.preco_unit,
    addons: i.adicionais || [],
    soda: i.soda || "",
    obs: i.obs || ""
  }));

  const tipo = String(pagamento?.tipo || "").toLowerCase();

  // Pix passa pelo Mercado Pago: marcamos como online para o backend NÃO
  // imprimir agora — quem manda imprimir é o webhook, depois de aprovado.
  const ehPix = tipo === "pix";
  const paymentType = ehPix ? "PIX_MP" : "PAGAR_DEPOIS";
  const metodoNaEntrega = tipo === "cartao" ? "cartao" : "dinheiro";

  const nome = MODO_TESTE ? `TESTE — ${pedido.nome}` : pedido.nome;

  return {
    customer: {
      name: nome,
      phone: pedido.telefone,
      address: pedido.endereco || "",
      cep: pedido.cep || "",
      troco_para: pagamento?.trocoPara || ""
    },
    items,
    subtotal: pedido.subtotal,
    taxa: pedido.taxa,
    total: pedido.total,
    deliveryType: pedido.formaEntrega === "entrega" ? "ENTREGA" : "RETIRADA",
    paymentType,
    paymentOnDeliveryMethod: metodoNaEntrega,
    obs: pedido.observacoes || "",
    origem: ORIGEM
  };
}

// -----------------------------------------------------------------------------
// Envia. Devolve { ok, orderId, erro }.
// -----------------------------------------------------------------------------
async function criarPedido({ pedido, pagamento }) {
  const corpo = montarCorpo({ pedido, pagamento });
  const url = `${BACKEND_URL.replace(/\/$/, "")}/api/orders`;

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

    if (!resp.ok) {
      console.error("[pedido] backend recusou", resp.status, texto.slice(0, 400));
      return {
        ok: false,
        erro: dados?.error || `Backend respondeu ${resp.status}`,
        status: resp.status
      };
    }

    const salvo = dados?.order || {};
    const orderId = salvo.orderId || salvo.id || null;

    if (!orderId) {
      console.error("[pedido] resposta sem orderId:", texto.slice(0, 400));
      return { ok: false, erro: "Backend não devolveu o número do pedido." };
    }

    return { ok: true, orderId, pedidoSalvo: salvo, corpoEnviado: corpo };
  } catch (err) {
    console.error("[pedido] falha de rede:", err.message);
    return { ok: false, erro: err.message };
  }
}

module.exports = { criarPedido, montarCorpo, MODO_TESTE };
