// lib/evolution.js
// -----------------------------------------------------------------------------
// Conversa com a Evolution API (a peça que mantém a sessão do WhatsApp viva na
// VPS). Aqui só tem envio e download — nenhuma regra de atendimento.
//
// Variáveis de ambiente:
//   EVOLUTION_URL       https://evolution-api-xxxx.srvXXXX.hstgr.cloud
//   EVOLUTION_KEY       a chave (global ou a da instância)
//   EVOLUTION_INSTANCE  xbom
// -----------------------------------------------------------------------------

const URL_BASE = (process.env.EVOLUTION_URL || "").replace(/\/$/, "");
const CHAVE = process.env.EVOLUTION_KEY || "";
const INSTANCIA = process.env.EVOLUTION_INSTANCE || "xbom";

function configurada() {
  return !!(URL_BASE && CHAVE && INSTANCIA);
}

async function chamar(caminho, corpo, { timeoutMs = 20000 } = {}) {
  if (!configurada()) {
    throw new Error(
      "Evolution não configurada (EVOLUTION_URL / EVOLUTION_KEY / EVOLUTION_INSTANCE)."
    );
  }

  const controle = new AbortController();
  const alarme = setTimeout(() => controle.abort(), timeoutMs);

  try {
    const resp = await fetch(`${URL_BASE}${caminho}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: CHAVE
      },
      body: JSON.stringify(corpo),
      signal: controle.signal
    });
    clearTimeout(alarme);

    const texto = await resp.text();
    let dados = null;
    try {
      dados = JSON.parse(texto);
    } catch (_) {}

    if (!resp.ok) {
      console.error("[evolution]", caminho, resp.status, texto.slice(0, 300));
      return { ok: false, status: resp.status, erro: dados?.message || texto.slice(0, 200) };
    }
    return { ok: true, dados };
  } catch (err) {
    clearTimeout(alarme);
    const motivo = err.name === "AbortError" ? "timeout" : err.message;
    console.error("[evolution] falha em", caminho, motivo);
    return { ok: false, erro: motivo };
  }
}

// -----------------------------------------------------------------------------
// Envio
// -----------------------------------------------------------------------------

// O WhatsApp identifica o contato pelo número com código do país (55...).
// O webhook já entrega assim; esta função só limpa o que vier torto.
function numeroLimpo(numero) {
  return String(numero || "").replace(/\D/g, "");
}

async function enviarTexto(numero, texto) {
  if (!String(texto || "").trim()) return { ok: true, vazio: true };
  return chamar(`/message/sendText/${INSTANCIA}`, {
    number: numeroLimpo(numero),
    text: String(texto)
  });
}

// Imagem em base64 (usado para o QR Code do Pix)
async function enviarImagemBase64(numero, base64, legenda = "") {
  return chamar(`/message/sendMedia/${INSTANCIA}`, {
    number: numeroLimpo(numero),
    mediatype: "image",
    mimetype: "image/png",
    media: String(base64 || "").replace(/^data:image\/\w+;base64,/, ""),
    fileName: "pix.png",
    caption: legenda
  });
}

// "digitando..." — deixa a conversa mais natural e some sozinho
async function mostrarDigitando(numero, ms = 1500) {
  return chamar(`/chat/sendPresence/${INSTANCIA}`, {
    number: numeroLimpo(numero),
    presence: "composing",
    delay: ms
  });
}

// -----------------------------------------------------------------------------
// Download de mídia (áudio do cliente)
//
// O webhook pode já trazer o base64 quando a instância está configurada com
// "base64: true". Quando não traz, buscamos aqui pela chave da mensagem.
// -----------------------------------------------------------------------------
async function baixarMidiaBase64(mensagemBruta) {
  const r = await chamar(
    `/chat/getBase64FromMediaMessage/${INSTANCIA}`,
    { message: mensagemBruta, convertToMp4: false },
    { timeoutMs: 30000 }
  );
  if (!r.ok) return null;
  return r.dados?.base64 || r.dados?.media || null;
}

module.exports = {
  configurada,
  enviarTexto,
  enviarImagemBase64,
  mostrarDigitando,
  baixarMidiaBase64,
  INSTANCIA
};
