const sql = require('mssql');
const config = require('../config/dbConfig');

let pool;

module.exports = {
  connect: async () => {
    if (!pool) {
      pool = await sql.connect(config);
      console.log('Database connected');
    }
    return pool;
  },
  
  verifyConnection: async () => {
    try {
      const result = await pool.request().query('SELECT 1 AS status');
      return result.recordset[0].status === 1;
    } catch (error) {
      console.error('Connection verification failed:', error);
      return false;
    }
  },
  
  getPool: () => pool
};