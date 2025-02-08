/*
Esse arquivo faz:
1. Gerencia o timer de inatividade de cada usuário
2. Chama endConversation() caso o usuário fique inativo
*/

const { userTimers, TIMEOUT_DURATION } = require("./conversationState");
const endConversation = require("./endConversation");

function setInactivityTimeout(senderNumber) {
  if (userTimers[senderNumber]) {
    clearTimeout(userTimers[senderNumber]);
  }
  userTimers[senderNumber] = setTimeout(async () => {
    await endConversation(
      senderNumber,
      "Percebemos que você está ocupado(a). Se precisar de mais ajuda, é só nos chamar a qualquer momento."
    );
  }, TIMEOUT_DURATION);
}

module.exports = setInactivityTimeout;
