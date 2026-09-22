// api/webhook.js
// -----------------------------------------------------------------------------
// Porta de entrada do WhatsApp.
//
// A Evolution (na VPS) recebe a mensagem e faz um POST aqui. Este arquivo só
// traduz: tira o telefone e o texto, entrega ao núcleo que já está pronto e
// testado (lib/atendimento.js) e devolve a resposta pelo WhatsApp.
//
// Nenhuma regra de atendimento mora aqui — é de propósito. É o que permite ter
// o mesmo cérebro no chat de teste, no WhatsApp e, depois, na ligação.
//
// Variáveis de ambiente:
//   EVOLUTION_URL / EVOLUTION_KEY / EVOLUTION_INSTANCE
//   WEBHOOK_SECRET   (opcional, mas recomendado — vira ?k=... na URL)
// -----------------------------------------------------------------------------

const { processarMensagem } = require("../lib/atendimento");
const { mensagemJaProcessada } = require("../lib/conversa");
const {
  enviarTexto,
  enviarImagemBase64,
  mostrarDigitando,
  baixarMidiaBase64,
  configurada
} = require("../lib/evolution");
const { transcrever } = require("../lib/audio");

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// -----------------------------------------------------------------------------
// Leitura do que a Evolution manda
// -----------------------------------------------------------------------------
function extrair(corpo) {
  const evento = String(corpo?.event || "").toLowerCase();
  const d = corpo?.data || {};
  const chave = d.key || {};
  const jid = String(chave.remoteJid || "");

  return {
    evento,
    instancia: corpo?.instance || "",
    idMensagem: chave.id || "",
    deMim: chave.fromMe === true,
    jid,
    // "5515999999999@s.whatsapp.net" -> "5515999999999"
    telefone: jid.split("@")[0].split(":")[0].replace(/\D/g, ""),
    ehGrupo: jid.endsWith("@g.us"),
    ehStatus: jid.startsWith("status@"),
    nomePerfil: d.pushName || "",
    mensagem: d.message || {},
    tipo: String(d.messageType || ""),
    base64: d.message?.base64 || d.base64 || null,
    bruto: d
  };
}

// O WhatsApp entrega o número com o código do país (5515996782039), mas o site
// grava o telefone do jeito que o cliente digita (15996782039). Guardamos sem o
// 55 para o mesmo cliente não virar dois cadastros no painel.
function semDDI(telefone) {
  const t = String(telefone || "");
  return t.startsWith("55") && t.length >= 12 ? t.slice(2) : t;
}

function textoDaMensagem(m) {
  return (
    m?.conversation ||
    m?.extendedTextMessage?.text ||
    m?.imageMessage?.caption ||
    m?.videoMessage?.caption ||
    m?.buttonsResponseMessage?.selectedDisplayText ||
    m?.listResponseMessage?.title ||
    m?.templateButtonReplyMessage?.selectedDisplayText ||
    ""
  );
}

function ehAudio(info) {
  return !!(info.mensagem?.audioMessage || /audio|ptt/i.test(info.tipo));
}

// -----------------------------------------------------------------------------
// Envio das respostas, com um respiro entre elas para não chegar tudo colado
// -----------------------------------------------------------------------------
async function responder(telefone, respostas, qrPix) {
  for (const texto of respostas || []) {
    if (!String(texto || "").trim()) continue;
    await mostrarDigitando(telefone, 1200).catch(() => {});
    await espera(700);
    await enviarTexto(telefone, texto);
    await espera(400);
  }
  if (qrPix) {
    await enviarImagemBase64(telefone, qrPix, "QR Code do Pix").catch((e) =>
      console.error("[webhook] falha ao enviar QR:", e.message)
    );
  }
}

// -----------------------------------------------------------------------------
module.exports = async (req, res) => {
  // A Evolution reenvia quando demoramos a responder, então respondemos rápido
  // e nunca devolvemos erro por conta de mensagem que não interessa.
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      webhook: "ativo",
      evolution_configurada: configurada()
    });
  }
  if (req.method !== "POST") {
    return res.status(200).json({ ok: true, ignorado: "método" });
  }

  // Trava simples: a Evolution não assina os webhooks, então usamos um segredo
  // na própria URL (?k=...). Sem isso, quem descobrir a URL fala com o bot.
  const segredo = process.env.WEBHOOK_SECRET;
  if (segredo && req.query?.k !== segredo) {
    return res.status(401).json({ ok: false, erro: "não autorizado" });
  }

  try {
    const corpo =
      typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};

    const info = extrair(corpo);

    // Só mensagem nova de conversa individual, que não seja nossa
    if (!info.evento.includes("messages.upsert")) {
      return res.status(200).json({ ok: true, ignorado: info.evento });
    }
    if (info.deMim || info.ehGrupo || info.ehStatus || !info.telefone) {
      return res.status(200).json({ ok: true, ignorado: "origem" });
    }

    // Webhook reenviado? Não processa duas vezes — senão vira pedido duplicado.
    if (await mensagemJaProcessada(info.idMensagem)) {
      return res.status(200).json({ ok: true, ignorado: "duplicada" });
    }

    // ---- texto ou áudio ----
    let texto = textoDaMensagem(info.mensagem).trim();

    if (!texto && ehAudio(info)) {
      let base64 = info.base64;
      if (!base64) {
        base64 = await baixarMidiaBase64({ key: info.bruto.key, message: info.mensagem });
      }

      const t = await transcrever(base64, info.mensagem?.audioMessage?.mimetype || "audio/ogg");

      if (t.ok) {
        texto = t.texto;
        console.log("[webhook] áudio transcrito:", texto.slice(0, 120));
      } else {
        const aviso = t.longo
          ? "Esse áudio ficou longo demais pra mim 😅 Manda um mais curtinho ou escreve o pedido?"
          : "Não consegui ouvir seu áudio direito. Pode mandar de novo ou escrever?";
        await enviarTexto(info.telefone, aviso);
        return res.status(200).json({ ok: true, audio: "falhou", erro: t.erro });
      }
    }

    if (!texto) {
      // Foto, figurinha, contato, localização: não dá pra virar pedido
      await enviarTexto(
        info.telefone,
        "Consigo atender por texto ou áudio 🙂 Me conta por aqui o que você vai querer."
      );
      return res.status(200).json({ ok: true, ignorado: "sem texto" });
    }

    // ---- o cérebro, o mesmo do chat de teste ----
    const r = await processarMensagem({
      canal: "whatsapp",
      identificador: semDDI(info.telefone),
      texto,
      nomePerfil: info.nomePerfil
    });

    // O QR só vai quando o cliente pede (a Ana marca isso e o núcleo devolve
    // em dados.qrPix). No Pix recém-criado mandamos só o copia-e-cola.
    await responder(info.telefone, r.respostas, r.dados?.qrPix);

    return res.status(200).json({
      ok: true,
      acao: r.acao,
      orderId: r.dados?.orderId || null
    });
  } catch (err) {
    console.error("[webhook] erro:", err);
    // 200 de propósito: erro nosso não deve fazer a Evolution ficar reenviando
    return res.status(200).json({ ok: false, erro: err.message || String(err) });
  }
};
