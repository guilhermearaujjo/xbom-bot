# X-Bom — Atendimento por IA (etapa 1: base)

Projeto **separado** do site e do backend do X-Bom. Não altera nada do que já
está no ar.

Nesta primeira etapa **ainda não há IA**. O que existe aqui é a fundação: o
cardápio real, a regra de entrega e o validador que recalcula tudo no servidor.
Enquanto os números daqui não baterem com os do site, não vale colocar IA por
cima.

## Como se liga ao que já existe

- **Cardápio:** lido do mesmo `menu-data.js` que o site usa, mais os
  `item_overrides` do painel. Não existe cópia da tabela de preços aqui — você
  continua editando num lugar só.
- **Pedido:** quando chegar a hora, o bot vai postar em `/api/orders` do backend
  atual, exatamente como o site faz. Esse endpoint já grava no Firestore, já
  atualiza o diretório de clientes e já manda para a fila da impressora.
- **Firestore:** usado só para **leitura** de `item_overrides` (e, mais adiante,
  para guardar o estado das conversas).

## Deploy

1. Crie o repositório no GitHub com estes arquivos.
2. Importe na Vercel como projeto novo (não é o mesmo do `xbom-backend`).
3. Em Settings → Environment Variables, preencha o que está em `.env.example`.

### A chave do Firebase

No console do Firebase: Configurações do projeto → Contas de serviço → Gerar
nova chave privada. Do JSON baixado você precisa de três campos:

- `project_id` → `FIREBASE_PROJECT_ID`
- `client_email` → `FIREBASE_CLIENT_EMAIL`
- `private_key` → `FIREBASE_PRIVATE_KEY`

Cole a chave privada inteira, incluindo `-----BEGIN PRIVATE KEY-----`. Os `\n`
podem ficar literais — o código converte.

## Testando

### 1. Saúde do sistema

```
GET https://SEU-PROJETO.vercel.app/api/health
```

Confirma se o Firebase conectou, quantos itens o cardápio carregou, quantos
estão pausados e se a loja está aberta agora.

### 2. Ver o cardápio como o bot enxerga

```
GET /api/conferencia
GET /api/conferencia?cat=combos
GET /api/conferencia?forcar=1     (ignora o cache de 5 min)
```

Compare alguns preços com o site. Pause um item no painel e recarregue com
`forcar=1` para confirmar que o `pausado` aparece aqui.

### 3. Simular um pedido

```
POST /api/conferencia
Content-Type: application/json

{
  "itens": [
    { "id": "fran-file", "qtd": 1, "adicionais": ["Cheddar"], "obs": "Sem mussarela" },
    { "id": "refri-600", "qtd": 1 }
  ],
  "formaEntrega": "entrega",
  "cep": "18110005",
  "endereco": "Rua Teste, 300",
  "nome": "Guilherme",
  "telefone": "15996782039"
}
```

Monte o mesmo carrinho no site e confira se `subtotal`, `taxa` e `total` batem.
**É este o teste que importa nesta etapa.**

Vale testar também os casos que têm que falhar:

- CEP de fora de Votorantim → recusa
- item pausado no painel → recusa
- adicional em refrigerante → recusa
- id de item que não existe → recusa

## Pendências conhecidas

Três coisas ficaram configuráveis porque ainda não estão confirmadas:

1. **Horário.** O site tem `{abre:'17:00', fecha:'23:30'}` com um comentário
   dizendo "24h aberto". Ajuste `HORA_ABRE` / `HORA_FECHA`, ou
   `BLOQUEAR_FORA_HORARIO=false` para o bot só avisar sem recusar.
2. **Adicionais por categoria.** `CATEGORIAS_COM_ADICIONAL` em `lib/config.js`
   espelha o `isLanche`/`isCombo` do site. Confirme se porções e bebidas
   realmente não aceitam.
3. **Refrigerante e suco.** As listas de sabor por tamanho ainda não estão
   validadas aqui — o campo `soda` passa como texto livre por enquanto.

## Próximas etapas

- Página de chat de teste (Hostinger, protegida por senha)
- Camada de IA: prompt, JSON estruturado, estado da conversa
- `criar-pedido` postando em `/api/orders`
- Pix reaproveitando o `create-pix.js` existente
- Evolution API na VPS e conexão do WhatsApp por QR
