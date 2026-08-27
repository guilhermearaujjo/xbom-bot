// lib/entrega.js
// -----------------------------------------------------------------------------
// Regras de entrega — espelham exatamente o scripts.js do site:
//
//   1. CEP precisa ter 8 dígitos e não pode ser 00000000
//   2. Precisa começar com um dos prefixos de Votorantim (18110..18119)
//   3. Geocodifica o CEP e recusa acima de 5 km da loja
//   4. Taxa fixa: R$ 9 para entrega, R$ 0 para retirada
//
// A IA NUNCA calcula taxa. Ela só informa o CEP; quem decide é este arquivo.
// -----------------------------------------------------------------------------

const { ENTREGA } = require("./config");

function normalizarCep(bruto) {
  if (!bruto) return "";
  return String(bruto).replace(/\D/g, "");
}

function formatoCepValido(bruto) {
  const cep = normalizarCep(bruto);
  if (cep.length !== 8) return false;
  if (/^0+$/.test(cep)) return false;
  return true;
}

function cepNaAreaAtendida(bruto) {
  const cep = normalizarCep(bruto);
  if (!formatoCepValido(cep)) return false;
  if (ENTREGA.cepsPermitidos.includes(cep)) return true;
  return ENTREGA.prefixosPermitidos.some((p) => cep.startsWith(p));
}

// Distância em km entre dois pontos (mesma fórmula do site)
function distanciaKm(a, b) {
  const R = 6371;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Geocodificação pelo Nominatim, igual o site faz.
// O Nominatim pede um User-Agent identificável — o site do navegador manda um
// automaticamente, mas aqui somos servidor, então enviamos explicitamente.
async function geocodificarCep(cep) {
  const limpo = normalizarCep(cep);
  if (limpo.length !== 8) throw new Error("CEP inválido");

  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(
    limpo + " Brasil"
  )}`;

  const resp = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": process.env.NOMINATIM_UA || "xbom-bot/0.1 (contato@ntf.com.br)"
    }
  });
  if (!resp.ok) throw new Error("Falha ao consultar geocodificação");

  const dados = await resp.json();
  if (!dados || !dados.length) return null;

  return { lat: parseFloat(dados[0].lat), lon: parseFloat(dados[0].lon) };
}

// -----------------------------------------------------------------------------
// Avaliação completa de um endereço de entrega.
// Devolve sempre um objeto com { ok, taxa, motivo, mensagem } — a mensagem é
// escrita em linguagem de atendimento, pronta para o bot repetir ao cliente.
// -----------------------------------------------------------------------------
async function avaliarEntrega({ formaEntrega, cep }) {
  const entrega = String(formaEntrega || "retirada").toLowerCase() === "entrega";

  if (!entrega) {
    return {
      ok: true,
      entrega: false,
      taxa: 0,
      cep: "",
      motivo: "retirada",
      mensagem: "Retirada no balcão, sem taxa."
    };
  }

  const cepLimpo = normalizarCep(cep);

  if (!formatoCepValido(cepLimpo)) {
    return {
      ok: false,
      entrega: true,
      taxa: 0,
      cep: cepLimpo,
      motivo: "cep_invalido",
      mensagem: "Preciso de um CEP válido, com 8 números."
    };
  }

  if (!cepNaAreaAtendida(cepLimpo)) {
    return {
      ok: false,
      entrega: true,
      taxa: 0,
      cep: cepLimpo,
      motivo: "fora_da_area",
      mensagem: "Infelizmente ainda não entregamos nesse CEP."
    };
  }

  // Checagem de raio. Se o geocoding falhar, seguimos o comportamento do site
  // (que engole o erro e deixa passar), a menos que GEOCODE_TOLERANTE=false.
  let distancia = null;
  try {
    const geo = await geocodificarCep(cepLimpo);
    if (geo) {
      distancia = distanciaKm(ENTREGA.loja, geo);
      if (distancia > ENTREGA.raioKm) {
        return {
          ok: false,
          entrega: true,
          taxa: 0,
          cep: cepLimpo,
          distanciaKm: Number(distancia.toFixed(2)),
          motivo: "fora_do_raio",
          mensagem: `Esse endereço está fora da nossa área de entrega (raio de ${ENTREGA.raioKm} km).`
        };
      }
    }
  } catch (err) {
    console.error("[entrega] geocoding falhou:", err.message);
    if (!ENTREGA.aceitarSeGeocodeFalhar) {
      return {
        ok: false,
        entrega: true,
        taxa: 0,
        cep: cepLimpo,
        motivo: "geocode_falhou",
        mensagem:
          "Não consegui confirmar esse endereço agora. Pode conferir o CEP pra mim?"
      };
    }
  }

  return {
    ok: true,
    entrega: true,
    taxa: ENTREGA.taxa,
    cep: cepLimpo,
    distanciaKm: distancia === null ? null : Number(distancia.toFixed(2)),
    motivo: "ok",
    mensagem: `Entrega confirmada. Taxa de R$ ${ENTREGA.taxa.toFixed(2).replace(".", ",")}.`
  };
}

module.exports = {
  normalizarCep,
  formatoCepValido,
  cepNaAreaAtendida,
  geocodificarCep,
  distanciaKm,
  avaliarEntrega
};
