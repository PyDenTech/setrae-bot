/*
Arquivo: whatsappService.js
---------------------------------
Este arquivo:
1. Concentra funções para envio de mensagens WhatsApp (texto, botões, listas)
2. Usa a API do Facebook Graph para WhatsApp
3. Lida com estruturas interativas de mensagem
*/

const axios = require("axios");
const {
  WHATSAPP_API_URL,
  PHONE_NUMBER_ID,
  ACCESS_TOKEN,
} = require("../config/env");

async function sendTextMessage(to, text) {
  const message = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "text",
    text: { body: text },
  };
  try {
    await axios.post(`${WHATSAPP_API_URL}/${PHONE_NUMBER_ID}/messages`, message, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    });
  } catch (error) {
    console.error("Erro ao enviar texto:", error?.response?.data || error.message);
  }
}

async function sendInteractiveMessageWithButtons(
  to,
  bodyText,
  footerText,
  button1Title,
  button1Id,
  button2Title,
  button2Id
) {
  const buttonMessage = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: bodyText },
      footer: { text: footerText },
      action: {
        buttons: [
          {
            type: "reply",
            reply: { id: button1Id, title: button1Title },
          },
          {
            type: "reply",
            reply: { id: button2Id, title: button2Title },
          },
        ],
      },
    },
  };
  try {
    await axios.post(`${WHATSAPP_API_URL}/${PHONE_NUMBER_ID}/messages`, buttonMessage, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    });
  } catch (error) {
    console.error("Erro ao enviar botões:", error?.response?.data || error.message);
  }
}

async function sendInteractiveListMessage(to) {
  const listMessage = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      header: {
        type: "text",
        text: "🚍 Olá! Bem-vindo(a) ao nosso Sistema de Autoatendimento!",
      },
      body: {
        text: "Em que podemos ajudar hoje? Selecione uma das opções abaixo para continuar:",
      },
      footer: {
        text: "Atendimento Automatizado",
      },
      action: {
        button: "Ver Opções",
        sections: [
          {
            title: "Opções de Atendimento",
            rows: [
              {
                id: "option_1",
                title: "1️⃣ Pais e Alunos",
                description: "Informações exclusivas para Pais/Responsáveis",
              },
              {
                id: "option_2",
                title: "2️⃣ Servidores SEMED",
                description: "Informações para Servidores da SEMED",
              },
              {
                id: "option_3",
                title: "3️⃣ Servidores Escola",
                description: "Informações para Equipe da Escola",
              },
              {
                id: "option_4",
                title: "4️⃣ Fornecedores",
                description: "Solicitações e Informações para Fornecedores",
              },
              {
                id: "option_5",
                title: "5️⃣ Motoristas",
                description: "Solicitações e Informações para Motoristas",
              },
              {
                id: "option_6",
                title: "6️⃣ Encerrar Atendimento",
                description: "Finalizar o atendimento",
              },
            ],
          },
        ],
      },
    },
  };
  try {
    await axios.post(`${WHATSAPP_API_URL}/${PHONE_NUMBER_ID}/messages`, listMessage, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    });
  } catch (error) {
    console.error("Erro ao enviar menu principal:", error?.response?.data || error.message);
  }
}

async function sendParentsMenu(to) {
  const submenuMessage = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      header: {
        type: "text",
        text: "👨‍👩‍👧 Pais e Responsáveis",
      },
      body: {
        text: "Olá! Por favor, selecione uma opção abaixo para continuar:",
      },
      footer: {
        text: "Como podemos ajudar?",
      },
      action: {
        button: "Ver Opções",
        sections: [
          {
            title: "Opções Disponíveis",
            rows: [
              {
                id: "parents_option_1",
                title: "1️⃣ Ponto de Parada",
                description: "Encontre o ponto de parada mais próximo",
              },
              {
                id: "parents_option_2",
                title: "2️⃣ Concessão Rota",
                description: "Inicie a solicitação de transporte escolar",
              },
              {
                id: "parents_option_3",
                title: "3️⃣ Fazer Informe",
                description: "Registre sua denúncia, elogio ou sugestão",
              },
              {
                id: "parents_option_4",
                title: "4️⃣ Atendente",
                description: "Converse com um atendente humano",
              },
              {
                id: "parents_option_5",
                title: "5️⃣ Voltar",
                description: "Retornar ao menu principal",
              },
              {
                id: "parents_option_6",
                title: "6️⃣ Encerrar",
                description: "Finalizar o atendimento",
              },
            ],
          },
        ],
      },
    },
  };

  try {
    await axios.post(`${WHATSAPP_API_URL}/${PHONE_NUMBER_ID}/messages`, submenuMessage, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    });
  } catch (error) {
    console.error("Erro ao enviar submenu Pais/Responsáveis:", error?.response?.data || error.message);
  }
}

async function sendSemedServersMenu(to) {
  const submenuMessage = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: "👩‍🏫 Servidores SEMED" },
      body: {
        text: "Selecione a opção que melhor atende sua necessidade:",
      },
      footer: {
        text: "Como podemos ajudar?",
      },
      action: {
        button: "Ver Opções",
        sections: [
          {
            title: "Necessidades",
            rows: [
              {
                id: "request_driver",
                title: "1️⃣ Solicitar Motorista",
                description: "Abra um chamado de transporte",
              },
              {
                id: "speak_to_agent",
                title: "2️⃣ Falar com Atendente",
                description: "Converse com um atendente humano",
              },
              {
                id: "end_service",
                title: "3️⃣ Encerrar Chamado",
                description: "Finalizar o atendimento",
              },
              {
                id: "back_to_menu",
                title: "4️⃣ Menu Anterior",
                description: "Retornar ao menu principal",
              },
            ],
          },
        ],
      },
    },
  };
  try {
    await axios.post(`${WHATSAPP_API_URL}/${PHONE_NUMBER_ID}/messages`, submenuMessage, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    });
  } catch (error) {
    console.error("Erro ao enviar submenu SEMED:", error?.response?.data || error.message);
  }
}

async function sendSchoolServersMenu(to) {
  const schoolMenu = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: "🏫 Servidores da Escola" },
      body: {
        text: "Selecione a opção desejada para continuar:",
      },
      footer: {
        text: "Como podemos ajudar?",
      },
      action: {
        button: "Ver Opções",
        sections: [
          {
            title: "Funções Disponíveis",
            rows: [
              {
                id: "school_option_1",
                title: "1️⃣ Solicitar Carro",
                description: "Precisa de um carro para a escola?",
              },
              {
                id: "school_option_2",
                title: "2️⃣ Enviar Informe",
                description: "Registre Elogios, Reclamações ou Feedback",
              },
              {
                id: "school_option_3",
                title: "3️⃣ Atendente",
                description: "Falar com atendente humano (adm)",
              },
              {
                id: "school_option_5",
                title: "4️⃣ Encerrar",
                description: "Finalizar o atendimento",
              },
            ],
          },
        ],
      },
    },
  };
  try {
    await axios.post(`${WHATSAPP_API_URL}/${PHONE_NUMBER_ID}/messages`, schoolMenu, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    });
  } catch (error) {
    console.error("Erro ao enviar submenu Servidores Escola:", error?.response?.data || error.message);
  }
}

module.exports = {
  sendTextMessage,
  sendInteractiveMessageWithButtons,
  sendInteractiveListMessage,
  sendParentsMenu,
  sendSemedServersMenu,
  sendSchoolServersMenu,
};
