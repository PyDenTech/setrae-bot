require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { Pool } = require("pg");

// -----------------------------------------------------
// Configurações de ambiente (ajuste conforme seu .env)
// -----------------------------------------------------
const WHATSAPP_API_URL = "https://graph.facebook.com/v20.0";
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const BOT_PORT = process.env.BOT_PORT || 3000;

// -----------------------------------------------------
// Conexão com o banco de dados (Postgres / PostGIS)
// (Certifique-se de ter:
//  ALTER TABLE cocessao_rota ADD COLUMN comprovante_residencia_path TEXT;
// )
// -----------------------------------------------------
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

// -----------------------------------------------------
// Variáveis de estado do usuário no BOT
// -----------------------------------------------------
let userState = {};
let userTimers = {};
const TIMEOUT_DURATION = 10 * 60 * 1000; // 10 minutos

// -----------------------------------------------------
// Servidor Express do BOT
// -----------------------------------------------------
const app = express();
app.use(express.json());

// -----------------------------------------------------
// Webhook de verificação (Facebook/WhatsApp)
// -----------------------------------------------------
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verificado com sucesso!");
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// -----------------------------------------------------
// Webhook principal: recebe mensagens do WhatsApp
// -----------------------------------------------------
app.post("/webhook", async (req, res) => {
  const data = req.body;

  if (
    data.object &&
    data.entry &&
    data.entry[0].changes &&
    data.entry[0].changes[0].value.messages
  ) {
    const message = data.entry[0].changes[0].value.messages[0];
    const senderNumber = message.from;
    const text = message.text ? message.text.body : "";
    const location = message.location || null;
    const media = message.image || message.document || null;

    if (!senderNumber) {
      console.error("Número do remetente não encontrado na mensagem!");
      return res.sendStatus(400);
    }

    if (userTimers[senderNumber]) clearTimeout(userTimers[senderNumber]);
    const setInactivityTimeout = () => {
      userTimers[senderNumber] = setTimeout(async () => {
        await sendTextMessage(
          senderNumber,
          "Percebemos que você está ocupado(a). Se precisar de mais ajuda, é só nos chamar a qualquer momento."
        );
        delete userState[senderNumber];
        delete userTimers[senderNumber];
      }, TIMEOUT_DURATION);
    };

    // -------------------------------------------------
    // FLUXO PRINCIPAL VIA userState[senderNumber].step
    // -------------------------------------------------
    if (userState[senderNumber] && userState[senderNumber].step) {
      switch (userState[senderNumber].step) {
        case "termos_uso":
          if (message.interactive && message.interactive.button_reply) {
            const resp = message.interactive.button_reply.id;
            if (resp === "aceito_termos") {
              userState[senderNumber].step = "nome_responsavel";
              await sendTextMessage(
                senderNumber,
                "Ótimo! Por favor, insira o nome completo do responsável pela solicitação:"
              );
            } else {
              await sendTextMessage(
                senderNumber,
                "Você não concordou com os termos. Atendimento encerrado."
              );
              delete userState[senderNumber];
            }
          }
          break;

        case "nome_responsavel":
          userState[senderNumber].nome_responsavel = text;
          userState[senderNumber].step = "cpf_responsavel";
          await sendTextMessage(senderNumber, "Por favor, insira o CPF do responsável:");
          break;

        case "cpf_responsavel":
          userState[senderNumber].cpf_responsavel = text;
          userState[senderNumber].step = "cep";
          await sendTextMessage(senderNumber, "Por favor, insira o CEP:");
          break;

        case "cep":
          userState[senderNumber].cep = text;
          userState[senderNumber].step = "numero";
          await sendTextMessage(senderNumber, "Por favor, insira o número da residência:");
          break;

        case "numero":
          userState[senderNumber].numero = text;
          userState[senderNumber].step = "endereco";
          await sendTextMessage(senderNumber, "Por favor, insira o endereço completo:");
          break;

        case "endereco":
          userState[senderNumber].endereco = text;
          userState[senderNumber].step = "localizacao_atual";
          await sendTextMessage(
            senderNumber,
            "Por favor, compartilhe a sua localização atual (para capturarmos latitude e longitude):"
          );
          break;

        case "localizacao_atual":
          if (location) {
            userState[senderNumber].latitude = location.latitude;
            userState[senderNumber].longitude = location.longitude;
            userState[senderNumber].step = "comprovante_residencia";
            await sendTextMessage(
              senderNumber,
              "Agora, envie uma foto ou PDF do seu comprovante de residência:"
            );
          } else {
            await sendTextMessage(
              senderNumber,
              "Você não enviou uma localização válida. Por favor, compartilhe sua localização atual."
            );
          }
          break;

        case "comprovante_residencia":
          if (media) {
            userState[senderNumber].comprovante_residencia_path = media.id;
            userState[senderNumber].step = "id_matricula_aluno";
            await sendTextMessage(
              senderNumber,
              "Comprovante recebido! Por favor, insira o ID de matrícula ou CPF do aluno (somente números):"
            );
          } else {
            await sendTextMessage(
              senderNumber,
              "Por favor, envie um documento ou imagem válido do comprovante de residência."
            );
          }
          break;

        case "id_matricula_aluno":
          userState[senderNumber].id_matricula_aluno = text;
          const alunoData = await findStudentByIdOrCpf(text);
          if (alunoData) {
            userState[senderNumber].escola_id = alunoData.escola_id;
            userState[senderNumber].step = "deficiencia";
            await sendTextMessage(
              senderNumber,
              `Aluno encontrado! Nome: ${alunoData.pessoa_nome}. Ele possui alguma deficiência? Responda "Sim" ou "Não".`
            );
          } else {
            await sendTextMessage(
              senderNumber,
              "ID de matrícula ou CPF do aluno não encontrado. Verifique e tente novamente."
            );
            delete userState[senderNumber];
          }
          break;

        case "deficiencia":
          if (text.toLowerCase() === "sim") {
            userState[senderNumber].deficiencia = true;
            userState[senderNumber].step = "laudo_deficiencia";
            await sendTextMessage(
              senderNumber,
              "Por favor, envie o laudo médico que comprove a deficiência (imagem ou PDF)."
            );
          } else {
            userState[senderNumber].deficiencia = false;
            userState[senderNumber].laudo_deficiencia_path = null;
            userState[senderNumber].step = "celular_responsavel";
            await sendTextMessage(senderNumber, "Agora, informe o telefone do responsável:");
          }
          break;

        case "laudo_deficiencia":
          if (media) {
            userState[senderNumber].laudo_deficiencia_path = media.id;
            userState[senderNumber].step = "celular_responsavel";
            await sendTextMessage(
              senderNumber,
              "Laudo médico recebido! Agora, informe o telefone do responsável:"
            );
          } else {
            await sendTextMessage(
              senderNumber,
              "Por favor, envie um documento ou imagem válido do laudo médico."
            );
          }
          break;

        case "celular_responsavel":
          userState[senderNumber].celular_responsavel = text;
          userState[senderNumber].step = "zoneamento";
          const isInsideZone = await checkIfInsideAnyZone(
            userState[senderNumber].latitude,
            userState[senderNumber].longitude
          );
          userState[senderNumber].zoneamento = isInsideZone;
          if (isInsideZone) {
            await sendTextMessage(
              senderNumber,
              "Localização dentro de um zoneamento cadastrado."
            );
          } else {
            await sendTextMessage(
              senderNumber,
              "Localização fora dos zoneamentos conhecidos. Vamos prosseguir."
            );
          }
          userState[senderNumber].step = "observacoes";
          await sendTextMessage(
            senderNumber,
            'Insira observações adicionais (ou "nenhuma" se não tiver):'
          );
          break;

        case "observacoes":
          userState[senderNumber].observacoes =
            text.toLowerCase() === "nenhuma" ? "" : text;
          await saveRouteRequest(senderNumber);
          await sendTextMessage(
            senderNumber,
            "Solicitação de rota enviada com sucesso! Em breve entraremos em contato."
          );
          delete userState[senderNumber];
          break;

        default:
          await sendInteractiveListMessage(senderNumber);
      }
      setInactivityTimeout();
    }

    // -------------------------------------------------
    // MENSAGENS INTERATIVAS (LIST_REPLY)
    // -------------------------------------------------
    else if (message.interactive && message.interactive.list_reply) {
      const selectedOption = message.interactive.list_reply.id;
      switch (selectedOption) {
        case "option_1":
          userState[senderNumber] = "awaiting_aluno_id_or_cpf";
          await sendTextMessage(
            senderNumber,
            "Por favor, insira o ID de matrícula ou CPF do aluno:"
          );
          break;

        case "option_2":
          await sendSemedServersMenu(senderNumber);
          break;

        case "back_to_menu":
          await sendInteractiveListMessage(senderNumber);
          break;

        case "end_service":
          await sendTextMessage(
            senderNumber,
            "Atendimento encerrado. Precisando de algo, é só chamar!"
          );
          delete userState[senderNumber];
          break;

        default:
          await sendInteractiveListMessage(senderNumber);
      }
      setInactivityTimeout();
    }

    // -------------------------------------------------
    // MENSAGENS INTERATIVAS (BUTTON_REPLY)
    // -------------------------------------------------
    else if (message.interactive && message.interactive.button_reply) {
      const buttonResponse = message.interactive.button_reply.id;
      if (buttonResponse === "confirm_yes") {
        await checkStudentTransport(senderNumber);
      } else if (buttonResponse === "confirm_no") {
        await sendTextMessage(
          senderNumber,
          "Por favor, verifique o ID de matrícula ou CPF e tente novamente."
        );
        userState[senderNumber] = "awaiting_aluno_id_or_cpf";
      } else if (buttonResponse === "request_transport_yes") {
        userState[senderNumber] = { step: "termos_uso" };
        await sendTextMessage(
          senderNumber,
          "Para utilizar o transporte escolar, é necessário atender aos critérios de distância mínima, idade mínima e demais normas. Você concorda com estes termos?"
        );
        await sendInteractiveMessageWithButtons(
          senderNumber,
          "Confirma a aceitação dos termos de uso do transporte?",
          "",
          "Sim",
          "aceito_termos",
          "Não",
          "recuso_termos"
        );
      } else if (buttonResponse === "request_transport_no") {
        await sendTextMessage(
          senderNumber,
          "Tudo bem! Se precisar de mais ajuda, é só enviar mensagem."
        );
        delete userState[senderNumber];
      }
      setInactivityTimeout();
    }

    // -------------------------------------------------
    // ESTADO "awaiting_aluno_id_or_cpf"
    // -------------------------------------------------
    else if (userState[senderNumber] === "awaiting_aluno_id_or_cpf") {
      const aluno = await findStudentByIdOrCpf(text);
      if (aluno) {
        userState[senderNumber] = { aluno };
        const infoTransporte = aluno.transporte_escolar_poder_publico
          ? aluno.transporte_escolar_poder_publico
          : "Não informado (provavelmente não usuário)";
        const alunoInfo = `
*Dados do Aluno Encontrado*:
Nome: ${aluno.pessoa_nome}
CPF: ${aluno.cpf || "Não informado"}
Escola: ${aluno.nome_escola || "Não vinculada"}
Matrícula: ${aluno.id_matricula || "N/A"}
Transporte Público: ${infoTransporte}
        `;
        await sendInteractiveMessageWithButtons(
          senderNumber,
          alunoInfo,
          "Essas informações estão corretas?",
          "Sim",
          "confirm_yes",
          "Não",
          "confirm_no"
        );
      } else {
        await sendTextMessage(
          senderNumber,
          "ID de matrícula ou CPF não encontrado. Verifique e tente novamente."
        );
      }
      setInactivityTimeout();
    }

    // -------------------------------------------------
    // SE NENHUMA OUTRA CONDIÇÃO
    // -------------------------------------------------
    else {
      await sendInteractiveListMessage(senderNumber);
      setInactivityTimeout();
    }
  }

  res.sendStatus(200);
});

// -----------------------------------------------------
// FUNÇÕES DE BANCO E LÓGICA
// -----------------------------------------------------
async function findStudentByIdOrCpf(idOrCpf) {
  try {
    const client = await pool.connect();
    const query = `
      SELECT a.*, e.nome AS nome_escola
      FROM alunos_ativos a
      LEFT JOIN escolas e ON a.escola_id = e.id
      WHERE CAST(a.id_matricula AS TEXT) = $1
         OR a.cpf = $1
      LIMIT 1
    `;
    const result = await client.query(query, [idOrCpf]);
    client.release();
    return result.rows.length > 0 ? result.rows[0] : null;
  } catch (error) {
    console.error("Erro ao buscar aluno em alunos_ativos:", error);
    return null;
  }
}

async function saveRouteRequest(senderNumber) {
  try {
    const {
      nome_responsavel,
      cpf_responsavel,
      cep,
      numero,
      endereco,
      latitude,
      longitude,
      id_matricula_aluno,
      deficiencia,
      laudo_deficiencia_path,
      escola_id,
      celular_responsavel,
      zoneamento,
      observacoes,
      comprovante_residencia_path,
    } = userState[senderNumber];

    const client = await pool.connect();
    const insertQuery = `
      INSERT INTO cocessao_rota (
        nome_responsavel,
        cpf_responsavel,
        celular_responsavel,
        id_matricula_aluno,
        escola_id,
        cep,
        numero,
        endereco,
        zoneamento,
        deficiencia,
        laudo_deficiencia_path,
        comprovante_residencia_path,
        latitude,
        longitude,
        observacoes
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
    `;
    const values = [
      nome_responsavel,
      cpf_responsavel,
      celular_responsavel,
      id_matricula_aluno,
      escola_id,
      cep,
      numero,
      endereco,
      zoneamento,
      deficiencia,
      laudo_deficiencia_path || null,
      comprovante_residencia_path || null,
      latitude,
      longitude,
      observacoes || null,
    ];
    await client.query(insertQuery, values);
    client.release();
    console.log("Solicitação de rota salva com sucesso na tabela cocessao_rota!");
  } catch (error) {
    console.error("Erro ao salvar a solicitação de rota:", error);
  }
}

async function checkStudentTransport(to) {
  const aluno = userState[to] ? userState[to].aluno : null;
  if (!aluno) {
    await sendTextMessage(to, "Não encontramos dados do aluno. Por favor, tente novamente.");
    return;
  }
  if (aluno.transporte_escolar_poder_publico) {
    const coordinates = await getCoordinatesFromAddress(aluno.bairro || aluno.endereco || "");
    if (coordinates) {
      const nearestStop = await getNearestStop(coordinates);
      if (nearestStop) {
        if (coordinates.lat && coordinates.lng && nearestStop.latitude && nearestStop.longitude) {
          const directionsUrl = `https://www.google.com/maps/dir/?api=1&origin=${coordinates.lat},${coordinates.lng}&destination=${nearestStop.latitude},${nearestStop.longitude}&travelmode=walking`;
          await sendTextMessage(
            to,
            `O ponto de parada mais próximo é "${nearestStop.nome_ponto}".\nCoordenadas: ${nearestStop.latitude}, ${nearestStop.longitude}.\n[Traçar Rota no Google Maps](${directionsUrl})`
          );
        } else {
          await sendTextMessage(to, "Não foi possível gerar a rota (coordenadas inválidas).");
        }
      } else {
        await sendTextMessage(to, "Não encontramos um ponto de parada próximo ao endereço cadastrado.");
      }
    } else {
      userState[to].step = "enviar_localizacao";
      await sendTextMessage(
        to,
        "Não foi possível identificar suas coordenadas pelo endereço. Por favor, envie sua localização atual."
      );
    }
  } else {
    await sendInteractiveMessageWithButtons(
      to,
      "O aluno não é usuário do transporte público. Deseja solicitar?",
      "",
      "Sim",
      "request_transport_yes",
      "Não",
      "request_transport_no"
    );
  }
}

async function checkIfInsideAnyZone(latitude, longitude) {
  try {
    if (!latitude || !longitude) return false;
    const client = await pool.connect();
    const query = `
      SELECT id
      FROM zoneamentos
      WHERE ST_Contains(
        geom,
        ST_SetSRID(ST_Point($1, $2), 4326)
      )
      LIMIT 1
    `;
    const result = await client.query(query, [longitude, latitude]);
    client.release();
    return result.rows.length > 0;
  } catch (error) {
    console.error("Erro ao verificar zoneamento:", error);
    return false;
  }
}

async function getCoordinatesFromAddress(address) {
  try {
    if (!address) return null;
    const response = await axios.get("https://maps.googleapis.com/maps/api/geocode/json", {
      params: {
        address,
        key: GOOGLE_MAPS_API_KEY,
      },
    });
    if (response.data.status === "OK") {
      const loc = response.data.results[0].geometry.location;
      return { lat: loc.lat, lng: loc.lng };
    }
    console.error("Erro no geocode (status):", response.data.status);
    return null;
  } catch (error) {
    console.error("Erro ao acessar Google Maps API:", error);
    return null;
  }
}

async function getNearestStop({ lat, lng }) {
  try {
    const client = await pool.connect();
    const result = await client.query("SELECT * FROM pontos");
    client.release();
    if (result.rows.length === 0) return null;

    let nearestStop = null;
    let minDistance = Infinity;
    for (const stop of result.rows) {
      const stopLat = parseFloat(stop.latitude);
      const stopLng = parseFloat(stop.longitude);
      if (isNaN(stopLat) || isNaN(stopLng)) continue;
      const distance = calculateDistance(lat, lng, stopLat, stopLng);
      if (distance < minDistance) {
        minDistance = distance;
        nearestStop = stop;
      }
    }
    return nearestStop;
  } catch (error) {
    console.error("Erro ao consultar pontos:", error);
    return null;
  }
}

function calculateDistance(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRad(value) {
  return (value * Math.PI) / 180;
}

// -----------------------------------------------------
// FUNÇÕES DE MENSAGEM INTERATIVA
// -----------------------------------------------------
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
        text: "🚍 Bem-vindo ao Sistema de Autoatendimento!",
      },
      body: {
        text: "Selecione uma das opções abaixo para continuar:",
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
                description: "Informações para Pais/Responsáveis",
              },
              {
                id: "option_2",
                title: "2️⃣ Servidores SEMED",
                description: "Informações para Servidores",
              },
              {
                id: "option_3",
                title: "3️⃣ Servidores Escola",
                description: "Informações para Escolas",
              },
              {
                id: "option_4",
                title: "4️⃣ Fornecedores",
                description: "Informações para Fornecedores",
              },
              {
                id: "option_5",
                title: "5️⃣ Motoristas",
                description: "Informações para Motoristas",
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

async function sendSemedServersMenu(to) {
  const submenuMessage = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      header: {
        type: "text",
        text: "👩‍🏫 Servidores SEMED",
      },
      body: {
        text: "Selecione a opção desejada:",
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
                description: "Solicitar transporte",
              },
              {
                id: "schedule_driver",
                title: "2️⃣ Agendar Motorista",
                description: "Agendar transporte futuro",
              },
              {
                id: "speak_to_agent",
                title: "3️⃣ Falar com Atendente",
                description: "Conversar com um atendente",
              },
              {
                id: "end_service",
                title: "4️⃣ Encerrar Chamado",
                description: "Finalizar o atendimento",
              },
              {
                id: "back_to_menu",
                title: "5️⃣ Menu Anterior",
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
    console.error("Erro ao enviar mensagem de texto:", error?.response?.data || error.message);
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
    console.error("Erro ao enviar botões interativos:", error?.response?.data || error.message);
  }
}

// -----------------------------------------------------
// Inicia servidor do BOT
// -----------------------------------------------------
app.listen(BOT_PORT, () => {
  console.log(`BOT rodando na porta ${BOT_PORT}...`);
});
