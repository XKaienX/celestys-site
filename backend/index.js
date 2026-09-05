require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { MercadoPagoConfig, Preference } = require("mercadopago");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ========================================
// MERCADO PAGO
// ========================================

let mpClient = null;
let preferenceClient = null;

const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN;

const tokenValido =
    accessToken &&
    accessToken !== "COLE_SEU_ACCESS_TOKEN_AQUI";

if (tokenValido) {
    mpClient = new MercadoPagoConfig({
        accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN
    });

    preferenceClient = new Preference(mpClient);

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

        if (!Array.isArray(produtos) || produtos.length === 0 || !nick) {
            return res.status(400).json({
                sucesso: false,
                erro: "Produtos e nick são obrigatórios."
            });
        }

        const items = produtos.map((produto) => {

            const preco = Number(produto.preco);

            if (!produto.nome || !Number.isFinite(preco) || preco <= 0) {
                throw new Error("Produto ou preço inválido.");
            }

            return {
                title: produto.nome,
                quantity: 1,
                unit_price: preco,
                currency_id: "BRL"
            };

        });

        const preference = await preferenceClient.create({
            body: {

                items: items,

                external_reference: `CELESTYS-${Date.now()}`,

                metadata: {
                    nick: nick
                }

            }
        });

        console.log("💰 Pagamento criado!");
        console.log("🎮 Nick:", nick);
        console.log("📦 Produtos:", produtos.length);
        console.log("🔗 Preference:", preference.id);

        res.json({
            sucesso: true,
            preference_id: preference.id,
            pagamento_url: preference.init_point
        });

    } catch (error) {

        console.error("❌ Erro ao criar pagamento:");
        console.error(error);

        res.status(500).json({
            sucesso: false,
            erro: "Não foi possível criar o pagamento."
        });
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