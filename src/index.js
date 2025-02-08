/*
Esse arquivo faz:
1. Inicia o servidor Express
2. Configura o parser JSON e rotas
3. Escuta na porta definida em .env (BOT_PORT)
*/

const express = require("express");
const webhookRoutes = require("./controllers/webhookController");
const { BOT_PORT } = require("./config/env");

const app = express();
app.use(express.json());

app.use("/", webhookRoutes);

app.listen(BOT_PORT, () => {
  console.log(`BOT rodando na porta ${BOT_PORT}...`);
});
