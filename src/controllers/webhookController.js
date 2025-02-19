/*
Arquivo: routes.js (exemplo de nome)
---------------------------------
Este arquivo faz:
1. Gerencia as rotas do Express para o webhook principal
2. Recebe eventos do WhatsApp e identifica o tipo de mensagem
3. Controla o fluxo de conversas baseado no userState e envia respostas
*/

const express = require("express");
const router = express.Router();
const {
  findStudentByIdOrCpf,
  saveRouteRequest,
  saveDriverRequest,
  saveSchoolCarRequest,
  saveSchoolInforme,
  saveParentsInforme,
} = require("../services/dbService");
const { getZoneInfo, checkZoneSchool } = require("../utils/zoneUtils");
const { userState } = require("../utils/conversationState");
const setInactivityTimeout = require("../utils/timers");
const endConversation = require("../utils/endConversation");
const handoffToHuman = require("../services/handoffService");
const {
  checkStudentTransport,
  finishCheckStudentTransport,
} = require("../services/transportService");
const {
  sendTextMessage,
  sendInteractiveListMessage,
  sendParentsMenu,
  sendSemedServersMenu,
  sendSchoolServersMenu,
  sendInteractiveMessageWithButtons,
} = require("../services/whatsappService");
const { VERIFY_TOKEN } = require("../config/env");

router.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verificado com sucesso!");
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

router.post("/webhook", async (req, res) => {
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

    const setTimer = () => setInactivityTimeout(senderNumber);

    // Verifica se há fluxo em andamento
    if (userState[senderNumber] && userState[senderNumber].step) {
      switch (userState[senderNumber].step) {
        case "parents_informe_type":
          if (message.interactive && message.interactive.button_reply) {
            userState[senderNumber].parents_informe_type =
              message.interactive.button_reply.id;
            userState[senderNumber].step = "parents_informe_desc";
            await sendTextMessage(
              senderNumber,
              "Poderia, por favor, descrever o informe (denúncia, elogio ou sugestão)?"
            );
          }
          break;

        case "parents_informe_desc":
          userState[senderNumber].parents_informe_desc = text;
          await saveParentsInforme(senderNumber, userState[senderNumber]);
          await endConversation(
            senderNumber,
            "Seu informe foi registrado com sucesso! Agradecemos a sua contribuição. Caso necessite de mais assistência, ficamos à disposição."
          );
          break;

        case "termos_uso":
          if (message.interactive && message.interactive.button_reply) {
            const resp = message.interactive.button_reply.id;
            if (resp === "aceito_termos") {
              userState[senderNumber].step = "nome_responsavel";
              await sendTextMessage(
                senderNumber,
                "Ótimo! Por gentileza, informe o nome completo do(a) responsável pela solicitação:"
              );
            } else {
              await endConversation(
                senderNumber,
                "Sem problemas. Como você não concordou com os termos, não podemos prosseguir com o serviço. Atendimento encerrado."
              );
            }
          }
          break;

        case "nome_responsavel":
          userState[senderNumber].nome_responsavel = text;
          userState[senderNumber].step = "cpf_responsavel";
          await sendTextMessage(
            senderNumber,
            "Poderia, por favor, informar o CPF do(a) responsável?"
          );
          break;

        case "cpf_responsavel":
          userState[senderNumber].cpf_responsavel = text;
          userState[senderNumber].step = "cep";
          await sendTextMessage(
            senderNumber,
            "Poderia me informar o CEP do endereço, por favor?"
          );
          break;

        case "cep":
          userState[senderNumber].cep = text;
          userState[senderNumber].step = "numero";
          await sendTextMessage(
            senderNumber,
            "Qual é o número da residência, por gentileza?"
          );
          break;

        case "numero":
          userState[senderNumber].numero = text;
          userState[senderNumber].step = "endereco";
          await sendTextMessage(
            senderNumber,
            'Certo! Agora, informe o nome da rua e o bairro (por exemplo: "Rua X, Bairro Y"):'
          );
          break;

        case "endereco":
          userState[senderNumber].endereco = text;
          userState[senderNumber].step = "localizacao_atual";
          await sendTextMessage(
            senderNumber,
            "Por favor, compartilhe a localização (latitude/longitude) da residência do(a) aluno(a). Isso nos ajudará a verificar a rota."
          );
          break;

        case "localizacao_atual":
          if (location) {
            userState[senderNumber].latitude = location.latitude;
            userState[senderNumber].longitude = location.longitude;
            userState[senderNumber].step = "comprovante_residencia";
            await sendTextMessage(
              senderNumber,
              "Localização recebida com sucesso! Agora, envie uma foto ou PDF do comprovante de residência, por favor."
            );
          } else {
            await sendTextMessage(
              senderNumber,
              "Não detectamos uma localização válida. Poderia enviar novamente, por favor?"
            );
          }
          break;

        case "comprovante_residencia":
          if (media) {
            userState[senderNumber].comprovante_residencia_path = media.id;
            userState[senderNumber].step = "id_matricula_aluno";
            await sendTextMessage(
              senderNumber,
              "Comprovante recebido! Agora, insira o ID de matrícula ou CPF do(a) aluno(a) (somente números), por favor."
            );
          } else {
            await sendTextMessage(
              senderNumber,
              "Não conseguimos identificar seu arquivo. Por gentileza, envie o comprovante de residência em formato de imagem ou PDF."
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
                `Aluno encontrado: ${alunoData.pessoa_nome}. Ele(a) possui alguma deficiência? Responda "Sim" ou "Não".`
              );
            } else {
              await endConversation(
                senderNumber,
                "Não foi possível localizar esse ID de matrícula ou CPF. Encerrando o atendimento, mas estamos à disposição se precisar tentar novamente."
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
              "Entendido. Por favor, envie o laudo médico que comprove a deficiência (imagem ou PDF)."
            );
          } else {
            userState[senderNumber].deficiencia = false;
            userState[senderNumber].laudo_deficiencia_path = null;
            userState[senderNumber].step = "celular_responsavel";
            await sendTextMessage(
              senderNumber,
              "Tudo bem. Agora, por favor, informe o telefone do(a) responsável."
            );
          }
          break;

        case "laudo_deficiencia":
          if (media) {
            userState[senderNumber].laudo_deficiencia_path = media.id;
            userState[senderNumber].step = "celular_responsavel";
            await sendTextMessage(
              senderNumber,
              "Laudo médico recebido. Agora, por favor, informe o telefone do(a) responsável."
            );
          } else {
            await sendTextMessage(
              senderNumber,
              "Não conseguimos identificar seu arquivo. Poderia, por gentileza, enviar o laudo em imagem ou PDF?"
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
                "Parece que sua localização está dentro de um zoneamento cadastrado."
              );
              const escolaID = userState[senderNumber].escola_id;
              const zoneSchoolRelation = await checkZoneSchool(
                escolaID,
                zoneInfo.zoneId
              );
              if (zoneSchoolRelation) {
                await sendTextMessage(
                  senderNumber,
                  "Este zoneamento está vinculado à mesma escola do(a) aluno(a)."
                );
              } else {
                await sendTextMessage(
                  senderNumber,
                  "Este zoneamento não está diretamente vinculado à escola do(a) aluno(a). Continuaremos com a solicitação, mas fique atento(a) a possíveis divergências."
                );
                userState[senderNumber].zoneamento = false;
              }
            } else {
              await sendTextMessage(
                senderNumber,
                "Aparentemente sua localização está fora dos zoneamentos conhecidos. Prosseguiremos mesmo assim."
              );
              userState[senderNumber].zoneamento = false;
            }
          }
          userState[senderNumber].step = "observacoes";
          await sendTextMessage(
            senderNumber,
            'Poderia inserir alguma observação adicional? Se não houver, digite "nenhuma".'
          );
          break;

        case "observacoes":
          userState[senderNumber].observacoes =
            text.toLowerCase() === "nenhuma" ? "" : text;
          await saveRouteRequest(senderNumber, userState[senderNumber]);
          await endConversation(
            senderNumber,
            "Sua solicitação de rota foi enviada com sucesso! Muito obrigado pelo seu contato. Se precisar de qualquer ajuda no futuro, é só nos procurar."
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
              "Não conseguimos identificar sua localização. Poderia tentar novamente, por favor?"
            );
          }
          break;

        case "driver_name":
          userState[senderNumber].driver_name = text;
          userState[senderNumber].step = "driver_setor";
          await sendTextMessage(
            senderNumber,
            "Por favor, informe o setor/departamento (ex: Gabinete, RH etc.):"
          );
          break;

        case "driver_setor":
          userState[senderNumber].driver_setor = text;
          userState[senderNumber].step = "driver_qtd";
          await sendTextMessage(
            senderNumber,
            "Quantas pessoas irão utilizar este transporte?"
          );
          break;

        case "driver_qtd":
          userState[senderNumber].driver_qtd = text;
          userState[senderNumber].step = "driver_destino";
          await sendTextMessage(
            senderNumber,
            "Entendi. Qual será o destino da viagem?"
          );
          break;

        case "driver_destino":
          userState[senderNumber].driver_destino = text;
          userState[senderNumber].step = "driver_local_origem";
          await sendTextMessage(
            senderNumber,
            "Poderia, por favor, compartilhar a localização de origem (onde o motorista deve buscar)?"
          );
          break;

        case "driver_local_origem":
          if (location) {
            userState[senderNumber].driver_lat_origem = location.latitude;
            userState[senderNumber].driver_lng_origem = location.longitude;
            userState[senderNumber].step = "driver_carga_await";
            await sendInteractiveMessageWithButtons(
              senderNumber,
              "Há alguma carga que exija um veículo com carroceria?",
              "",
              "Sim",
              "driver_has_carga_yes",
              "Não",
              "driver_has_carga_no"
            );
          } else {
            await sendTextMessage(
              senderNumber,
              "Não detectamos uma localização válida. Poderia reenviar a localização de origem, por gentileza?"
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
                "Entendi. Precisaremos de um veículo com carroceria. Qual o horário em que o veículo será necessário (ex: 08:00)?"
              );
            } else {
              userState[senderNumber].driver_has_carga = false;
              userState[senderNumber].driver_car_needed = "qualquer";
              userState[senderNumber].step = "driver_hora_necessidade";
              await sendTextMessage(
                senderNumber,
                "Perfeito, qualquer veículo disponível será adequado. Poderia informar o horário em que o carro será necessário (ex: 08:00)?"
              );
            }
          }
          break;

        case "driver_hora_necessidade":
          userState[senderNumber].driver_hora_necessidade = text;
          userState[senderNumber].step = "driver_observacoes";
          await sendTextMessage(
            senderNumber,
            'Deseja registrar alguma observação extra? (Se não houver, digite "nenhuma")'
          );
          break;

        case "driver_observacoes":
          userState[senderNumber].driver_observacoes =
            text.toLowerCase() === "nenhuma" ? "" : text;
          await saveDriverRequest(senderNumber, userState[senderNumber]);
          await sendTextMessage(
            senderNumber,
            "Sua solicitação foi registrada. Lembre-se de que o motorista poderá aguardar até 15 minutos na zona urbana e 2 horas na zona rural."
          );
          await endConversation(
            senderNumber,
            "Agradecemos o seu contato! Sua solicitação de motorista foi enviada com sucesso."
          );
          break;

        case "school_car_nome_escola":
          userState[senderNumber].nome_escola = text;
          userState[senderNumber].step = "school_car_qtd_passageiros";
          await sendTextMessage(
            senderNumber,
            "Quantos passageiros vão necessitar do veículo?"
          );
          break;

        case "school_car_qtd_passageiros":
          userState[senderNumber].qtd_passageiros = text;
          userState[senderNumber].step = "school_car_descricao_demanda";
          await sendTextMessage(
            senderNumber,
            "Poderia descrever a demanda (motivo da solicitação)?"
          );
          break;

        case "school_car_descricao_demanda":
          userState[senderNumber].descricao_demanda = text;
          userState[senderNumber].step = "school_car_zona_await";
          await sendInteractiveMessageWithButtons(
            senderNumber,
            "Por favor, informe se é zona urbana ou rural?",
            "",
            "Urbana",
            "zona_urbana",
            "Rural",
            "zona_rural"
          );
          break;

        case "school_car_zona_await":
          if (message.interactive && message.interactive.button_reply) {
            const zonaResp = message.interactive.button_reply.id;
            userState[senderNumber].zona =
              zonaResp === "zona_urbana" ? "Urbana" : "Rural";
            userState[senderNumber].step = "school_car_tempo_est";
            await sendTextMessage(
              senderNumber,
              "Qual o tempo estimado de uso do veículo? (Ex: 2 horas)"
            );
          }
          break;

        case "school_car_tempo_est":
          userState[senderNumber].tempo_est = text;
          userState[senderNumber].step = "school_car_data";
          await sendTextMessage(
            senderNumber,
            "Poderia me informar a data do agendamento? (Ex: 12/02/2025)"
          );
          break;

        case "school_car_data":
          userState[senderNumber].data_agendamento = text;
          userState[senderNumber].step = "school_car_hora";
          await sendTextMessage(
            senderNumber,
            "Agora, qual será o horário? (Ex: 08:00)"
          );
          break;

        case "school_car_hora":
          userState[senderNumber].hora_agendamento = text;
          await saveSchoolCarRequest(senderNumber, userState[senderNumber]);
          await endConversation(
            senderNumber,
            "Pronto! Sua solicitação de carro para a escola foi registrada com sucesso. Agradecemos o contato!"
          );
          break;

        case "school_informe_tipo":
          if (message.interactive && message.interactive.button_reply) {
            userState[senderNumber].informe_tipo =
              message.interactive.button_reply.id;
            userState[senderNumber].step = "school_informe_desc";
            await sendTextMessage(
              senderNumber,
              "Certo! Poderia descrever o informe com mais detalhes?"
            );
          }
          break;

        case "school_informe_desc":
          userState[senderNumber].informe_descricao = text;
          await saveSchoolInforme(senderNumber, userState[senderNumber]);
          await endConversation(
            senderNumber,
            "Informe registrado com sucesso. Agradecemos a sua colaboração!"
          );
          break;

        default:
          // Se o step não estiver previsto, voltamos ao menu principal
          await sendInteractiveListMessage(senderNumber);
      }
      setTimer();
    } else if (message.interactive && message.interactive.list_reply) {
      // Tratamento das opções do menu (lista interativa)
      const selectedOption = message.interactive.list_reply.id;

      switch (selectedOption) {
        case "option_1":
          await sendParentsMenu(senderNumber);
          break;
        case "option_2":
          await sendSemedServersMenu(senderNumber);
          break;
        case "option_3":
          await sendSchoolServersMenu(senderNumber);
          break;
        case "option_4":
          await sendTextMessage(
            senderNumber,
            "Esta seção ainda está em desenvolvimento, mas logo estará disponível."
          );
          await endConversation(
            senderNumber,
            "Agradecemos a sua compreensão. O atendimento foi encerrado."
          );
          break;
        case "option_5":
          await sendTextMessage(
            senderNumber,
            "Esta seção ainda está em desenvolvimento, mas logo estará disponível."
          );
          await endConversation(
            senderNumber,
            "Agradecemos a sua compreensão. O atendimento foi encerrado."
          );
          break;
        case "option_6":
          await endConversation(
            senderNumber,
            "Atendimento encerrado. Sempre que precisar de algo, é só nos chamar!"
          );
          break;

        case "parents_option_1":
          userState[senderNumber] = "awaiting_aluno_id_or_cpf";
          await sendTextMessage(
            senderNumber,
            "Para encontrarmos o ponto de parada mais próximo, precisamos do ID de matrícula ou CPF do(a) aluno(a). Poderia enviar?"
          );
          break;
        case "parents_option_2":
          userState[senderNumber] = { step: "termos_uso" };
          await sendTextMessage(
            senderNumber,
            "Para solicitar a concessão de rota, precisamos que esteja ciente dos termos (distância mínima, idade etc.)."
          );
          await sendInteractiveMessageWithButtons(
            senderNumber,
            "Você confirma a aceitação dos termos de uso do transporte?",
            "",
            "Sim",
            "aceito_termos",
            "Não",
            "recuso_termos"
          );
          break;
        case "parents_option_3":
          userState[senderNumber] = { step: "parents_informe_type" };
          await sendInteractiveMessageWithButtons(
            senderNumber,
            "Por favor, selecione o tipo de informe:",
            "",
            "Denúncia",
            "denuncia",
            "Elogio",
            "elogio_parents"
          );
          break;
        case "parents_option_4":
          await handoffToHuman(senderNumber, "transporte_escolar");
          break;
        case "parents_option_5":
          await sendInteractiveListMessage(senderNumber);
          break;
        case "parents_option_6":
          await endConversation(
            senderNumber,
            "Atendimento encerrado. Obrigado pelo contato, e sempre que precisar, estamos por aqui!"
          );
          break;

        case "request_driver":
          userState[senderNumber] = { step: "driver_name" };
          await sendTextMessage(
            senderNumber,
            "Para solicitar um motorista, poderia informar seu nome completo, por favor?"
          );
          break;
        case "speak_to_agent":
          await handoffToHuman(senderNumber, "transporte_administrativo");
          break;
        case "end_service":
          await endConversation(
            senderNumber,
            "Atendimento encerrado. Se precisar de algo no futuro, basta nos enviar uma mensagem."
          );
          break;
        case "back_to_menu":
          await sendInteractiveListMessage(senderNumber);
          break;

        case "school_option_1":
          userState[senderNumber] = { step: "school_car_nome_escola" };
          await sendTextMessage(
            senderNumber,
            "Para solicitar um carro, por favor informe o nome da escola."
          );
          break;
        case "school_option_2":
          userState[senderNumber] = { step: "school_informe_tipo" };
          await sendInteractiveMessageWithButtons(
            senderNumber,
            "Qual o tipo de informe deseja registrar?",
            "",
            "Elogio",
            "elogio_escola",
            "Reclamação",
            "reclamacao_escola"
          );
          break;
        case "school_option_3":
          await handoffToHuman(senderNumber, "transporte_administrativo");
          break;
        case "school_option_5":
          await endConversation(
            senderNumber,
            "Atendimento encerrado. Caso precise de algo, estaremos aqui para ajudar."
          );
          break;

        default:
          // Se a opção não estiver listada, voltamos ao menu principal
          await sendInteractiveListMessage(senderNumber);
      }
      setTimer();
    } else if (message.interactive && message.interactive.button_reply) {
      // Tratamento de botões fora de contexto de submenu
      const buttonResponse = message.interactive.button_reply.id;

      if (buttonResponse === "confirm_yes") {
        await checkStudentTransport(senderNumber);
      } else if (buttonResponse === "confirm_no") {
        await sendTextMessage(
          senderNumber,
          "Sem problemas. Por favor, verifique o ID de matrícula ou CPF e tente novamente."
        );
        userState[senderNumber] = "awaiting_aluno_id_or_cpf";
      } else if (buttonResponse === "request_transport_yes") {
        userState[senderNumber] = { step: "termos_uso" };
        await sendTextMessage(
          senderNumber,
          "Para solicitar o transporte escolar, é necessário atender aos critérios oficiais (distância, idade etc.). Você confirma estar ciente dessas condições?"
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
          "Tudo bem, não se preocupe. Se precisar de algo no futuro, estamos sempre aqui!"
        );
      }
      setTimer();
    } else if (userState[senderNumber] === "awaiting_aluno_id_or_cpf") {
      // Fluxo para verificar aluno quando step é uma simples string
      const aluno = await findStudentByIdOrCpf(text);
      if (aluno) {
        userState[senderNumber] = { aluno };
        const infoTransporte = aluno.transporte_escolar_poder_publico
          ? aluno.transporte_escolar_poder_publico
          : "Não informado (provavelmente não usuário)";
        const alunoInfo = `*Dados do(a) Aluno(a) Encontrado(a)*:
Nome: ${aluno.pessoa_nome}
CPF: ${aluno.cpf || "Não informado"}
Escola: ${aluno.nome_escola || "Não vinculada"}
Matrícula: ${aluno.id_matricula || "N/A"}
Transporte Público: ${infoTransporte}`;

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
          "Não encontramos nenhum aluno com este ID de matrícula ou CPF. Atendimento encerrado, mas estamos à disposição se precisar tentar novamente."
        );
      }
      setTimer();
    } else {
      // Se nenhuma condição se aplica, abre o menu principal
      await sendInteractiveListMessage(senderNumber);
      setTimer();
    }
  }

  res.sendStatus(200);
});

module.exports = router;
