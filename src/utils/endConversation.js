/*
Esse arquivo faz:
1. Encerra a conversa com o usuário
2. Envia mensagem final e limpa o estado/timer do usuário
*/

const { userState, userTimers } = require("./conversationState");
const { sendTextMessage } = require("../services/whatsappService");

async function endConversation(
  senderNumber,
  farewellMsg = "Atendimento encerrado."
) {
  await sendTextMessage(senderNumber, farewellMsg);
  delete userState[senderNumber];
  if (userTimers[senderNumber]) {
    clearTimeout(userTimers[senderNumber]);
    delete userTimers[senderNumber];
  }
}

module.exports = endConversation;
