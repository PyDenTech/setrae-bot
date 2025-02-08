/*
Esse arquivo faz:
1. Armazena e gerencia o estado de cada usuário no bot
2. Define a duração do timeout de inatividade
*/

module.exports = {
  userState: {},
  userTimers: {},
  TIMEOUT_DURATION: 10 * 60 * 1000, // 10 minutos
};
