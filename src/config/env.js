/*
Esse arquivo faz:
1. Exporta variáveis de ambiente carregadas do .env
2. Define constantes usadas em todo o projeto (tokens, chaves, etc.)
3. Configura dados como PORTA, URL do Banco, etc.
*/

require("dotenv").config();

module.exports = {
  WHATSAPP_API_URL: "https://graph.facebook.com/v20.0",
  ACCESS_TOKEN: process.env.ACCESS_TOKEN,
  PHONE_NUMBER_ID: process.env.PHONE_NUMBER_ID,
  VERIFY_TOKEN: process.env.VERIFY_TOKEN,
  GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY,
  DATABASE_URL: process.env.DATABASE_URL,
  BOT_PORT: process.env.BOT_PORT || 3000,

  // Contatos para notificação
  OPERATOR_NUMBER: "5594984131399",
  HUMAN_AGENTS: {
    transporte_escolar: "5594984131399",
    transporte_administrativo: "5594984131399",
  },
};
