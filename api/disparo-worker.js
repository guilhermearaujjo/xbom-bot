// api/disparo-worker.js
// -----------------------------------------------------------------------------
// Envia os disparos, devagar. Um cron na VPS chama esta rota a cada minuto; a
// cada chamada sai NO MÁXIMO uma mensagem, e só depois de um intervalo
// aleatório (45 a 120 s por padrão) desde a anterior.
//
// Só envia dentro da janela de horário e até o limite do dia. Fora disso,
// responde "idle" e não faz nada.
//
//   GET /api/disparo-worker?k=<CRON_SECRET>
//
// Variáveis (todas opcionais, menos CRON_SECRET):
//   CRON_SECRET     segredo da rota
//   ENVIO_INICIO    "16:00"   ENVIO_FIM  "21:00"   (horário de Brasília)
//   ENVIO_MAX_DIA   100
//   ENVIO_MIN_SEG   45        ENVIO_MAX_SEG  120
// -----------------------------------------------------------------------------

const { db, admin } = require("../lib/firebase");
const { enviarTexto, mostrarDigitando, configurada } = require("../lib/evolution");
const {
  COLECAO,
  CONFIG_ENVIO,
  agoraBRT,
  dentroDaJanela,
  montarTexto,
  comRodape
} = require("../lib/contatos");

const MAX_FALHAS_SEGUIDAS = 5;
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const mascara = (n) => String(n).slice(0, 4) + "…" + String(n).slice(-4);

async function rodar() {
  const FV = admin.firestore.FieldValue;

  // 1) existe disparo ativo?
  const ativos = await db.collection("disparos").where("status", "==", "ativo").limit(1).get();
  if (ativos.empty) return { idle: "sem disparo ativo" };

  const dRef = ativos.docs[0].ref;
  const disparo = ativos.docs[0].data() || {};

  // 2) horário
  const agora = agoraBRT();
  if (!dentroDaJanela(agora.minutos)) return { idle: "fora do horário" };

  // 3) limite do dia
  const cRef = db.collection("disparo_contador").doc(agora.dia);
  const cSnap = await cRef.get();
  const enviadosHoje = cSnap.exists ? cSnap.data().enviados || 0 : 0;
  if (enviadosHoje >= CONFIG_ENVIO.maxDia) return { idle: "limite do dia atingido" };

  // 4) reserva a vez (só um worker por vez, respeitando o intervalo)
  const liberado = await db.runTransaction(async (t) => {
    const s = await t.get(dRef);
    const d = s.data() || {};
    if (d.status !== "ativo") return false;
    if (Date.now() < Number(d.proximoEnvioEm || 0)) return false;
    const seg =
      CONFIG_ENVIO.minSeg + Math.random() * Math.max(0, CONFIG_ENVIO.maxSeg - CONFIG_ENVIO.minSeg);
    t.update(dRef, { proximoEnvioEm: Date.now() + seg * 1000 });
    return true;
  });
  if (!liberado) return { idle: "aguardando intervalo" };

  // 5) próximo da fila (pula quem pediu para parar depois que o disparo foi criado)
  for (let i = 0; i < 5; i++) {
    const q = await dRef.collection("fila").where("status", "==", "pendente").limit(1).get();

    if (q.empty) {
      await dRef.update({ status: "concluido", concluidoEm: FV.serverTimestamp() });
      return { concluido: true };
    }

    const item = q.docs[0];
    const numero = item.id;
    const contatoRef = db.collection(COLECAO).doc(numero);
    const contato = (await contatoRef.get()).data() || {};

    if (contato.optOut || contato.semWhatsapp === true) {
      await item.ref.update({
        status: "ignorado",
        motivo: contato.optOut ? "pediu para parar" : "sem WhatsApp"
      });
      await dRef.update({ ignorados: FV.increment(1) });
      continue;
    }

    // Marca antes de enviar: se a função cair no meio, o número nunca recebe duas vezes
    await item.ref.update({ status: "enviando", tentativaEm: Date.now() });

    const destino = contato.numeroWpp || numero;
    const texto = comRodape(montarTexto(disparo.texto, contato.nome));

    await mostrarDigitando(destino, 1500).catch(() => {});
    await espera(1500 + Math.random() * 2500);
    const r = await enviarTexto(destino, texto);

    // ---- deu certo ----
    if (r.ok) {
      await Promise.all([
        item.ref.update({ status: "enviado", em: FV.serverTimestamp() }),
        dRef.update({ enviados: FV.increment(1), falhasSeguidas: 0 }),
        cRef.set({ enviados: FV.increment(1) }, { merge: true }),
        contatoRef.set(
          { ultimoEnvio: FV.serverTimestamp(), envios: FV.increment(1) },
          { merge: true }
        )
      ]);
      return { enviado: mascara(numero) };
    }

    const erroTxt = (typeof r.erro === "string" ? r.erro : JSON.stringify(r.erro || "")).slice(0, 300);

    // ---- número que não tem WhatsApp: problema do contato, não do sistema ----
    if (r.status === 400 && /exists["'\s:]*false/i.test(erroTxt)) {
      await Promise.all([
        item.ref.update({ status: "sem_whatsapp" }),
        dRef.update({ ignorados: FV.increment(1) }),
        contatoRef.set({ semWhatsapp: true }, { merge: true })
      ]);
      return { sem_whatsapp: mascara(numero) };
    }

    // ---- falha de verdade ----
    await Promise.all([
      item.ref.update({ status: "falhou", erro: erroTxt }),
      dRef.update({ falhas: FV.increment(1), falhasSeguidas: FV.increment(1) })
    ]);

    const depois = (await dRef.get()).data() || {};
    if ((depois.falhasSeguidas || 0) >= MAX_FALHAS_SEGUIDAS) {
      await dRef.update({
        status: "pausado",
        motivoPausa: `${MAX_FALHAS_SEGUIDAS} falhas seguidas. Confira se o WhatsApp da Ana está conectado e retome.`
      });
      return { pausado: "falhas seguidas" };
    }
    return { falhou: mascara(numero) };
  }

  return { idle: "vários ignorados, continua no próximo ciclo" };
}

module.exports = async (req, res) => {
  const segredo = process.env.CRON_SECRET;
  if (!segredo) {
    return res.status(500).json({ ok: false, erro: "CRON_SECRET não configurada." });
  }
  const recebido = req.query?.k || req.headers["x-cron-key"];
  if (recebido !== segredo) {
    return res.status(401).json({ ok: false, erro: "não autorizado" });
  }
  if (!db) {
    return res.status(500).json({ ok: false, erro: "Firestore não conectado" });
  }
  if (!configurada()) {
    return res.status(200).json({ ok: true, idle: "Evolution não configurada" });
  }

  try {
    const r = await rodar();
    return res.status(200).json({ ok: true, ...r });
  } catch (err) {
    console.error("[disparo-worker] erro:", err);
    return res.status(200).json({ ok: false, erro: err.message || String(err) });
  }
};
