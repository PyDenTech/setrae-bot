/*
Esse arquivo faz:
1. Verifica se um ponto está dentro de um polígono (zoneamento) no banco
2. Checa se há relação entre uma escola e o zoneamento
*/

const pool = require("../db/pool");

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

module.exports = { getZoneInfo, checkZoneSchool };
