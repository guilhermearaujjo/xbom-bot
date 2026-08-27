// lib/ia.js
// -----------------------------------------------------------------------------
// Chamada ao modelo. Sem SDK — só fetch, para não carregar dependência à toa.
//
// Duas proteções importantes aqui:
//   1. response_format json_object: o modelo é obrigado a devolver JSON válido.
//   2. Se mesmo assim vier lixo, devolvemos uma resposta segura em vez de
//      quebrar o atendimento.
// -----------------------------------------------------------------------------

const MODELO = process.env.OPENAI_MODEL || "gpt-4o-mini";
const TEMPERATURA = Number(process.env.OPENAI_TEMPERATURA || 0.4);
const TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 20000);

const RESPOSTA_SEGURA = {
  mensagem:
    "Opa, tive um probleminha aqui pra entender. Pode repetir, por favor?",
  carrinho: null, // null = não mexer no carrinho atual
  cliente: null,
  pagamento: null,
  pedirConfirmacao: false,
  chamarHumano: false
};

function historicoParaMensagens(historico = []) {
  return historico.map((h) => ({
    role: h.papel === "bot" ? "assistant" : "user",
    content: h.texto
  }));
}

// Remove crases e texto em volta, caso o modelo escorregue mesmo com json_object
function extrairJson(texto) {
  if (!texto) return null;
  let limpo = String(texto).trim();
  limpo = limpo.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();

  try {
    return JSON.parse(limpo);
  } catch (_) {}

  const inicio = limpo.indexOf("{");
  const fim = limpo.lastIndexOf("}");
  if (inicio >= 0 && fim > inicio) {
    try {
      return JSON.parse(limpo.slice(inicio, fim + 1));
    } catch (_) {}
  }
  return null;
}

async function conversar({ prompt, historico, mensagemAtual }) {
  const chave = process.env.OPENAI_API_KEY;
  if (!chave) {
    console.error("[ia] OPENAI_API_KEY ausente");
    return { ...RESPOSTA_SEGURA, chamarHumano: true };
  }

  const mensagens = [
    { role: "system", content: prompt },
    ...historicoParaMensagens(historico),
    { role: "user", content: mensagemAtual }
  ];

  const controle = new AbortController();
  const alarme = setTimeout(() => controle.abort(), TIMEOUT_MS);

  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${chave}`
      },
      body: JSON.stringify({
        model: MODELO,
        temperature: TEMPERATURA,
        max_tokens: 800,
        response_format: { type: "json_object" },
        messages: mensagens
      }),
      signal: controle.signal
    });

    clearTimeout(alarme);

    if (!resp.ok) {
      const txt = await resp.text();
      console.error("[ia] erro da API", resp.status, txt.slice(0, 400));
      return { ...RESPOSTA_SEGURA, chamarHumano: resp.status !== 429 };
    }

    const dados = await resp.json();
    const bruto = dados?.choices?.[0]?.message?.content;
    const json = extrairJson(bruto);

    if (!json || typeof json.mensagem !== "string") {
      console.error("[ia] resposta sem formato esperado:", String(bruto).slice(0, 300));
      return RESPOSTA_SEGURA;
    }

    return {
      mensagem: json.mensagem,
      carrinho: Array.isArray(json.carrinho) ? json.carrinho : null,
      cliente: json.cliente && typeof json.cliente === "object" ? json.cliente : null,
      pagamento:
        json.pagamento && typeof json.pagamento === "object" ? json.pagamento : null,
      pedirConfirmacao: json.pedirConfirmacao === true,
      chamarHumano: json.chamarHumano === true,
      uso: dados.usage || null
    };
  } catch (err) {
    clearTimeout(alarme);
    const foiTimeout = err.name === "AbortError";
    console.error("[ia] falha:", foiTimeout ? "timeout" : err.message);
    return {
      ...RESPOSTA_SEGURA,
      mensagem: foiTimeout
        ? "Desculpa, demorei demais aqui. Pode mandar de novo?"
        : RESPOSTA_SEGURA.mensagem
    };
  }
}

module.exports = { conversar, MODELO };
