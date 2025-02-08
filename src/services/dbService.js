/*
Esse arquivo faz:
1. Consulta e salva dados no banco (PostgreSQL) para o fluxo do bot
2. Funções de SELECT e INSERT relacionadas a alunos, rotas, informes, etc.
*/

const pool = require("../db/pool");
const { OPERATOR_NUMBER } = require("../config/env");
const { sendTextMessage } = require("./whatsappService");

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

async function saveRouteRequest(senderNumber, state) {
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
    } = state;

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

async function saveDriverRequest(senderNumber, state) {
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
    } = state;

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

async function saveSchoolCarRequest(senderNumber, state) {
  try {
    const {
      nome_escola,
      qtd_passageiros,
      descricao_demanda,
      zona,
      tempo_est,
      data_agendamento,
      hora_agendamento,
    } = state;

    const client = await pool.connect();
    const insertQuery = `
      INSERT INTO solicitacao_carro_escola (
        nome_escola,
        qtd_passageiros,
        descricao_demanda,
        zona,
        tempo_estimado,
        data_agendamento,
        hora_agendamento
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `;
    const values = [
      nome_escola,
      qtd_passageiros,
      descricao_demanda,
      zona,
      tempo_est,
      data_agendamento,
      hora_agendamento,
    ];
    await client.query(insertQuery, values);
    client.release();

    console.log(
      "Solicitação de carro (escola) salva na tabela solicitacao_carro_escola!"
    );
    const notifyMsg = `🚐 *NOVA SOLICITAÇÃO DE CARRO (Escola)* 🚐

*Escola:* ${nome_escola}
*Passageiros:* ${qtd_passageiros}
*Demanda:* ${descricao_demanda}
*Zona:* ${zona}
*Tempo Estimado:* ${tempo_est}
*Data:* ${data_agendamento}
*Hora:* ${hora_agendamento}

Por favor, verifique e providencie um carro.`;
    await sendTextMessage(OPERATOR_NUMBER, notifyMsg);
  } catch (error) {
    console.error("Erro ao salvar solicitação de carro (escola):", error);
  }
}

async function saveSchoolInforme(senderNumber, state) {
  try {
    const { informe_tipo, informe_descricao } = state;

    const client = await pool.connect();
    const insertQuery = `
      INSERT INTO informes_escola (
        tipo,
        descricao
      )
      VALUES ($1, $2)
    `;
    const values = [informe_tipo, informe_descricao];
    await client.query(insertQuery, values);
    client.release();

    console.log("Informe da escola salvo em informes_escola!");
    const notifyMsg = `✉️ *NOVO INFORME DA ESCOLA* ✉️

*Tipo:* ${informe_tipo}
*Descrição:* ${informe_descricao}

Verifique no sistema para mais detalhes.`;
    await sendTextMessage(OPERATOR_NUMBER, notifyMsg);
  } catch (error) {
    console.error("Erro ao salvar informe da escola:", error);
  }
}

async function saveParentsInforme(senderNumber, state) {
  try {
    const { parents_informe_type, parents_informe_desc } = state;

    const client = await pool.connect();
    const insertQuery = `
      INSERT INTO informes_parents (
        tipo,
        descricao
      )
      VALUES ($1, $2)
    `;
    const values = [parents_informe_type, parents_informe_desc];
    await client.query(insertQuery, values);
    client.release();

    console.log("Informe de Pais/Responsáveis salvo em informes_parents!");
    const notifyMsg = `✉️ *NOVO INFORME (Pais/Responsáveis)* ✉️

*Tipo:* ${parents_informe_type}
*Descrição:* ${parents_informe_desc}

Verifique no sistema para mais detalhes.`;
    await sendTextMessage(OPERATOR_NUMBER, notifyMsg);
  } catch (error) {
    console.error("Erro ao salvar informe de Pais/Responsáveis:", error);
  }
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

module.exports = {
  findStudentByIdOrCpf,
  saveRouteRequest,
  saveDriverRequest,
  saveSchoolCarRequest,
  saveSchoolInforme,
  saveParentsInforme,
  getRoutesBySchool,
  getPointsByRoutes,
};
