import { pool } from "./lib/db.js";

try {
  const result = await pool.query("SELECT NOW()");
  console.log("Database connected:", result.rows[0]);
} catch (err) {
  console.error("Database error:", err.message);
} finally {
  await pool.end();
}