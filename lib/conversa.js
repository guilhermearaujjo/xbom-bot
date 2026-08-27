// lib/conversa.js
// -----------------------------------------------------------------------------
// Estado da conversa, guardado no Firestore (coleção bot_conversas).
//
// Por que no banco e não em memória: na Vercel cada mensagem pode cair numa
// instância diferente da função, e a memória não é compartilhada. Além disso,
// estado no banco sobrevive a deploy — o cliente não perde o carrinho porque
// você publicou uma correção no meio do atendimento.
//
// Um documento por telefone. O id é o telefone só com dígitos.
// -----------------------------------------------------------------------------

const { db, admin } = require("./firebase");

const COLECAO = "bot_conversas";

// Depois desse tempo sem mensagem, a conversa é considerada nova
// (carrinho zerado, histórico limpo).
const INATIVIDADE_MS = Number(process.env.INATIVIDADE_MIN || 30) * 60 * 1000;

// Quantas mensagens do histórico mandamos ao modelo. Mais que isso encarece
// sem melhorar: o que importa de verdade já está no carrinho estruturado.
const MAX_HISTORICO = Number(process.env.MAX_HISTORICO || 16);

function idDoTelefone(telefone) {
  return String(telefone || "").replace(/\D/g, "");
}

function conversaVazia(telefone) {
  return {
    telefone: idDoTelefone(telefone),
    historico: [], // [{ papel: 'cliente'|'bot', texto, em }]
    carrinho: [], // [{ id, qtd, adicionais[], obs, soda }]
    cliente: { nome: "", cep: "", endereco: "", formaEntrega: "" },
    pagamento: { tipo: "", trocoPara: "" },
    aguardandoConfirmacao: false,
    pedidoCriado: null, // orderId, quando já fechou
    atendimentoHumano: false, // true = bot calado neste chat
    atendimentoHumanoAte: null,
    atualizadoEm: null
  };
}

// -----------------------------------------------------------------------------
// Leitura
// -----------------------------------------------------------------------------
async function carregarConversa(telefone) {
  const id = idDoTelefone(telefone);
  if (!db || !id) return conversaVazia(telefone);

  const snap = await db.collection(COLECAO).doc(id).get();
  if (!snap.exists) return conversaVazia(telefone);

  const dados = snap.data() || {};

  // Expirou por inatividade? Começa do zero, mas preserva os dados do cliente
  // (nome e endereço) — quem já pediu antes não precisa repetir tudo.
  const ultima = dados.atualizadoEm?.toMillis
    ? dados.atualizadoEm.toMillis()
    : 0;

  if (ultima && Date.now() - ultima > INATIVIDADE_MS) {
    const nova = conversaVazia(telefone);
    nova.cliente = dados.cliente || nova.cliente;
    return nova;
  }

  return { ...conversaVazia(telefone), ...dados };
}

// -----------------------------------------------------------------------------
// Gravação
// -----------------------------------------------------------------------------
async function salvarConversa(telefone, conversa) {
  const id = idDoTelefone(telefone);
  if (!db || !id) return;

  const payload = {
    ...conversa,
    telefone: id,
    historico: (conversa.historico || []).slice(-MAX_HISTORICO),
    atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
  };

  await db.collection(COLECAO).doc(id).set(payload, { merge: false });
}

function adicionarAoHistorico(conversa, papel, texto) {
  conversa.historico = conversa.historico || [];
  conversa.historico.push({
    papel,
    texto: String(texto || ""),
    em: new Date().toISOString()
  });
  if (conversa.historico.length > MAX_HISTORICO) {
    conversa.historico = conversa.historico.slice(-MAX_HISTORICO);
  }
  return conversa;
}

// -----------------------------------------------------------------------------
// Trava contra mensagens em rajada.
//
// O cliente manda "oi" / "quero um x-tudo" / "pra entrega" em três balões, e a
// Evolution dispara três webhooks quase simultâneos. Sem trava, três instâncias
// da função leem o mesmo carrinho, cada uma acrescenta o seu item e a última a
// gravar apaga o trabalho das outras.
//
// A trava é um documento com transação: só uma instância consegue pegar.
// As outras devolvem false e desistem — a mensagem delas fica no histórico e
// será considerada na próxima volta.
// -----------------------------------------------------------------------------
const TRAVA_MS = 25 * 1000;

async function tentarTravar(telefone) {
  const id = idDoTelefone(telefone);
  if (!db || !id) return true; // sem banco, não trava nada

  const ref = db.collection("bot_travas").doc(id);

  try {
    return await db.runTransaction(async (t) => {
      const snap = await t.get(ref);
      const agora = Date.now();

      if (snap.exists) {
        const ate = Number(snap.data()?.ate || 0);
        if (ate > agora) return false; // alguém está processando
      }

      t.set(ref, { ate: agora + TRAVA_MS });
      return true;
    });
  } catch (err) {
    console.error("[trava] erro:", err.message);
    return true; // erro na trava não pode impedir o atendimento
  }
}

async function destravar(telefone) {
  const id = idDoTelefone(telefone);
  if (!db || !id) return;
  try {
    await db.collection("bot_travas").doc(id).set({ ate: 0 });
  } catch (err) {
    console.error("[trava] erro ao liberar:", err.message);
  }
}

// -----------------------------------------------------------------------------
// Idempotência: a Evolution reenvia o webhook se você demorar a responder.
// Registramos cada id de mensagem já processado.
// -----------------------------------------------------------------------------
async function mensagemJaProcessada(idMensagem) {
  if (!db || !idMensagem) return false;
  const ref = db.collection("bot_mensagens").doc(String(idMensagem));

  try {
    return await db.runTransaction(async (t) => {
      const snap = await t.get(ref);
      if (snap.exists) return true;
      t.set(ref, { em: admin.firestore.FieldValue.serverTimestamp() });
      return false;
    });
  } catch (err) {
    console.error("[idempotencia] erro:", err.message);
    return false;
  }
}

module.exports = {
  carregarConversa,
  salvarConversa,
  adicionarAoHistorico,
  conversaVazia,
  tentarTravar,
  destravar,
  mensagemJaProcessada,
  idDoTelefone
};
