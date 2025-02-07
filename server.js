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
// Estado e timers de cada usuário
// -----------------------------------------------------
let userState = {};
let userTimers = {};
const TIMEOUT_DURATION = 10 * 60 * 1000; // 10 minutos

// -----------------------------------------------------
// Contato para notificação (Operador / Responsável)
// -----------------------------------------------------
const OPERATOR_NUMBER = "5594992204653"; // Ajuste para o número desejado (sem +)

// -----------------------------------------------------
// Servidor Express
// -----------------------------------------------------
const app = express();
app.use(express.json());

// -----------------------------------------------------
// Verificação do Webhook (Facebook/WhatsApp)
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
      console.error("Número do remetente não encontrado!");
      return res.sendStatus(400);
    }

    // Zera/define o timer de inatividade
    if (userTimers[senderNumber]) clearTimeout(userTimers[senderNumber]);
    const setInactivityTimeout = () => {
      userTimers[senderNumber] = setTimeout(async () => {
        await endConversation(
          senderNumber,
          "Percebemos que você está ocupado(a). Se precisar de mais ajuda, é só nos chamar a qualquer momento."
        );
      }, TIMEOUT_DURATION);
    };

    // Se já existir um fluxo em andamento
    if (userState[senderNumber] && userState[senderNumber].step) {
      switch (userState[senderNumber].step) {
        // -------------------------------------------------
        // FLUXO SOLICITAÇÃO DE ROTA (PAIS/ALUNOS)
        // -------------------------------------------------
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
              await endConversation(
                senderNumber,
                "Você não concordou com os termos. Atendimento encerrado."
              );
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
            "Por favor, insira o nome da sua rua e o bairro (Ex: 'Rua X, Bairro Y'):"
          );
          break;

        case "endereco":
          userState[senderNumber].endereco = text;
          userState[senderNumber].step = "localizacao_atual";
          await sendTextMessage(
            senderNumber,
            "Por favor, compartilhe a localização atual da residência do aluno (latitude/longitude):"
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
              "Você não enviou uma localização válida. Por favor, compartilhe sua localização atual novamente."
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
              await endConversation(
                senderNumber,
                "ID de matrícula ou CPF do aluno não encontrado. Encerrando atendimento."
              );
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
            const zoneInfo = await getZoneInfo(
              userState[senderNumber].latitude,
              userState[senderNumber].longitude
            );
            userState[senderNumber].zoneamento = false;

            if (zoneInfo.inZone) {
              userState[senderNumber].zoneamento = true;
              await sendTextMessage(
                senderNumber,
                "Localização dentro de um zoneamento cadastrado."
              );
              const escolaID = userState[senderNumber].escola_id;
              const zoneSchoolRelation = await checkZoneSchool(
                escolaID,
                zoneInfo.zoneId
              );
              if (zoneSchoolRelation) {
                await sendTextMessage(
                  senderNumber,
                  "Esse zoneamento está atribuído à mesma escola do aluno."
                );
              } else {
                await sendTextMessage(
                  senderNumber,
                  "Esse zoneamento não está diretamente vinculado à escola do aluno. Prosseguiremos com a solicitação."
                );
                userState[senderNumber].zoneamento = false;
              }
            } else {
              await sendTextMessage(
                senderNumber,
                "Localização fora dos zoneamentos conhecidos. Vamos prosseguir."
              );
              userState[senderNumber].zoneamento = false;
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
          await endConversation(
            senderNumber,
            "Solicitação de rota enviada com sucesso! Se precisar de mais ajuda futuramente, estamos à disposição. Conversa encerrada."
          );
          break;

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

        // -------------------------------------------------
        // FLUXO DE SOLICITAR MOTORISTA (SERVIDORES SEMED)
        // -------------------------------------------------
        case "driver_name":
          userState[senderNumber].driver_name = text;
          userState[senderNumber].step = "driver_setor";
          await sendTextMessage(
            senderNumber,
            "Informe seu setor/departamento (Ex: Gabinete, RH, etc.):"
          );
          break;

        case "driver_setor":
          userState[senderNumber].driver_setor = text;
          userState[senderNumber].step = "driver_qtd";
          await sendTextMessage(
            senderNumber,
            "Quantas pessoas irão nesse transporte?"
          );
          break;

        case "driver_qtd":
          userState[senderNumber].driver_qtd = text;
          userState[senderNumber].step = "driver_destino";
          await sendTextMessage(senderNumber, "Qual o destino da viagem?");
          break;

        case "driver_destino":
          userState[senderNumber].driver_destino = text;
          userState[senderNumber].step = "driver_local_origem";
          await sendTextMessage(
            senderNumber,
            "Por favor, compartilhe a localização de origem (onde o motorista deve buscar):"
          );
          break;

        case "driver_local_origem":
          if (location) {
            userState[senderNumber].driver_lat_origem = location.latitude;
            userState[senderNumber].driver_lng_origem = location.longitude;
            userState[senderNumber].step = "driver_carga_await";
            await sendInteractiveMessageWithButtons(
              senderNumber,
              "Há alguma carga que exija carro com carroceria?",
              "",
              "Sim",
              "driver_has_carga_yes",
              "Não",
              "driver_has_carga_no"
            );
          } else {
            await sendTextMessage(
              senderNumber,
              "Você não enviou uma localização válida. Por favor, compartilhe a localização de origem novamente."
            );
          }
          break;

        case "driver_carga_await":
          if (message.interactive && message.interactive.button_reply) {
            const cargaResp = message.interactive.button_reply.id;
            if (cargaResp === "driver_has_carga_yes") {
              userState[senderNumber].driver_has_carga = true;
              userState[senderNumber].driver_car_needed = "caminhonete";
              userState[senderNumber].step = "driver_hora_necessidade";
              await sendTextMessage(
                senderNumber,
                "Entendido. Precisaremos de um veículo com carroceria. Qual o horário de necessidade do carro (Ex: 08:00)?"
              );
            } else if (cargaResp === "driver_has_carga_no") {
              userState[senderNumber].driver_has_carga = false;
              userState[senderNumber].driver_car_needed = "qualquer";
              userState[senderNumber].step = "driver_hora_necessidade";
              await sendTextMessage(
                senderNumber,
                "Ótimo, qualquer carro disponível serve. Qual o horário de necessidade do carro (Ex: 08:00)?"
              );
            }
          }
          break;

        case "driver_hora_necessidade":
          userState[senderNumber].driver_hora_necessidade = text;
          userState[senderNumber].step = "driver_observacoes";
          await sendTextMessage(
            senderNumber,
            "Alguma observação extra? (ou digite 'nenhuma')"
          );
          break;

        case "driver_observacoes":
          userState[senderNumber].driver_observacoes =
            text.toLowerCase() === "nenhuma" ? "" : text;
          await saveDriverRequest(senderNumber);
          await sendTextMessage(
            senderNumber,
            "Solicitação enviada! O motorista só poderá aguardar 15 minutos na zona urbana e 2 horas na zona rural."
          );
          await endConversation(
            senderNumber,
            "Solicitação de motorista registrada. Agradecemos o contato!"
          );
          break;

        default:
          await sendInteractiveListMessage(senderNumber);
      }
      setInactivityTimeout();
    }

    // Se for list_reply
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

        // Submenu: Servidores Escola (5 opções)
        case "option_3":
          await sendSchoolServersMenu(senderNumber);
          break;

        case "request_driver":
          userState[senderNumber] = { step: "driver_name" };
          await sendTextMessage(
            senderNumber,
            "Para solicitar um motorista, digite seu nome completo:"
          );
          break;

        case "back_to_menu":
          await sendInteractiveListMessage(senderNumber);
          break;

        case "end_service":
          await endConversation(
            senderNumber,
            "Atendimento encerrado. Precisando de algo, é só chamar!"
          );
          break;

        default:
          await sendInteractiveListMessage(senderNumber);
      }
      setInactivityTimeout();
    }

    // Se for button_reply
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
        await endConversation(
          senderNumber,
          "Tudo bem! Se precisar de mais ajuda, é só enviar mensagem."
        );
      }
      setInactivityTimeout();
    }

    // Se userState é "awaiting_aluno_id_or_cpf"
    else if (userState[senderNumber] === "awaiting_aluno_id_or_cpf") {
      const aluno = await findStudentByIdOrCpf(text);
      if (aluno) {
        userState[senderNumber] = { aluno };
        const infoTransporte = aluno.transporte_escolar_poder_publico
          ? aluno.transporte_escolar_poder_publico
          : "Não informado (provavelmente não usuário)";
        const alunoInfo = `*Dados do Aluno Encontrado*:
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
        await endConversation(
          senderNumber,
          "ID de matrícula ou CPF não encontrado. Atendimento encerrado."
        );
      }
      setInactivityTimeout();
    }

    // Se não houver fluxo
    else {
      await sendInteractiveListMessage(senderNumber);
      setInactivityTimeout();
    }
  }

  res.sendStatus(200);
});

// -----------------------------------------------------
//             FUNÇÕES DE BANCO E LÓGICA
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
      celular_responsavel,
      cep,
      numero,
      endereco,
      latitude,
      longitude,
      id_matricula_aluno,
      escola_id,
      deficiencia,
      laudo_deficiencia_path,
      comprovante_residencia_path,
      zoneamento,
      observacoes,
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
    console.log("Solicitação de rota salva na tabela cocessao_rota!");

    // Notificar operador
    const notifyMsg = `🚌 *Nova solicitação de ROTA!* 🚌
**Responsável:** ${nome_responsavel}
**CPF:** ${cpf_responsavel}
**Endereço:** ${endereco}, CEP: ${cep}
Observações: ${observacoes || "Nenhuma"} 
(_Outros detalhes no sistema_);
`;
    await sendTextMessage(OPERATOR_NUMBER, notifyMsg);
  } catch (error) {
    console.error("Erro ao salvar a solicitação de rota:", error);
  }
}

async function saveDriverRequest(senderNumber) {
  try {
    const {
      driver_name,
      driver_setor,
      driver_qtd,
      driver_destino,
      driver_lat_origem,
      driver_lng_origem,
      driver_has_carga,
      driver_car_needed,
      driver_hora_necessidade,
      driver_observacoes,
    } = userState[senderNumber];

    const client = await pool.connect();
    const insertQuery = `
      INSERT INTO solicitacao_carros_administrativos (
        nome_requerente,
        setor_requerente,
        qtd_pessoas,
        destino,
        lat_origem,
        lng_origem,
        has_carga,
        tipo_carro_necessario,
        hora_necessidade,
        observacoes
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `;
    const values = [
      driver_name,
      driver_setor,
      driver_qtd,
      driver_destino,
      driver_lat_origem,
      driver_lng_origem,
      driver_has_carga,
      driver_car_needed,
      driver_hora_necessidade,
      driver_observacoes || null,
    ];
    await client.query(insertQuery, values);
    client.release();
    console.log(
      "Solicitação de motorista salva na tabela solicitacao_carros_administrativos!"
    );

    // Mensagem customizada para operador, com emojis e negrito
    const cargoStr = driver_has_carga
      ? "Sim (caminhonete necessária)"
      : "Não (qualquer carro)";
    const notifyMsg = `🚨 *NOVA SOLICITAÇÃO DE MOTORISTA!* 🚨

*Requerente:* ${driver_name}
*Setor:* ${driver_setor}
*Quantidade de pessoas:* ${driver_qtd}
*Destino:* ${driver_destino}
*Horário:* ${driver_hora_necessidade}
*Carga Especial:* ${cargoStr}
*Observações:* ${driver_observacoes || "Nenhuma"}

Por favor, verifique e providencie um motorista.`;
    await sendTextMessage(OPERATOR_NUMBER, notifyMsg);
  } catch (error) {
    console.error("Erro ao salvar a solicitação de motorista:", error);
  }
}

// -----------------------------------------------------
// Zoneamento e verificação de rotas
// -----------------------------------------------------
async function getZoneInfo(latitude, longitude) {
  const resultObj = { inZone: false, zoneId: null };
  if (!latitude || !longitude) return resultObj;
  try {
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
    if (result.rows.length > 0) {
      resultObj.inZone = true;
      resultObj.zoneId = result.rows[0].id;
    }
    return resultObj;
  } catch (error) {
    console.error("Erro ao verificar zoneamento:", error);
    return resultObj;
  }
}

async function checkZoneSchool(escolaId, zoneId) {
  if (!escolaId || !zoneId) return false;
  try {
    const client = await pool.connect();
    const query = `
      SELECT id
      FROM escolas_zoneamentos
      WHERE escola_id = $1
        AND zoneamento_id = $2
      LIMIT 1
    `;
    const result = await client.query(query, [escolaId, zoneId]);
    client.release();
    return result.rows.length > 0;
  } catch (error) {
    console.error("Erro ao verificar relação escola_zoneamento:", error);
    return false;
  }
}

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
    return result.rows;
  } catch (error) {
    console.error("Erro ao buscar pontos das rotas:", error);
    return [];
  }
}

// -----------------------------------------------------
// Encerrar conversa
// -----------------------------------------------------
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

// -----------------------------------------------------
// MENSAGENS INTERATIVAS (Menu Principal etc.)
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
      body: { text: "Selecione uma das opções abaixo para continuar:" },
      footer: { text: "Atendimento Automatizado" },
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
      header: { type: "text", text: "👩‍🏫 Servidores SEMED" },
      body: { text: "Selecione a opção desejada:" },
      footer: { text: "Como podemos ajudar?" },
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
                id: "speak_to_agent",
                title: "2️⃣ Falar com Atendente",
                description: "Conversar com um atendente",
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

// -----------------------------------------------------
// SUBMENU ATUALIZADO: Servidores Escola (5 opções)
// -----------------------------------------------------
async function sendSchoolServersMenu(to) {
  const schoolMenu = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: "🏫 Servidores Escola" },
      body: {
        text: "Selecione uma das 5 opções abaixo para continuar:",
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
                description: "Elogios, Reclamações, Feedback, etc.",
              },
              {
                id: "school_option_3",
                title: "3️⃣ Status de Rotas",
                description: "Consulte a situação das rotas ativas.",
              },
              {
                id: "school_option_4",
                title: "4️⃣ Agenda Veículos",
                description: "Ver disponibilidade e horários.",
              },
              {
                id: "school_option_5",
                title: "5️⃣ Encerrar",
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
      schoolMenu,
      {
        headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
      }
    );
  } catch (error) {
    console.error(
      "Erro ao enviar submenu Servidores Escola:",
      error?.response?.data || error.message
    );
  }
}

/**
 * Envia texto simples via WhatsApp
 */
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
      "Erro ao enviar texto:",
      error?.response?.data || error.message
    );
  }
}

/**
 * Envia botões interativos
 */
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
    await axios.post(
      `${WHATSAPP_API_URL}/${PHONE_NUMBER_ID}/messages`,
      buttonMessage,
      {
        headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
      }
    );
  } catch (error) {
    console.error(
      "Erro ao enviar botões:",
      error?.response?.data || error.message
    );
  }
}

// Inicia o servidor
app.listen(BOT_PORT, () => {
  console.log(`BOT rodando na porta ${BOT_PORT}...`);
});
