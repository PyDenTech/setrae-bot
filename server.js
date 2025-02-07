require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { Pool } = require("pg");

// -----------------------------------------------------
// Configurações de ambiente
// -----------------------------------------------------
const WHATSAPP_API_URL = "https://graph.facebook.com/v20.0";
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const BOT_PORT = process.env.BOT_PORT || 3000;

// -----------------------------------------------------
// Conexão com o Banco (Postgres / PostGIS)
// -----------------------------------------------------
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// -----------------------------------------------------
// Armazena estado e timers de cada usuário
// -----------------------------------------------------
let userState = {};
let userTimers = {};
const TIMEOUT_DURATION = 10 * 60 * 1000; // 10 minutos

// -----------------------------------------------------
// Criação do servidor Express
// -----------------------------------------------------
const app = express();
app.use(express.json());

// -----------------------------------------------------
// 1) Verificação do Webhook (Facebook/WhatsApp)
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
// 2) Webhook principal - recebe mensagens
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

    // Se houver timer ativo, resetamos
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

    // -----------------------------------------------
    // Lógica principal via userState[senderNumber].step
    // -----------------------------------------------
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
          await sendTextMessage(
            senderNumber,
            "Por favor, insira o CPF do responsável:"
          );
          break;

        case "cpf_responsavel":
          userState[senderNumber].cpf_responsavel = text;
          userState[senderNumber].step = "cep";
          await sendTextMessage(senderNumber, "Por favor, insira o CEP:");
          break;

        case "cep":
          userState[senderNumber].cep = text;
          userState[senderNumber].step = "numero";
          await sendTextMessage(
            senderNumber,
            "Por favor, insira o número da residência:"
          );
          break;

        case "numero":
          userState[senderNumber].numero = text;
          userState[senderNumber].step = "endereco";
          await sendTextMessage(
            senderNumber,
            "Por favor, insira o endereço completo:"
          );
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
          {
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
            await sendTextMessage(
              senderNumber,
              "Agora, informe o telefone do responsável:"
            );
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
          {
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

        // Quando pedimos localização durante checkStudentTransport
        case "enviar_localizacao":
          if (location) {
            userState[senderNumber].latitude = location.latitude;
            userState[senderNumber].longitude = location.longitude;
            await finishCheckStudentTransport(senderNumber);
          } else {
            await sendTextMessage(
              senderNumber,
              "Não foi possível identificar sua localização. Por favor, envie novamente."
            );
          }
          break;

        default:
          await sendInteractiveListMessage(senderNumber);
      }
      setInactivityTimeout();
    }

    // -----------------------------------------------
    // LIST_REPLY
    // -----------------------------------------------
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

    // -----------------------------------------------
    // BUTTON_REPLY
    // -----------------------------------------------
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

    // -----------------------------------------------
    // awaiting_aluno_id_or_cpf
    // -----------------------------------------------
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

    // -----------------------------------------------
    // Se não houver estado
    // -----------------------------------------------
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
    console.log(
      "Solicitação de rota salva com sucesso na tabela cocessao_rota!"
    );
  } catch (error) {
    console.error("Erro ao salvar a solicitação de rota:", error);
  }
}

// -----------------------------------------------------
// checkStudentTransport (fluxo do aluno usuário transporte)
// -----------------------------------------------------
async function checkStudentTransport(to) {
  const aluno = userState[to] ? userState[to].aluno : null;
  if (!aluno) {
    await sendTextMessage(
      to,
      "Não encontramos dados do aluno. Por favor, tente novamente."
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

  // Já é usuário (Municipal, Estadual, etc.)
  const schoolId = aluno.escola_id;
  if (!schoolId) {
    await sendTextMessage(
      to,
      "Não foi possível identificar a escola do aluno."
    );
    return;
  }

  const routeIds = await getRoutesBySchool(schoolId);
  if (!routeIds || routeIds.length === 0) {
    await sendTextMessage(
      to,
      "Não há rotas cadastradas para a escola do aluno. Tente novamente mais tarde."
    );
    return;
  }

  const routePoints = await getPointsByRoutes(routeIds);
  if (!routePoints || routePoints.length === 0) {
    await sendTextMessage(
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
      "Não foi possível identificar suas coordenadas. Por favor, envie sua localização atual."
    );
    return;
  }

  // Se já temos latitude/longitude, finalizamos a busca
  await finishCheckStudentTransport(to, routePoints);
}

// -----------------------------------------------------
// Função chamada após receber localização
// para finalizar a busca do ponto mais próximo
// -----------------------------------------------------
async function finishCheckStudentTransport(to, optionalPoints = null) {
  // Se routePoints não foi passado, precisamos buscar novamente
  // pois pode ter sido chamado depois do "enviar_localizacao"
  let routePoints = optionalPoints;
  const aluno = userState[to] ? userState[to].aluno : null;
  if (!aluno) {
    await sendTextMessage(
      to,
      "Não encontramos dados do aluno. Por favor, tente novamente."
    );
    return;
  }
  if (!aluno.escola_id) {
    await sendTextMessage(
      to,
      "Não foi possível identificar a escola do aluno."
    );
    return;
  }
  if (!routePoints) {
    const routeIds = await getRoutesBySchool(aluno.escola_id);
    if (!routeIds || routeIds.length === 0) {
      await sendTextMessage(
        to,
        "Não há rotas cadastradas para a escola do aluno. Tente novamente mais tarde."
      );
      return;
    }
    routePoints = await getPointsByRoutes(routeIds);
    if (!routePoints || routePoints.length === 0) {
      await sendTextMessage(
        to,
        "Não encontramos pontos de parada nessas rotas. Verifique com a secretaria."
      );
      return;
    }
  }

  const lat = userState[to].latitude;
  const lng = userState[to].longitude;
  if (!lat || !lng) {
    await sendTextMessage(
      to,
      "Não foi possível identificar suas coordenadas. Tente novamente mais tarde."
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
    await sendTextMessage(
      to,
      "Não foi possível encontrar um ponto de parada próximo. Verifique com a secretaria."
    );
  } else {
    const directionsUrl = `https://www.google.com/maps/dir/?api=1&origin=${lat},${lng}&destination=${nearestPoint.latitude},${nearestPoint.longitude}&travelmode=walking`;

    await sendTextMessage(
      to,
      `Ponto de parada mais próximo vinculado à rota da escola: *${nearestPoint.nome_ponto}*.\nCoordenadas: ${nearestPoint.latitude}, ${nearestPoint.longitude}.\n[Dica de Rota no Google Maps](${directionsUrl})`
    );
  }

  // Depois de enviar, podemos encerrar ou retornar ao menu principal
  // delete userState[to]; // Se quiser encerrar fluxo
  // Ou:
  // userState[to] = "awaiting_aluno_id_or_cpf"; // Se quiser voltar
}

// -----------------------------------------------------
// Funções auxiliares para buscar rotas/pontos no BD
// -----------------------------------------------------
async function getRoutesBySchool(escolaId) {
  try {
    const client = await pool.connect();
    const query = `
      SELECT rota_id
      FROM rotas_escolas
      WHERE escola_id = $1
    `;
    const result = await client.query(query, [escolaId]);
    client.release();
    return result.rows.map((row) => row.rota_id);
  } catch (error) {
    console.error("Erro ao buscar rotas por escola:", error);
    return [];
  }
}

async function getPointsByRoutes(routeIds) {
  try {
    if (!routeIds || routeIds.length === 0) return [];
    const client = await pool.connect();
    const query = `
      SELECT p.*
      FROM rotas_pontos rp
      JOIN pontos p ON p.id = rp.ponto_id
      WHERE rp.rota_id = ANY($1)
    `;
    const result = await client.query(query, [routeIds]);
    client.release();
    return result.rows; // Array de pontos
  } catch (error) {
    console.error("Erro ao buscar pontos das rotas:", error);
    return [];
  }
}

// -----------------------------------------------------
// Funções de Geometria
// -----------------------------------------------------
function calculateDistance(lat1, lng1, lat2, lng2) {
  const R = 6371; // Raio da Terra em km
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
// Consultar coordenadas via Google Maps
// -----------------------------------------------------
async function getCoordinatesFromAddress(address) {
  try {
    if (!address) return null;
    const response = await axios.get(
      "https://maps.googleapis.com/maps/api/geocode/json",
      {
        params: {
          address,
          key: GOOGLE_MAPS_API_KEY,
        },
      }
    );
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

// -----------------------------------------------------
// Verificar se localização está em zoneamento
// -----------------------------------------------------
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

// -----------------------------------------------------
// MENSAGENS INTERATIVAS
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
    await axios.post(
      `${WHATSAPP_API_URL}/${PHONE_NUMBER_ID}/messages`,
      listMessage,
      {
        headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
      }
    );
  } catch (error) {
    console.error(
      "Erro ao enviar menu principal:",
      error?.response?.data || error.message
    );
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
    await axios.post(
      `${WHATSAPP_API_URL}/${PHONE_NUMBER_ID}/messages`,
      submenuMessage,
      {
        headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
      }
    );
  } catch (error) {
    console.error(
      "Erro ao enviar submenu SEMED:",
      error?.response?.data || error.message
    );
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
    await axios.post(
      `${WHATSAPP_API_URL}/${PHONE_NUMBER_ID}/messages`,
      message,
      {
        headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
      }
    );
  } catch (error) {
    console.error(
      "Erro ao enviar mensagem de texto:",
      error?.response?.data || error.message
    );
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
            reply: {
              id: button1Id,
              title: button1Title,
            },
          },
          {
            type: "reply",
            reply: {
              id: button2Id,
              title: button2Title,
            },
          },
        ],
      },
    },
  };
  try {
    await axios.post(
      `${WHATSAPP_API_URL}/${PHONE_NUMBER_ID}/messages`,
      buttonMessage,
      {
        headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
      }
    );
  } catch (error) {
    console.error(
      "Erro ao enviar botões interativos:",
      error?.response?.data || error.message
    );
  }
}

// -----------------------------------------------------
// Inicializa o servidor
// -----------------------------------------------------
app.listen(BOT_PORT, () => {
  console.log(`BOT rodando na porta ${BOT_PORT}...`);
});
