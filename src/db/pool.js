/*
Esse arquivo faz:
1. Configura a conexão com o banco de dados (PostgreSQL)
2. Cria e exporta uma instância de Pool do pg para uso em todo o projeto
*/

const { Pool } = require("pg");
const { DATABASE_URL } = require("../config/env");

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

module.exports = pool;
