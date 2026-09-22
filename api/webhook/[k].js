// api/webhook/[k].js
// -----------------------------------------------------------------------------
// Mesma porta de entrada do WhatsApp, com o segredo NO CAMINHO em vez de na
// query:  https://.../api/webhook/SEU_SEGREDO
//
// Existe porque a Evolution corta o "?k=..." ao salvar a URL do webhook — as
// chamadas chegavam sem o segredo e voltavam 401.
// -----------------------------------------------------------------------------

const { tratar } = require("../webhook");

module.exports = async (req, res) => tratar(req, res, req.query?.k);
