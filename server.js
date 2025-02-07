/******************************************************
 * Servidor de BOT de Autoatendimento (isolado)
 ******************************************************/

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');

// -----------------------------------------------------
// Configurações de ambiente (ajuste conforme seu .env)
// -----------------------------------------------------
const WHATSAPP_API_URL = 'https://graph.facebook.com/v20.0';
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;  // Ex: postgres://user:pass@host:port/db
const BOT_PORT = process.env.BOT_PORT || 3000;  // Porta do BOT

// -----------------------------------------------------
// Conexão com o banco de dados (Postgres / PostGIS)
// -----------------------------------------------------
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// -----------------------------------------------------
// Variáveis de estado do usuário no BOT
// -----------------------------------------------------
let userState = {};   // Armazena passo a passo (dinâmico) de cada usuário
let userTimers = {};  // Controle de timeout de inatividade
const TIMEOUT_DURATION = 10 * 60 * 1000; // 10 minutos

// -----------------------------------------------------
// Criação do servidor Express específico p/ o BOT
// -----------------------------------------------------
const app = express();
app.use(express.json());

// -----------------------------------------------------
// 1) Rota de verificação do Webhook (Facebook/WhatsApp)
// -----------------------------------------------------
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verificado com sucesso!');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// -----------------------------------------------------
// 2) Rota principal do Webhook: recebe mensagens
// -----------------------------------------------------
app.post('/webhook', async (req, res) => {
  const data = req.body;

  // Verifica se é um evento válido do WhatsApp
  if (
    data.object &&
    data.entry &&
    data.entry[0].changes &&
    data.entry[0].changes[0].value.messages
  ) {
    const message = data.entry[0].changes[0].value.messages[0];
    const senderNumber = message.from;
    const text = message.text ? message.text.body : '';
    const location = message.location ? message.location : null;
    const media = message.image || message.document; // Caso chegue imagem ou documento

    if (!senderNumber) {
      console.error('Número do remetente não encontrado na mensagem!');
      return res.sendStatus(400);
    }

    // Se há timer ativo, limpa e reinicia (o usuário respondeu)
    if (userTimers[senderNumber]) {
      clearTimeout(userTimers[senderNumber]);
    }

    // Função para encerrar a conversa após 10 minutos de inatividade
    const setInactivityTimeout = () => {
      userTimers[senderNumber] = setTimeout(async () => {
        await sendTextMessage(
          senderNumber,
          'Percebemos que você está ocupado(a). Se precisar de mais ajuda, estamos à disposição. É só nos chamar a qualquer momento.'
        );
        // Limpa o estado do usuário
        delete userState[senderNumber];
        delete userTimers[senderNumber];
      }, TIMEOUT_DURATION);
    };

    // -----------------------------------------------
    // Se o usuário estiver no meio de uma conversa
    // -----------------------------------------------
    if (userState[senderNumber] && userState[senderNumber].step) {
      // Verifica o `step` em que o usuário está e processa
      switch (userState[senderNumber].step) {
        case 'nome_responsavel':
          userState[senderNumber].nome_responsavel = text;
          userState[senderNumber].step = 'cpf_responsavel';
          await sendTextMessage(senderNumber, 'Por favor, insira o CPF do responsável:');
          break;

        case 'cpf_responsavel':
          userState[senderNumber].cpf_responsavel = text;
          userState[senderNumber].step = 'cep';
          await sendTextMessage(senderNumber, 'Por favor, insira o CEP:');
          break;

        case 'cep':
          userState[senderNumber].cep = text;
          userState[senderNumber].step = 'numero';
          await sendTextMessage(senderNumber, 'Por favor, insira o número da residência:');
          break;

        case 'numero':
          userState[senderNumber].numero = text;
          userState[senderNumber].step = 'endereco';
          await sendTextMessage(senderNumber, 'Por favor, insira o endereço completo:');
          break;

        case 'endereco':
          userState[senderNumber].endereco = text;
          userState[senderNumber].step = 'localizacao_atual';
          await sendTextMessage(
            senderNumber,
            'Por favor, compartilhe a sua localização atual (para capturarmos latitude e longitude):'
          );
          break;

        case 'localizacao_atual':
          if (location) {
            userState[senderNumber].latitude = location.latitude;
            userState[senderNumber].longitude = location.longitude;
            userState[senderNumber].step = 'id_matricula_aluno';
            await sendTextMessage(
              senderNumber,
              'Por favor, insira o ID de matrícula ou CPF do aluno (apenas números):'
            );
          } else {
            await sendTextMessage(
              senderNumber,
              'Você não enviou uma localização válida. Por favor, compartilhe sua localização atual.'
            );
          }
          break;

        case 'id_matricula_aluno':
          userState[senderNumber].id_matricula_aluno = text;

          // Checa se o aluno existe no BD (Exemplo usando 'alunos_ativos')
          const alunoData = await findStudentByIdOrCpf(userState[senderNumber].id_matricula_aluno);
          if (alunoData) {
            // Se encontrou, salva a escola no estado
            userState[senderNumber].escola_id = alunoData.escola_id;
            userState[senderNumber].step = 'deficiencia';
            await sendTextMessage(
              senderNumber,
              `Aluno encontrado! Nome: ${alunoData.pessoa_nome}. Ele possui alguma deficiência? Responda "Sim" ou "Não".`
            );
          } else {
            await sendTextMessage(
              senderNumber,
              'ID de matrícula ou CPF do aluno não encontrado. Verifique os dados e tente novamente.'
            );
            delete userState[senderNumber];
          }
          break;

        case 'deficiencia':
          if (text.toLowerCase() === 'sim') {
            userState[senderNumber].deficiencia = true;
            userState[senderNumber].step = 'laudo_deficiencia';
            await sendTextMessage(
              senderNumber,
              'Por favor, envie o laudo médico que comprove a deficiência (imagem ou PDF).'
            );
          } else {
            userState[senderNumber].deficiencia = false;
            userState[senderNumber].laudo_deficiencia_path = null;
            userState[senderNumber].step = 'celular_responsavel';
            await sendTextMessage(senderNumber, 'Agora, informe o telefone do responsável:');
          }
          break;

        case 'laudo_deficiencia':
          // Aqui estamos armazenando só o ID do arquivo do WhatsApp como "path"
          // Na prática, você pode fazer o download do arquivo e guardar em S3, etc.
          if (media) {
            userState[senderNumber].laudo_deficiencia_path = media.id;
            userState[senderNumber].step = 'celular_responsavel';
            await sendTextMessage(
              senderNumber,
              'Laudo médico recebido! Agora, informe o telefone do responsável:'
            );
          } else {
            await sendTextMessage(
              senderNumber,
              'Por favor, envie um documento ou imagem válido do laudo médico.'
            );
          }
          break;

        case 'celular_responsavel':
          userState[senderNumber].celular_responsavel = text;
          userState[senderNumber].step = 'zoneamento';
          // Aqui podemos tentar fazer uma verificação do zoneamento via PostGIS:
          const isInsideZone = await checkIfInsideAnyZone(
            userState[senderNumber].latitude,
            userState[senderNumber].longitude
          );

          userState[senderNumber].zoneamento = isInsideZone;
          // Informamos ao usuário
          if (isInsideZone) {
            await sendTextMessage(
              senderNumber,
              'Localização dentro de um zoneamento cadastrado. (Bairro, Lote ou área encontrada).'
            );
          } else {
            await sendTextMessage(
              senderNumber,
              'Localização fora dos zoneamentos conhecidos. Mas vamos prosseguir.'
            );
          }

          // Próximo passo
          userState[senderNumber].step = 'observacoes';
          await sendTextMessage(
            senderNumber,
            'Insira observações adicionais (ou "nenhuma" se não tiver):'
          );
          break;

        case 'observacoes':
          userState[senderNumber].observacoes = text.toLowerCase() === 'nenhuma' ? '' : text;
          // Salva a solicitação no BD (tabela cocessao_rota)
          await saveRouteRequest(senderNumber);
          await sendTextMessage(
            senderNumber,
            'Solicitação de rota enviada com sucesso! Em breve entraremos em contato.'
          );
          delete userState[senderNumber];
          break;

        default:
          // Se for step desconhecido, volta para o menu principal
          await sendInteractiveListMessage(senderNumber);
      }
      // Reinicia o timer a cada mensagem do usuário
      setInactivityTimeout();
    }

    // -----------------------------------------------
    // Se for interativo (mensagem do tipo "list_reply")
    // -----------------------------------------------
    else if (message.interactive && message.interactive.list_reply) {
      const selectedOption = message.interactive.list_reply.id;
      switch (selectedOption) {
        // Submenu Pais e Alunos
        case 'option_1':
          await sendParentsStudentsMenu(senderNumber);
          break;

        // Submenu Servidores SEMED
        case 'option_2':
          await sendSemedServersMenu(senderNumber);
          break;

        // Ponto de Parada
        case 'check_stop':
          userState[senderNumber] = 'awaiting_id';
          await sendTextMessage(
            senderNumber,
            'Para consultar o ponto de parada mais próximo, informe o ID de matrícula ou CPF do aluno (apenas números).'
          );
          break;

        // Solicitar Rota
        case 'request_route':
          userState[senderNumber] = { step: 'nome_responsavel' };
          await sendTextMessage(
            senderNumber,
            'Por favor, insira o nome completo do responsável pela solicitação:'
          );
          break;

        // Perguntas Frequentes
        case 'transport_questions':
          await sendTextMessage(
            senderNumber,
            'Perguntas frequentes sobre transporte: https://semedcanaadoscarajas.pydenexpress.com/faq'
          );
          break;

        // Reclamação / Elogio / Sugestão
        case 'feedback':
          await sendTextMessage(
            senderNumber,
            'Para enviar reclamações ou sugestões, acesse: https://semedcanaadoscarajas.pydenexpress.com/feedback'
          );
          break;

        // Falar com atendente
        case 'speak_to_agent':
          await sendTextMessage(
            senderNumber,
            'Aguarde enquanto conectamos você a um atendente...'
          );
          break;

        // Encerrar atendimento
        case 'end_service':
          await sendTextMessage(
            senderNumber,
            'Atendimento encerrado. Precisando de algo, é só chamar!'
          );
          delete userState[senderNumber];
          break;

        // Solicitar / Agendar Motorista (SEMED)
        case 'request_driver':
          await sendTextMessage(
            senderNumber,
            'Para solicitar um motorista, preencha o formulário em: https://example.com/solicitar-motorista'
          );
          break;

        case 'schedule_driver':
          await sendTextMessage(
            senderNumber,
            'Para agendar um motorista, preencha o formulário em: https://example.com/agendar-motorista'
          );
          break;

        // Voltar ao menu principal
        case 'back_to_menu':
          await sendInteractiveListMessage(senderNumber);
          break;

        default:
          // Caso não tenha opção
          await sendInteractiveListMessage(senderNumber);
      }
      setInactivityTimeout();
    }

    // -----------------------------------------------
    // Se for uma resposta de botão interativo
    // -----------------------------------------------
    else if (message.interactive && message.interactive.button_reply) {
      const buttonResponse = message.interactive.button_reply.id;
      if (buttonResponse === 'confirm_yes') {
        // Confirma dados do aluno e checa se ele usa transporte
        await checkStudentTransport(senderNumber);
      } else if (buttonResponse === 'confirm_no') {
        await sendTextMessage(
          senderNumber,
          'Por favor, verifique o ID de matrícula ou CPF e tente novamente.'
        );
        userState[senderNumber] = 'awaiting_id';
      } else if (buttonResponse === 'request_transport_yes') {
        userState[senderNumber] = { step: 'nome_responsavel' };
        await sendTextMessage(
          senderNumber,
          'Por favor, insira o nome completo do responsável pela solicitação:'
        );
      } else if (buttonResponse === 'request_transport_no') {
        await sendTextMessage(
          senderNumber,
          'Tudo bem! Se precisar de mais ajuda, é só enviar mensagem.'
        );
        delete userState[senderNumber];
      }
      setInactivityTimeout();
    }

    // -----------------------------------------------
    // Se o estado for "awaiting_id" (ponto de parada)
    // -----------------------------------------------
    else if (userState[senderNumber] === 'awaiting_id') {
      const isNumeric = /^[0-9]+$/.test(text);
      if (isNumeric) {
        await checkStudentEnrollment(senderNumber, text);
      } else {
        await sendTextMessage(
          senderNumber,
          'Por favor, forneça um ID de matrícula ou CPF válido (somente números).'
        );
      }
      setInactivityTimeout();
    }

    // -----------------------------------------------
    // Caso não tenha estado ou não seja interativo
    // Mostra o menu principal
    // -----------------------------------------------
    else {
      await sendInteractiveListMessage(senderNumber);
      setInactivityTimeout();
    }
  }

  // Confirma recebimento do Webhook (obrigatório p/ WhatsApp)
  res.sendStatus(200);
});

// -----------------------------------------------------
//         FUNÇÕES AUXILIARES DE BANCO / LÓGICA
// -----------------------------------------------------

/**
 * Busca aluno no DB (tabela "alunos_ativos") por ID de matrícula ou CPF
 */
async function findStudentByIdOrCpf(idOrCpf) {
  try {
    const client = await pool.connect();
    // Ajuste conforme seus campos em "alunos_ativos"
    const query = `
      SELECT a.*,
             e.nome AS nome_escola
      FROM alunos_ativos a
      LEFT JOIN escolas e ON a.escola_id = e.id
      WHERE a.id_matricula = $1 OR a.cpf = $1
      LIMIT 1
    `;
    const result = await client.query(query, [idOrCpf]);
    client.release();

    if (result.rows.length > 0) {
      return result.rows[0];
    }
    return null;
  } catch (error) {
    console.error('Erro ao buscar aluno em alunos_ativos:', error);
    return null;
  }
}

/**
 * Salva a solicitação de rota na tabela "cocessao_rota"
 */
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
      observacoes
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
        latitude,
        longitude,
        observacoes
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
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
      latitude,
      longitude,
      observacoes || null
    ];

    await client.query(insertQuery, values);
    client.release();
    console.log('Solicitação de rota salva com sucesso na tabela cocessao_rota!');
  } catch (error) {
    console.error('Erro ao salvar a solicitação de rota:', error);
  }
}

/**
 * Verifica a matrícula do aluno e retorna dados para checar se existe
 */
async function checkStudentEnrollment(to, studentId) {
  try {
    const client = await pool.connect();
    const query = `
      SELECT a.*,
             e.nome AS nome_escola
      FROM alunos_ativos a
      LEFT JOIN escolas e ON a.escola_id = e.id
      WHERE a.id_matricula = $1 OR a.cpf = $1
      LIMIT 1
    `;
    const result = await client.query(query, [studentId]);
    client.release();

    if (result.rows.length > 0) {
      const aluno = result.rows[0];
      // Armazena localmente
      userState[to] = { aluno };

      const alunoInfo = `
*Dados do Aluno Encontrado*:
Nome: ${aluno.pessoa_nome}
CPF: ${aluno.cpf || 'Não informado'}
Escola: ${aluno.nome_escola || 'Não vinculada'}
Matrícula: ${aluno.id_matricula || 'N/A'}
Transporte Público: ${aluno.transporte_escolar_poder_publico === 'SIM' ? 'Sim' : 'Não'}
      `;

      await sendInteractiveMessageWithButtons(
        to,
        alunoInfo,
        'Essas informações estão corretas?',
        'Sim',
        'confirm_yes',
        'Não',
        'confirm_no'
      );
    } else {
      await sendTextMessage(
        to,
        'ID de matrícula ou CPF não encontrado. Verifique as informações e tente novamente.'
      );
    }
  } catch (error) {
    console.error('Erro ao buscar aluno em alunos_ativos:', error);
    await sendTextMessage(
      to,
      'Desculpe, ocorreu um erro ao consultar as informações. Tente novamente mais tarde.'
    );
  }
}

/**
 * Verifica se o aluno já tem direito ao transporte e, se sim, busca ponto de parada
 * (Exemplo didático; você pode customizar conforme necessidade).
 */
async function checkStudentTransport(to) {
  const aluno = userState[to] ? userState[to].aluno : null;
  if (!aluno) {
    await sendTextMessage(
      to,
      'Não encontramos dados do aluno. Por favor, tente novamente.'
    );
    return;
  }

  // Se já usa transporte, busca ponto de parada
  if (aluno.transporte_escolar_poder_publico === 'SIM') {
    // Tenta converter endereço em coordenadas (via Google Maps)
    const coordinates = await getCoordinatesFromAddress(aluno.bairro || aluno.endereco || '');
    if (coordinates) {
      const nearestStop = await getNearestStop(coordinates);
      if (nearestStop) {
        // Gera link Google Maps
        if (
          coordinates.lat && coordinates.lng &&
          nearestStop.latitude && nearestStop.longitude
        ) {
          const directionsUrl = `https://www.google.com/maps/dir/?api=1&origin=${coordinates.lat},${coordinates.lng}&destination=${nearestStop.latitude},${nearestStop.longitude}&travelmode=walking`;
          await sendTextMessage(
            to,
            `O ponto de parada mais próximo é "${nearestStop.nome_ponto}".\nCoordenadas: ${nearestStop.latitude}, ${nearestStop.longitude}.\n[Traçar Rota no Google Maps](${directionsUrl})`
          );
        } else {
          await sendTextMessage(to, 'Não foi possível gerar a rota (coordenadas inválidas).');
        }
      } else {
        await sendTextMessage(
          to,
          'Não encontramos um ponto de parada próximo ao endereço cadastrado.'
        );
      }
    } else {
      // Pede ao usuário para enviar a localização manual
      userState[to].step = 'enviar_localizacao';
      await sendTextMessage(
        to,
        'Não foi possível identificar suas coordenadas pelo endereço. Por favor, envie sua localização atual.'
      );
    }
  } else {
    // Se não usa, pergunta se deseja solicitar
    await sendInteractiveMessageWithButtons(
      to,
      'O aluno não é usuário do transporte público. Deseja solicitar?',
      '',
      'Sim',
      'request_transport_yes',
      'Não',
      'request_transport_no'
    );
  }
}

/**
 * Verifica via PostGIS se as coordenadas (lat, lng) estão dentro de algum zoneamento.
 * Você precisa ter certeza de que sua tabela "zoneamentos" e a coluna "geom" têm SRID 4326.
 * E que existe um índice geográfico adequadamente configurado.
 */
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
    // Note a ordem (longitude, latitude) ou (latitude, longitude) — 
    // depende de como você armazenou seu geom. Aqui assumimos ST_Point(lng, lat).
    // Ajuste se necessário.
    const result = await client.query(query, [longitude, latitude]);
    client.release();

    if (result.rows.length > 0) {
      // Está dentro de um zoneamento
      return true;
    }
    return false;
  } catch (error) {
    console.error('Erro ao verificar zoneamento:', error);
    return false;
  }
}

/**
 * Converte endereço em coordenadas usando Google Maps
 */
async function getCoordinatesFromAddress(address) {
  try {
    if (!address) return null;

    const response = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
      params: {
        address,
        key: GOOGLE_MAPS_API_KEY
      }
    });

    if (response.data.status === 'OK') {
      const loc = response.data.results[0].geometry.location;
      return { lat: loc.lat, lng: loc.lng };
    }
    console.error('Erro no geocode (status):', response.data.status);
    return null;
  } catch (error) {
    console.error('Erro ao acessar Google Maps API:', error);
    return null;
  }
}

/**
 * Busca o ponto de parada mais próximo (tabela "pontos")
 */
async function getNearestStop({ lat, lng }) {
  try {
    const client = await pool.connect();
    const query = 'SELECT * FROM pontos';
    const result = await client.query(query);
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
    console.error('Erro ao consultar pontos:', error);
    return null;
  }
}

/**
 * Calcula distância (fórmula de Haversine)
 */
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
//       FUNÇÕES AUXILIARES DE ENVIO DE MENSAGEM
// -----------------------------------------------------

/**
 * 1) Envia menu principal (lista interativa)
 */
async function sendInteractiveListMessage(to) {
  const listMessage = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: {
        type: 'text',
        text: '🚍 Bem-vindo ao Sistema de Autoatendimento!'
      },
      body: {
        text: 'Selecione uma das opções abaixo para continuar:'
      },
      footer: {
        text: 'Atendimento Automatizado'
      },
      action: {
        button: 'Ver Opções',
        sections: [
          {
            title: 'Opções de Atendimento',
            rows: [
              {
                id: 'option_1',
                title: '1️⃣ Pais e Alunos',
                description: 'Informações para Pais/Responsáveis'
              },
              {
                id: 'option_2',
                title: '2️⃣ Servidores SEMED',
                description: 'Informações para Servidores'
              },
              {
                id: 'option_3',
                title: '3️⃣ Servidores Escola',
                description: 'Informações para Escolas'
              },
              {
                id: 'option_4',
                title: '4️⃣ Fornecedores',
                description: 'Informações para Fornecedores'
              },
              {
                id: 'option_5',
                title: '5️⃣ Motoristas',
                description: 'Informações para Motoristas'
              },
              {
                id: 'option_6',
                title: '6️⃣ Encerrar Atendimento',
                description: 'Finalizar o atendimento'
              }
            ]
          }
        ]
      }
    }
  };

  try {
    await axios.post(`${WHATSAPP_API_URL}/${PHONE_NUMBER_ID}/messages`, listMessage, {
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`
      }
    });
  } catch (error) {
    console.error('Erro ao enviar menu principal:', error?.response?.data || error.message);
  }
}

/**
 * 2) Submenu - Pais e Alunos
 */
async function sendParentsStudentsMenu(to) {
  const submenuMessage = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: {
        type: 'text',
        text: '🚍 Pais, Responsáveis e Alunos'
      },
      body: {
        text: 'Escolha a opção que melhor atende à sua necessidade:'
      },
      footer: {
        text: 'Como podemos ajudar?'
      },
      action: {
        button: 'Ver Opções',
        sections: [
          {
            title: 'Necessidades',
            rows: [
              {
                id: 'check_stop',
                title: '1️⃣ Ponto de Parada',
                description: 'Encontrar o ponto de parada mais próximo'
              },
              {
                id: 'request_route',
                title: '2️⃣ Solicitar Rota',
                description: 'Concessão ou ajuste de rota escolar'
              },
              {
                id: 'transport_questions',
                title: '3️⃣ Dúvidas',
                description: 'Perguntas frequentes'
              },
              {
                id: 'feedback',
                title: '4️⃣ Feedback',
                description: 'Reclamações, elogios e sugestões'
              },
              {
                id: 'speak_to_agent',
                title: '5️⃣ Falar com Atendente',
                description: 'Conversar com um atendente'
              },
              {
                id: 'end_service',
                title: '6️⃣ Encerrar Atendimento',
                description: 'Finalizar o atendimento'
              }
            ]
          }
        ]
      }
    }
  };

  try {
    await axios.post(`${WHATSAPP_API_URL}/${PHONE_NUMBER_ID}/messages`, submenuMessage, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }
    });
  } catch (error) {
    console.error('Erro ao enviar submenu Pais/Alunos:', error?.response?.data || error.message);
  }
}

/**
 * 3) Submenu - Servidores SEMED
 */
async function sendSemedServersMenu(to) {
  const submenuMessage = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: {
        type: 'text',
        text: '👩‍🏫 Servidores SEMED'
      },
      body: {
        text: 'Selecione a opção desejada:'
      },
      footer: {
        text: 'Como podemos ajudar?'
      },
      action: {
        button: 'Ver Opções',
        sections: [
          {
            title: 'Necessidades',
            rows: [
              {
                id: 'request_driver',
                title: '1️⃣ Solicitar Motorista',
                description: 'Solicitar transporte'
              },
              {
                id: 'schedule_driver',
                title: '2️⃣ Agendar Motorista',
                description: 'Agendar transporte futuro'
              },
              {
                id: 'speak_to_agent',
                title: '3️⃣ Falar com Atendente',
                description: 'Conversar com um atendente'
              },
              {
                id: 'end_service',
                title: '4️⃣ Encerrar Chamado',
                description: 'Finalizar o atendimento'
              },
              {
                id: 'back_to_menu',
                title: '5️⃣ Menu Anterior',
                description: 'Retornar ao menu principal'
              }
            ]
          }
        ]
      }
    }
  };

  try {
    await axios.post(`${WHATSAPP_API_URL}/${PHONE_NUMBER_ID}/messages`, submenuMessage, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }
    });
  } catch (error) {
    console.error('Erro ao enviar submenu SEMED:', error?.response?.data || error.message);
  }
}

/**
 * Envia mensagem de texto simples no WhatsApp
 */
async function sendTextMessage(to, text) {
  const message = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { body: text }
  };

  try {
    await axios.post(`${WHATSAPP_API_URL}/${PHONE_NUMBER_ID}/messages`, message, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }
    });
  } catch (error) {
    console.error('Erro ao enviar mensagem de texto:', error?.response?.data || error.message);
  }
}

/**
 * Envia botões interativos de confirmação
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
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: {
        text: bodyText
      },
      footer: {
        text: footerText
      },
      action: {
        buttons: [
          {
            type: 'reply',
            reply: {
              id: button1Id,
              title: button1Title
            }
          },
          {
            type: 'reply',
            reply: {
              id: button2Id,
              title: button2Title
            }
          }
        ]
      }
    }
  };

  try {
    await axios.post(`${WHATSAPP_API_URL}/${PHONE_NUMBER_ID}/messages`, buttonMessage, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }
    });
  } catch (error) {
    console.error('Erro ao enviar botões interativos:', error?.response?.data || error.message);
  }
}

// -----------------------------------------------------
// Sobe o servidor do BOT
// -----------------------------------------------------
app.listen(BOT_PORT, () => {
  console.log(`BOT rodando na porta ${BOT_PORT}...`);
});
