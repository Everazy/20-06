import { pool } from "./db.js";

export default async function handler(req, res) {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS stocks (
        id SERIAL PRIMARY KEY,
        product_id TEXT NOT NULL,
        variant_code TEXT NOT NULL,
        accounts JSONB DEFAULT '[]',
        total_delivered INTEGER DEFAULT 0,
        auto_payment BOOLEAN DEFAULT FALSE,
        insider_auto BOOLEAN DEFAULT FALSE,
        insider_sku TEXT,
        last_updated TIMESTAMP DEFAULT NOW()
      );
    `);

    res.json({
      success: true,
      message: "Table stocks berhasil dibuat."
    });

  } catch (err) {
    console.error(err);

    res.status(500).json({
      success: false,
      error: err.message
    });
  }
}