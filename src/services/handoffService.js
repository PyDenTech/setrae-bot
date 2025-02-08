/*
Esse arquivo faz:
1. Encaminha o usuário para um atendente humano
2. Envia notificação para o operador ou agente específico
3. Finaliza a conversa com o usuário
*/

const { OPERATOR_NUMBER, HUMAN_AGENTS } = require("../config/env");
const { sendTextMessage } = require("./whatsappService");
const endConversation = require("../utils/endConversation");

async function handoffToHuman(senderNumber, subject) {
  const agentNumber = HUMAN_AGENTS[subject] || OPERATOR_NUMBER;
  const handoffMsg = `👋 *Nova solicitação de conversa* sobre *${subject}*.\nUsuário: +${senderNumber}\nPor favor, entre em contato.`;
  await sendTextMessage(agentNumber, handoffMsg);

  await endConversation(
    senderNumber,
    "Um atendente foi acionado e entrará em contato em breve. Obrigado!"
  );
}

module.exports = handoffToHuman;
