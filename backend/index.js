require("dotenv").config();

const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");
const {
    MercadoPagoConfig,
    Preference,
    Payment,
    WebhookSignatureValidator,
    InvalidWebhookSignatureError
} = require("mercadopago");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ========================================
// BANCO DE DADOS POSTGRESQL
// ========================================

const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

db.query("SELECT NOW()")
    .then(() => {
        console.log("🗄️ PostgreSQL conectado!");
    })
    .catch((error) => {
        console.error("❌ Erro ao conectar ao PostgreSQL:");
        console.error(error);
    });

// ========================================
// MERCADO PAGO
// ========================================

let mpClient = null;
let preferenceClient = null;
let paymentClient = null;

const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN;
const webhookSecret = process.env.MERCADOPAGO_WEBHOOK_SECRET;

const tokenValido = Boolean(accessToken);

if (tokenValido) {
    mpClient = new MercadoPagoConfig({
        accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN
    });

    preferenceClient = new Preference(mpClient);
    paymentClient = new Payment(mpClient);

    console.log("💳 Mercado Pago configurado!");
} else {
    console.log("⚠️ Access Token do Mercado Pago ainda não configurado.");
}

// ========================================
// ROTA PRINCIPAL
// ========================================

app.get("/", (req, res) => {
    res.json({
        status: "online",
        message: "Celestys Backend está funcionando! 🚀"
    });
});

// ========================================
// STATUS DO MERCADO PAGO
// ========================================

app.get("/mercadopago-status", (req, res) => {

    if (!tokenValido) { 
        return res.status(503).json({
            status: "aguardando",
            message: "Access Token do Mercado Pago ainda não configurado."
        });
    }

    res.json({
        status: "configurado",
        message: "Access Token encontrado."
    });
});

// ========================================
// CATÁLOGO OFICIAL DA LOJA
// ========================================

const CATALOGO = {

    // VIPs
    "VIP Trainer": 9.90,
    "VIP Elite": 19.90,
    "VIP Champion": 34.90,
    "VIP Master": 49.90,

    // Chaves de Lendário
    "Chave de Lendário - 1ª Geração": 9.99,
    "Chave de Lendário - 2ª Geração": 14.99,
    "Chave de Lendário - 3ª Geração": 17.99,
    "Chave de Lendário - 4ª Geração": 11.99,
    "Chave de Lendário - 5ª Geração": 17.99,
    "Chave de Lendário - 6ª Geração": 17.99,
    "Chave de Lendário - 8ª Geração": 19.99,
    "Chave de Lendário - 9ª Geração": 31.99,

    // Outras chaves
    "Chave de Paradox": 5.99,
    "Chave de Ultra Beast": 18.99,

    // Pacotes
    "Chaves de Máquinas": 4.99,
    "Chaves de Shiny": 2.99

};

// ========================================
// CRIAR PAGAMENTO MERCADO PAGO
// ========================================

app.post("/criar-pagamento", async (req, res) => {

    try {

        if (!preferenceClient) {
            return res.status(503).json({
                sucesso: false,
                erro: "Mercado Pago ainda não configurado."
            });
        }

        const { produtos, nick } = req.body;

        // ========================================
        // VALIDAÇÕES BÁSICAS
        // ========================================

        if (!Array.isArray(produtos) || produtos.length === 0) {
            return res.status(400).json({
                sucesso: false,
                erro: "O carrinho está vazio."
            });
        }

        if (!nick || typeof nick !== "string") {
            return res.status(400).json({
                sucesso: false,
                erro: "O nick do jogador é obrigatório."
            });
        }

        // Limita o tamanho do nick
        const nickLimpo = nick.trim();

        if (nickLimpo.length < 1 || nickLimpo.length > 32) {
            return res.status(400).json({
                sucesso: false,
                erro: "Nick inválido."
            });
        }

        // ========================================
        // TRANSFORMAR PRODUTOS DO CARRINHO
        // ========================================

        const items = produtos.map((produto) => {

    if (!produto || typeof produto !== "object") {
        throw new Error("Produto inválido.");
    }

    const nomeRecebido = String(produto.nome || "").trim();

    if (!nomeRecebido) {
        throw new Error("Produto sem nome.");
    }

    // ========================================
    // PRODUTOS COM QUANTIDADE
    // ========================================

    // Chunk Loader
    if (nomeRecebido.startsWith("Chunk Loader - ")) {

        const quantidade = parseInt(
            nomeRecebido.replace("Chunk Loader - ", "").replace("x", ""),
            10
        );

        if (!Number.isInteger(quantidade) || quantidade <= 0) {
            throw new Error("Quantidade de Chunk Loader inválida.");
        }

        const precoTotal = quantidade * 15;

        return {
            title: `Chunk Loader - ${quantidade}x`,
            quantity: 1,
            unit_price: Number(precoTotal.toFixed(2)),
            currency_id: "BRL"
        };
    }

    // Aumento de Terreno
    if (nomeRecebido.startsWith("Aumento de Terreno - ")) {

        const quantidade = parseInt(
            nomeRecebido
                .replace("Aumento de Terreno - ", "")
                .replace(" unidades", ""),
            10
        );

        if (
            !Number.isInteger(quantidade) ||
            quantidade <= 0 ||
            quantidade % 10 !== 0
        ) {
            throw new Error("Quantidade de terreno inválida.");
        }

        const precoTotal = (quantidade / 10) * 5;

        return {
            title: `Aumento de Terreno - ${quantidade} unidades`,
            quantity: 1,
            unit_price: Number(precoTotal.toFixed(2)),
            currency_id: "BRL"
        };
    }

    // ========================================
    // PRODUTOS NORMAIS
    // ========================================

    let nomeBase = nomeRecebido;

    // Remove quantidade de chaves, por exemplo:
    // "Chave de Paradox - 3x"
    const quantidadeMatch = nomeRecebido.match(/^(.*) - (\d+)x$/);

    let quantidade = 1;

    if (quantidadeMatch) {
        nomeBase = quantidadeMatch[1].trim();
        quantidade = parseInt(quantidadeMatch[2], 10);
    }

    if (!Number.isInteger(quantidade) || quantidade <= 0) {
        throw new Error("Quantidade inválida.");
    }

    const precoUnitario = CATALOGO[nomeBase];

    if (!precoUnitario) {
        throw new Error(`Produto não encontrado no catálogo: ${nomeBase}`);
    }

    // ========================================
    // PACOTES DE 5 CHAVES
    // ========================================

    if (
        nomeBase === "Chaves de Máquinas" ||
        nomeBase === "Chaves de Shiny"
    ) {

        if (quantidade % 5 !== 0) {
            throw new Error("A quantidade deve ser múltipla de 5.");
        }

        const precoTotal = precoUnitario * (quantidade / 5);

        return {
            title: `${nomeBase} - ${quantidade}x`,
            quantity: 1,
            unit_price: Number(precoTotal.toFixed(2)),
            currency_id: "BRL"
        };
    }

    // ========================================
    // CHAVES UNITÁRIAS
    // ========================================

    const precoTotal = precoUnitario * quantidade;

    return {
        title: `${nomeBase} - ${quantidade}x`,
        quantity: 1,
        unit_price: Number(precoTotal.toFixed(2)),
        currency_id: "BRL"
    };

});

        // ========================================
        // REFERÊNCIA ÚNICA DA COMPRA
        // ========================================

        const referencia = `CELESTYS-${Date.now()}-${Math.floor(
            Math.random() * 10000
        )}`;

        // ========================================
        // CRIAR PREFERÊNCIA NO MERCADO PAGO
        // ========================================

        const preference = await preferenceClient.create({

            body: {

                items: items,

                external_reference: referencia,

                metadata: {
                    nick: nickLimpo
                }

            }

        });

        // ========================================
        // LOGS
        // ========================================

        console.log("========================================");
        console.log("💰 NOVO PAGAMENTO CRIADO!");
        console.log("🎮 Nick:", nickLimpo);
        console.log("📦 Quantidade de itens:", items.length);
        console.log("🧾 Referência:", referencia);
        console.log("🔗 Preference ID:", preference.id);
        console.log("========================================");

        // ========================================
        // RESPOSTA PARA A LOJA
        // ========================================

        return res.json({

            sucesso: true,

            preference_id: preference.id,

            pagamento_url: preference.init_point,

            referencia: referencia

        });

    } catch (error) {

        console.error("========================================");
        console.error("❌ ERRO AO CRIAR PAGAMENTO");
        console.error(error);
        console.error("========================================");

        return res.status(500).json({

            sucesso: false,

            erro: "Não foi possível criar o pagamento."

        });

    }

});

// ========================================
// TESTE DE PAGAMENTO
// ========================================

app.get("/teste-pagamento/:id", async (req, res) => {

    try {

        if (!paymentClient) {
            return res.status(503).json({
                sucesso: false,
                erro: "Mercado Pago não configurado."
            });
        }

        const pagamento = await paymentClient.get({
            id: req.params.id
        });

        console.log("========================================");
        console.log("🔎 CONSULTA DE PAGAMENTO");
        console.log("💳 Payment ID:", pagamento.id);
        console.log("📊 Status:", pagamento.status);
        console.log("💰 Valor:", pagamento.transaction_amount);
        console.log("🧾 Referência:", pagamento.external_reference);
        console.log("🎮 Nick:", pagamento.metadata?.nick);
        console.log("========================================");

        return res.json({
            sucesso: true,
            id: pagamento.id,
            status: pagamento.status,
            valor: pagamento.transaction_amount,
            referencia: pagamento.external_reference,
            nick: pagamento.metadata?.nick
        });

    } catch (error) {

        console.error("❌ Erro ao consultar pagamento:");
        console.error(error);

        return res.status(500).json({
            sucesso: false,
            erro: "Não foi possível consultar o pagamento."
        });

    }

});

// ========================================
// WEBHOOK MERCADO PAGO
// ========================================

app.post("/webhook/mercadopago", async (req, res) => {

    try {

        if (!webhookSecret) {
            console.error("❌ Chave secreta do Webhook não configurada.");
            return res.sendStatus(500);
        }

        const xSignature = req.headers["x-signature"];
        const xRequestId = req.headers["x-request-id"];
        const dataId = req.query["data.id"];

        if (!xSignature || !xRequestId || !dataId) {
            console.error("❌ Webhook recebido sem dados necessários.");
            return res.sendStatus(400);
        }

        // ========================================
        // VALIDAR ASSINATURA
        // ========================================

        WebhookSignatureValidator.validate({
            xSignature: xSignature,
            xRequestId: xRequestId,
            dataId: dataId,
            secret: webhookSecret
        });

        console.log("✅ Assinatura do Webhook válida!");

        // ========================================
        // VERIFICAR TIPO DE NOTIFICAÇÃO
        // ========================================

        const tipo = req.body?.type;

        if (tipo !== "payment") {
            console.log("ℹ️ Webhook ignorado. Tipo:", tipo);
            return res.sendStatus(200);
        }

        // ========================================
        // BUSCAR PAGAMENTO NO MERCADO PAGO
        // ========================================

        let pagamento = null;

try {

    pagamento = await paymentClient.get({
        id: dataId
    });

} catch (erroPagamento) {

    console.log("⚠️ Não foi possível consultar o pagamento:", dataId);
    console.log("ℹ️ Isso pode acontecer no teste com um ID fictício.");

    return res.sendStatus(200);
}

        console.log("========================================");
        console.log("🔔 NOTIFICAÇÃO DE PAGAMENTO");
        console.log("💳 Payment ID:", pagamento.id);
        console.log("📊 Status:", pagamento.status);
        console.log("💰 Valor:", pagamento.transaction_amount);
        console.log("🧾 Referência:", pagamento.external_reference);
        console.log("========================================");

        // ========================================
        // PAGAMENTO APROVADO
        // ========================================

        if (pagamento.status === "approved") {

            console.log("🎉 PAGAMENTO APROVADO!");
            console.log("🎮 Nick:", pagamento.metadata?.nick);

            // ========================================
            // ENTREGA DOS PRODUTOS
            // ========================================
            //
            // A entrega automática será adicionada
            // na próxima etapa.
            //

        }

        return res.sendStatus(200);

    } catch (error) {

        if (error instanceof InvalidWebhookSignatureError) {

            console.error("❌ Assinatura do Webhook inválida!");

            return res.sendStatus(401);
        }

        console.error("❌ Erro no Webhook:");
        console.error(error);

        return res.sendStatus(500);
    }

});

// ========================================
// INICIAR SERVIDOR
// ========================================

app.listen(PORT, () => {

    console.log("========================================");
    console.log("🚀 Celestys Backend iniciado!");
    console.log(`🌐 Porta: ${PORT}`);
    console.log("========================================");

});