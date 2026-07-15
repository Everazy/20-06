import "dotenv/config";
import pg from "pg";

const { Pool } = pg;

export const pool = new Pool({
  host: "nano-1.nura.host",
  port: 5002,
  database: "everastore",
  user: "everastore",
  password: "Evera123",
  ssl: false
});
