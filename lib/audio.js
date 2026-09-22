// lib/audio.js
// -----------------------------------------------------------------------------
// Transcrição do áudio que o cliente manda no WhatsApp.
//
// Muita gente da lanchonete prefere falar a digitar — sem isso, essas pessoas
// simplesmente não conseguem pedir pela Ana.
//
// A transcrição vira texto e segue exatamente pelo mesmo caminho de uma
// mensagem escrita. A Ana responde por texto, como combinado.
// -----------------------------------------------------------------------------

const MODELO = process.env.OPENAI_TRANSCRIBE_MODEL || "whisper-1";
const TIMEOUT_MS = Number(process.env.TRANSCRICAO_TIMEOUT_MS || 30000);

// Limite de segurança: áudio muito longo custa caro e quase sempre é engano
// (a pessoa mandou um áudio de 5 minutos sem querer).
const MAX_BYTES = Number(process.env.AUDIO_MAX_BYTES || 6 * 1024 * 1024);

async function transcrever(base64, mimetype = "audio/ogg") {
  const chave = process.env.OPENAI_API_KEY;
  if (!chave) {
    console.error("[audio] OPENAI_API_KEY ausente");
    return { ok: false, erro: "sem chave" };
  }
  if (!base64) return { ok: false, erro: "sem áudio" };

  let bytes;
  try {
    bytes = Buffer.from(String(base64).replace(/^data:[^;]+;base64,/, ""), "base64");
  } catch (_) {
    return { ok: false, erro: "base64 inválido" };
  }

  if (!bytes.length) return { ok: false, erro: "áudio vazio" };
  if (bytes.length > MAX_BYTES) {
    return { ok: false, erro: "muito longo", longo: true };
  }

  // O WhatsApp manda áudio em OGG/Opus, que o modelo aceita.
  const extensao = mimetype.includes("mp4") || mimetype.includes("m4a") ? "m4a"
    : mimetype.includes("mpeg") || mimetype.includes("mp3") ? "mp3"
    : "ogg";

  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mimetype }), `audio.${extensao}`);
  form.append("model", MODELO);
  form.append("language", "pt");

  const controle = new AbortController();
  const alarme = setTimeout(() => controle.abort(), TIMEOUT_MS);

  try {
    const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${chave}` },
      body: form,
      signal: controle.signal
    });
    clearTimeout(alarme);

    if (!resp.ok) {
      const txt = await resp.text();
      console.error("[audio] erro da API", resp.status, txt.slice(0, 300));
      return { ok: false, erro: `API ${resp.status}` };
    }

    const dados = await resp.json();
    const texto = String(dados?.text || "").trim();
    if (!texto) return { ok: false, erro: "transcrição vazia" };

    return { ok: true, texto };
  } catch (err) {
    clearTimeout(alarme);
    const motivo = err.name === "AbortError" ? "timeout" : err.message;
    console.error("[audio] falha:", motivo);
    return { ok: false, erro: motivo };
  }
}

module.exports = { transcrever };
