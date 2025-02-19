/*
Arquivo: transportService.js
---------------------------------
Este arquivo:
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
      "Desculpe, mas não encontramos dados do(a) aluno(a). Poderia tentar novamente, por favor?"
    );
    return;
  }
  if (!aluno.transporte_escolar_poder_publico) {
    await sendInteractiveMessageWithButtons(
      to,
      "Verificamos que este(a) aluno(a) não faz uso do transporte escolar público. Gostaria de solicitar este serviço?",
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
      "Não foi possível identificar a escola do(a) aluno(a). Encerrando o atendimento. Por favor, tente novamente ou entre em contato com o suporte."
    );
    return;
  }
  const routeIds = await getRoutesBySchool(schoolId);
  if (!routeIds || routeIds.length === 0) {
    await endConversation(
      to,
      "Não encontramos rotas cadastradas para a escola desse(a) aluno(a). Por favor, tente novamente mais tarde ou entre em contato com o suporte."
    );
    return;
  }
  const routePoints = await getPointsByRoutes(routeIds);
  if (!routePoints || routePoints.length === 0) {
    await endConversation(
      to,
      "Não localizamos pontos de parada nessas rotas. Recomendamos verificar diretamente com a secretaria."
    );
    return;
  }
  const lat = userState[to].latitude;
  const lng = userState[to].longitude;
  if (!lat || !lng) {
    userState[to].step = "enviar_localizacao";
    await sendTextMessage(
      to,
      "Não foi possível identificar sua localização. Por favor, envie a localização atual da residência do(a) aluno(a)."
    );
    return;
  }
  await finishCheckStudentTransport(to, routePoints);
}

async function finishCheckStudentTransport(to, optionalPoints = null) {
  const aluno = userState[to] ? userState[to].aluno : null;
  if (!aluno) {
    await endConversation(
      to,
      "Desculpe, não encontramos dados do(a) aluno(a). Encerrando o atendimento."
    );
    return;
  }
  if (!aluno.escola_id) {
    await endConversation(
      to,
      "Não foi possível identificar a escola do(a) aluno(a). Encerrando o atendimento."
    );
    return;
  }

  let routePoints = optionalPoints;
  if (!routePoints) {
    const routeIds = await getRoutesBySchool(aluno.escola_id);
    if (!routeIds || routeIds.length === 0) {
      await endConversation(
        to,
        "Não encontramos rotas cadastradas para a escola do(a) aluno(a). Por favor, tente novamente mais tarde."
      );
      return;
    }
    routePoints = await getPointsByRoutes(routeIds);
    if (!routePoints || routePoints.length === 0) {
      await endConversation(
        to,
        "Não localizamos pontos de parada nessas rotas. Verifique com a secretaria, se possível."
      );
      return;
    }
  }
  const lat = userState[to].latitude;
  const lng = userState[to].longitude;
  if (!lat || !lng) {
    await endConversation(
      to,
      "Não foi possível identificar sua localização. Encerrando o atendimento. Se precisar, por favor, tente novamente."
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
      "Não encontramos um ponto de parada próximo. Por favor, tente novamente mais tarde ou entre em contato com o suporte."
    );
  } else {
    const directionsUrl = `https://www.google.com/maps/dir/?api=1&origin=${lat},${lng}&destination=${nearestPoint.latitude},${nearestPoint.longitude}&travelmode=walking`;
    await sendTextMessage(
      to,
      `Ponto de parada mais próximo vinculado à rota da escola: *${nearestPoint.nome_ponto}*.\nCoordenadas: ${nearestPoint.latitude}, ${nearestPoint.longitude}.\nAcesse o [Google Maps](${directionsUrl}) para ver o trajeto sugerido.`
    );
    await endConversation(
      to,
      "Esperamos que isso ajude! Seu atendimento foi finalizado, mas estamos sempre aqui caso precise de mais alguma informação."
    );
  }
}

module.exports = {
  checkStudentTransport,
  finishCheckStudentTransport,
};
