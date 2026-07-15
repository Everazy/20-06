import pg from "pg";

const { Pool } = pg;

const pool = new Pool({
  host: "nano-1.nura.host",
  port: 5002,
  user: "everastore",
  password: "Evera123",
  database: "everastore",
  ssl: false,
});

export default pool;