/*
Esse arquivo faz:
1. Lógica de verificação de transporte escolar (aluno, rotas, pontos)
2. Busca a rota da escola e calcula distância para encontrar ponto mais próximo
3. Encerra ou prossegue o fluxo de acordo com os resultados
*/

const { userState } = require("../utils/conversationState");
const {
  sendTextMessage,
  sendInteractiveMessageWithButtons,
} = require("./whatsappService");
const endConversation = require("../utils/endConversation");
const { getRoutesBySchool, getPointsByRoutes } = require("./dbService");
const { calculateDistance } = require("../utils/distanceUtils");

async function checkStudentTransport(to) {
  const aluno = userState[to] ? userState[to].aluno : null;
  if (!aluno) {
    await sendTextMessage(
      to,
      "Não encontramos dados do aluno. Tente novamente."
    );
    return;
  }
  if (!aluno.transporte_escolar_poder_publico) {
    await sendInteractiveMessageWithButtons(
      to,
      "O aluno não é usuário do transporte público. Deseja solicitar?",
      "",
      "Sim",
      "request_transport_yes",
      "Não",
      "request_transport_no"
    );
    return;
  }
  const schoolId = aluno.escola_id;
  if (!schoolId) {
    await endConversation(
      to,
      "Não foi possível identificar a escola do aluno. Encerrando."
    );
    return;
  }
  const routeIds = await getRoutesBySchool(schoolId);
  if (!routeIds || routeIds.length === 0) {
    await endConversation(
      to,
      "Não há rotas cadastradas para a escola do aluno. Tente novamente mais tarde."
    );
    return;
  }
  const routePoints = await getPointsByRoutes(routeIds);
  if (!routePoints || routePoints.length === 0) {
    await endConversation(
      to,
      "Não encontramos pontos de parada nessas rotas. Verifique com a secretaria."
    );
    return;
  }
  const lat = userState[to].latitude;
  const lng = userState[to].longitude;
  if (!lat || !lng) {
    userState[to].step = "enviar_localizacao";
    await sendTextMessage(
      to,
      "Não foi possível identificar suas coordenadas. Por favor, envie sua localização atual da residência do aluno."
    );
    return;
  }
  await finishCheckStudentTransport(to, routePoints);
}

async function finishCheckStudentTransport(to, optionalPoints = null) {
  const aluno = userState[to] ? userState[to].aluno : null;
  if (!aluno) {
    await endConversation(to, "Não encontramos dados do aluno. Encerrando.");
    return;
  }
  if (!aluno.escola_id) {
    await endConversation(
      to,
      "Não foi possível identificar a escola do aluno. Encerrando."
    );
    return;
  }

  let routePoints = optionalPoints;
  if (!routePoints) {
    const routeIds = await getRoutesBySchool(aluno.escola_id);
    if (!routeIds || routeIds.length === 0) {
      await endConversation(
        to,
        "Não há rotas cadastradas para a escola do aluno. Tente novamente mais tarde."
      );
      return;
    }
    routePoints = await getPointsByRoutes(routeIds);
    if (!routePoints || routePoints.length === 0) {
      await endConversation(
        to,
        "Não encontramos pontos de parada nessas rotas. Verifique com a secretaria."
      );
      return;
    }
  }
  const lat = userState[to].latitude;
  const lng = userState[to].longitude;
  if (!lat || !lng) {
    await endConversation(
      to,
      "Não foi possível identificar suas coordenadas. Encerrando."
    );
    return;
  }

  let minDistance = Infinity;
  let nearestPoint = null;
  for (const p of routePoints) {
    const distance = calculateDistance(lat, lng, p.latitude, p.longitude);
    if (distance < minDistance) {
      minDistance = distance;
      nearestPoint = p;
    }
  }

  if (!nearestPoint) {
    await endConversation(
      to,
      "Não foi possível encontrar um ponto de parada próximo. Tente novamente mais tarde."
    );
  } else {
    const directionsUrl = `https://www.google.com/maps/dir/?api=1&origin=${lat},${lng}&destination=${nearestPoint.latitude},${nearestPoint.longitude}&travelmode=walking`;
    await sendTextMessage(
      to,
      `Ponto de parada mais próximo vinculado à rota da escola: *${nearestPoint.nome_ponto}*.\nCoordenadas: ${nearestPoint.latitude}, ${nearestPoint.longitude}.\n[Rota no Google Maps](${directionsUrl})`
    );
    await endConversation(to, "Esperamos ter ajudado! Atendimento encerrado.");
  }
}

module.exports = {
  checkStudentTransport,
  finishCheckStudentTransport,
};
