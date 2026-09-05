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

async function inicializarBanco() {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS pedidos (
                id BIGSERIAL PRIMARY KEY,

                nick VARCHAR(32) NOT NULL,

                external_reference VARCHAR(100) UNIQUE NOT NULL,

                preference_id VARCHAR(100),

                payment_id VARCHAR(100) UNIQUE,

                valor NUMERIC(10,2) NOT NULL,

                desconto NUMERIC(10,2) DEFAULT 0,

                valor_final NUMERIC(10,2) NOT NULL,

                cupom VARCHAR(50),

                status VARCHAR(30) NOT NULL DEFAULT 'pending',

                entrega_status VARCHAR(30) NOT NULL DEFAULT 'pendente',

                entregue BOOLEAN NOT NULL DEFAULT FALSE,

                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        `);

        await db.query(`
            CREATE TABLE IF NOT EXISTS pedido_itens (
                id BIGSERIAL PRIMARY KEY,

                pedido_id BIGINT NOT NULL,

                produto_nome TEXT NOT NULL,

                quantidade INTEGER NOT NULL DEFAULT 1,

                valor_unitario NUMERIC(10,2) NOT NULL,

                valor_total NUMERIC(10,2) NOT NULL,

                entregue BOOLEAN NOT NULL DEFAULT FALSE,

                entregue_em TIMESTAMPTZ,

                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

                CONSTRAINT fk_pedido
                    FOREIGN KEY (pedido_id)
                    REFERENCES pedidos(id)
                    ON DELETE CASCADE
            );
        `);

        await db.query(`
            CREATE TABLE IF NOT EXISTS cupons (
                id BIGSERIAL PRIMARY KEY,

                codigo VARCHAR(50) UNIQUE NOT NULL,

                desconto_percentual NUMERIC(5,2) DEFAULT 0,

                desconto_fixo NUMERIC(10,2) DEFAULT 0,

                ativo BOOLEAN NOT NULL DEFAULT TRUE,

                uso_maximo INTEGER,

                usos_realizados INTEGER NOT NULL DEFAULT 0,

                validade TIMESTAMPTZ,

                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        `);

        await db.query(`
            CREATE INDEX IF NOT EXISTS idx_pedidos_nick
            ON pedidos(nick);
        `);

        await db.query(`
            CREATE INDEX IF NOT EXISTS idx_pedidos_status
            ON pedidos(status);
        `);

        await db.query(`
            CREATE INDEX IF NOT EXISTS idx_pedidos_entrega
            ON pedidos(entrega_status);
        `);

        await db.query(`
            CREATE INDEX IF NOT EXISTS idx_pedido_itens_pedido
            ON pedido_itens(pedido_id);
        `);

        console.log("🗄️ PostgreSQL conectado!");
        console.log("📦 Tabelas verificadas/criadas!");
        console.log("🛒 Sistema de pedidos pronto!");
        console.log("📋 Sistema de itens pronto!");
        console.log("🎟️ Sistema de cupons pronto!");

    } catch (error) {
        console.error("❌ Erro ao inicializar o banco de dados:");
        console.error(error);
    }
}

inicializarBanco();

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

        const { produtos, nick, cupom } = req.body;

        console.log("========================================");
console.log("📥 DADOS RECEBIDOS NO PAGAMENTO");
console.log("🎟️ Cupom recebido:", cupom);
console.log("🎮 Nick recebido:", nick);
console.log("📦 Produtos recebidos:", produtos);
console.log("========================================");

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
// VALIDAR CUPOM
// ========================================

let cupomUsado = null;

if (cupom) {

    const codigoCupom = String(cupom)
        .trim()
        .toUpperCase();

    const cupomResult = await db.query(
        `
        SELECT *
        FROM cupons
        WHERE codigo = $1
        LIMIT 1
        `,
        [codigoCupom]
    );

    if (cupomResult.rowCount === 0) {
        return res.status(400).json({
            sucesso: false,
            erro: "Cupom inválido."
        });
    }

    cupomUsado = cupomResult.rows[0];

    // Verificar se está ativo
    if (!cupomUsado.ativo) {
        return res.status(400).json({
            sucesso: false,
            erro: "Este cupom está desativado."
        });
    }

    // Verificar validade
    if (
        cupomUsado.validade &&
        new Date(cupomUsado.validade) < new Date()
    ) {
        return res.status(400).json({
            sucesso: false,
            erro: "Este cupom está expirado."
        });
    }

    // Verificar limite de usos
    if (
        cupomUsado.uso_maximo !== null &&
        cupomUsado.usos_realizados >= cupomUsado.uso_maximo
    ) {
        return res.status(400).json({
            sucesso: false,
            erro: "Este cupom atingiu o limite de usos."
        });
    }

    console.log("🎟️ Cupom válido:", codigoCupom);

}

        // ========================================
// TRANSFORMAR PRODUTOS DO CARRINHO
// ========================================

const itensPedido = [];

const items = produtos.map((produto) => {

    if (!produto || typeof produto !== "object") {
        throw new Error("Produto inválido.");
    }

    const nomeRecebido = String(produto.nome || "").trim();

    if (!nomeRecebido) {
        throw new Error("Produto sem nome.");
    }

    // ========================================
    // CHUNK LOADER
    // ========================================

    if (nomeRecebido.startsWith("Chunk Loader - ")) {

        const quantidade = parseInt(
            nomeRecebido
                .replace("Chunk Loader - ", "")
                .replace("x", ""),
            10
        );

        if (!Number.isInteger(quantidade) || quantidade <= 0) {
            throw new Error("Quantidade de Chunk Loader inválida.");
        }

        const valorUnitario = 15;
        const valorTotal = quantidade * valorUnitario;

        itensPedido.push({
            produto_nome: "Chunk Loader",
            quantidade: quantidade,
            valor_unitario: valorUnitario,
            valor_total: Number(valorTotal.toFixed(2))
        });

        return {
            title: `Chunk Loader - ${quantidade}x`,
            quantity: 1,
            unit_price: Number(valorTotal.toFixed(2)),
            currency_id: "BRL"
        };
    }

    // ========================================
    // AUMENTO DE TERRENO
    // ========================================

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

        const valorUnitario = 0.50;
        const valorTotal = quantidade * valorUnitario;

        itensPedido.push({
            produto_nome: "Aumento de Terreno",
            quantidade: quantidade,
            valor_unitario: valorUnitario,
            valor_total: Number(valorTotal.toFixed(2))
        });

        return {
            title: `Aumento de Terreno - ${quantidade} unidades`,
            quantity: 1,
            unit_price: Number(valorTotal.toFixed(2)),
            currency_id: "BRL"
        };
    }

    // ========================================
    // PRODUTOS NORMAIS
    // ========================================

    let nomeBase = nomeRecebido;

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
        throw new Error(
            `Produto não encontrado no catálogo: ${nomeBase}`
        );
    }

    // ========================================
    // PACOTES DE 5 CHAVES
    // ========================================

    if (
        nomeBase === "Chaves de Máquinas" ||
        nomeBase === "Chaves de Shiny"
    ) {

        if (quantidade % 5 !== 0) {
            throw new Error(
                "A quantidade deve ser múltipla de 5."
            );
        }

        const quantidadePacotes = quantidade / 5;
        const valorTotal = precoUnitario * quantidadePacotes;

        itensPedido.push({
            produto_nome: nomeBase,
            quantidade: quantidade,
            valor_unitario: precoUnitario / 5,
            valor_total: Number(valorTotal.toFixed(2))
        });

        return {
            title: `${nomeBase} - ${quantidade}x`,
            quantity: 1,
            unit_price: Number(valorTotal.toFixed(2)),
            currency_id: "BRL"
        };
    }

    // ========================================
    // CHAVES UNITÁRIAS / VIPS
    // ========================================

    const valorTotal = precoUnitario * quantidade;

    itensPedido.push({
        produto_nome: nomeBase,
        quantidade: quantidade,
        valor_unitario: precoUnitario,
        valor_total: Number(valorTotal.toFixed(2))
    });

    return {
        title: `${nomeBase} - ${quantidade}x`,
        quantity: 1,
        unit_price: Number(valorTotal.toFixed(2)),
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
// CALCULAR VALOR ORIGINAL DA COMPRA
// ========================================

const valorPedido = itensPedido.reduce(
    (total, item) => total + item.valor_total,
    0
);

// ========================================
// CALCULAR DESCONTO DO CUPOM
// ========================================

let desconto = 0;
let valorFinal = valorPedido;

if (cupomUsado) {

    const valorMinimo = Number(
        cupomUsado.valor_minimo || 0
    );

    if (valorPedido < valorMinimo) {

        return res.status(400).json({
            sucesso: false,
            erro: `Este cupom exige uma compra mínima de R$ ${valorMinimo.toFixed(2)}.`
        });

    }

    const descontoPercentual = Number(
        cupomUsado.desconto_percentual || 0
    );

    const descontoFixo = Number(
        cupomUsado.desconto_fixo || 0
    );

    // Desconto percentual
    if (descontoPercentual > 0) {

        desconto =
            valorPedido * (descontoPercentual / 100);

    }

    // Desconto fixo
    if (descontoFixo > 0) {

        desconto += descontoFixo;

    }

    // Nunca deixar o desconto passar do valor da compra
    if (desconto > valorPedido) {

        desconto = valorPedido;

    }

    valorFinal = valorPedido - desconto;
}

// ========================================
// ARREDONDAR VALORES
// ========================================

desconto = Number(
    desconto.toFixed(2)
);

valorFinal = Number(
    valorFinal.toFixed(2)
);

console.log("💰 Valor original:", valorPedido);
console.log("🎟️ Desconto:", desconto);
console.log("💳 Valor final:", valorFinal);

// ========================================
// ITEM FINAL PARA O MERCADO PAGO
// ========================================

const itemsComDesconto = [
    {
        title: `Compra Celestys - ${nickLimpo}`,
        quantity: 1,
        unit_price: valorFinal,
        currency_id: "BRL"
    }
];

// ========================================
// CRIAR PREFERÊNCIA NO MERCADO PAGO
// ========================================

const preference = await preferenceClient.create({

    body: {

        items: itemsComDesconto,

        external_reference: referencia,

        metadata: {
            nick: nickLimpo
        }

    }

});

// ========================================
// SALVAR PEDIDO NO BANCO
// ========================================

const pedidoResult = await db.query(
    `
    INSERT INTO pedidos (
        nick,
        external_reference,
        preference_id,
        valor,
        desconto,
        valor_final,
        cupom,
        status,
        entrega_status,
        entregue
    )
    VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9,
        $10
    )
    RETURNING id
    `,
    [
        nickLimpo,
        referencia,
        preference.id,
        Number(valorPedido.toFixed(2)),
        desconto,
        Number(valorFinal.toFixed(2)),
        cupomUsado ? cupomUsado.codigo : null,
        "pending",
        "pendente",
        false
    ]
);

const pedidoId = pedidoResult.rows[0].id;

// ========================================
// SALVAR ITENS DO PEDIDO
// ========================================

for (const item of itensPedido) {

    await db.query(
        `
        INSERT INTO pedido_itens (
            pedido_id,
            produto_nome,
            quantidade,
            valor_unitario,
            valor_total
        )
        VALUES ($1, $2, $3, $4, $5)
        `,
        [
            pedidoId,
            item.produto_nome,
            item.quantidade,
            item.valor_unitario,
            item.valor_total
        ]
    );

}

console.log("🗄️ Pedido salvo no banco!");
console.log("🆔 Pedido ID:", pedidoId);

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

// ========================================
// LOCALIZAR PEDIDO NO BANCO
// ========================================

const referencia = pagamento.external_reference;

if (!referencia) {

    console.error("❌ Pagamento sem referência externa.");

    return res.sendStatus(200);
}

const pedidoResult = await db.query(
    `
    SELECT *
    FROM pedidos
    WHERE external_reference = $1
    LIMIT 1
    `,
    [referencia]
);

if (pedidoResult.rowCount === 0) {

    console.error("❌ Pedido não encontrado no banco.");
    console.error("🧾 Referência:", referencia);

    return res.sendStatus(200);
}

const pedido = pedidoResult.rows[0];

// ========================================
// PROTEGER CONTRA PAGAMENTO DUPLICADO
// ========================================

if (pedido.payment_id) {
    if (String(pedido.payment_id) === String(pagamento.id)) {
        console.log("ℹ️ Pagamento já foi processado anteriormente.");
        console.log("💳 Payment ID:", pagamento.id);
        return res.sendStatus(200);
    }

    console.error("🚨 PEDIDO JÁ POSSUI OUTRO PAYMENT ID!");
    console.error("🧾 Referência:", referencia);
    console.error("💳 Payment ID salvo:", pedido.payment_id);
    console.error("💳 Payment ID recebido:", pagamento.id);

    return res.sendStatus(200);
}

console.log("✅ Pagamento ainda não foi processado.");

// ========================================
// VERIFICAR NICK DO PEDIDO
// ========================================

const nickPagamento = String(
    pagamento.metadata?.nick || ""
).trim();

const nickPedido = String(
    pedido.nick || ""
).trim();

if (!nickPagamento) {
    console.error("🚨 PAGAMENTO SEM NICK!");
    console.error("🧾 Referência:", referencia);
    return res.sendStatus(200);
}

if (nickPagamento !== nickPedido) {
    console.error("🚨 NICK DO PAGAMENTO NÃO CONFERE!");
    console.error("🧾 Referência:", referencia);
    console.error("🎮 Nick esperado:", nickPedido);
    console.error("🎮 Nick recebido:", nickPagamento);

    return res.sendStatus(200);
}

console.log("✅ Nick do pagamento confirmado!");
console.log("🎮 Nick:", nickPagamento);

// ========================================
// VERIFICAR VALOR DO PAGAMENTO
// ========================================

const valorPago = Number(
    Number(pagamento.transaction_amount).toFixed(2)
);

const valorPedido = Number(
    Number(pedido.valor_final).toFixed(2)
);

if (valorPago !== valorPedido) {

    console.error("🚨 VALOR DO PAGAMENTO NÃO CONFERE!");
    console.error("🧾 Referência:", referencia);
    console.error("💰 Valor esperado:", valorPedido);
    console.error("💳 Valor recebido:", valorPago);

    return res.sendStatus(200);
}

console.log("✅ Valor do pagamento confirmado!");
console.log("💰 Valor:", valorPago);

// ========================================
// ATUALIZAR STATUS DO PEDIDO
// ========================================

if (pagamento.status !== "approved") {

    await db.query(
        `
        UPDATE pedidos
        SET
            status = $1,
            updated_at = NOW()
        WHERE external_reference = $2
        `,
        [
            String(pagamento.status),
            referencia
        ]
    );

    console.log("🗄️ Status do pedido atualizado!");
    console.log("🧾 Referência:", referencia);
    console.log("📊 Status:", pagamento.status);

    return res.sendStatus(200);
}

      if (pagamento.status === "approved") {

    console.log("🎉 PAGAMENTO APROVADO!");
    console.log("🎮 Nick:", pagamento.metadata?.nick);

    // ========================================
    // ATUALIZAR PEDIDO NO BANCO
    // ========================================

    const resultadoPedido = await db.query(
        `
        UPDATE pedidos
        SET
            payment_id = $1,
            status = $2,
            entrega_status = $3,
            entregue = $4,
            updated_at = NOW()
        WHERE external_reference = $5
        AND payment_id IS NULL
        RETURNING id, nick, valor_final, cupom
        `,
        [
            String(pagamento.id),
            "approved",
            "pendente",
            false,
            referencia
        ]
    );

    if (resultadoPedido.rowCount === 0) {

        console.error(
            "❌ Pedido não encontrado ou pagamento já processado."
        );

        console.error(
            "🧾 Referência:",
            referencia
        );

    } else {

        const pedido = resultadoPedido.rows[0];

        console.log("🗄️ Pedido atualizado no banco!");
        console.log("🆔 Pedido ID:", pedido.id);
        console.log("🎮 Nick:", pedido.nick);
        console.log("💰 Valor:", pedido.valor_final);
        console.log("📦 Entrega: pendente");

        // ========================================
        // REGISTRAR USO DO CUPOM
        // ========================================

        if (pedido.cupom) {

            await db.query(
                `
                UPDATE cupons
                SET usos_realizados = usos_realizados + 1
                WHERE codigo = $1
                `,
                [pedido.cupom]
            );

            console.log("🎟️ Uso do cupom registrado!");
            console.log("🏷️ Cupom:", pedido.cupom);
        }
    }
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