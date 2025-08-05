module.exports = {
  user: 'PK-SERVE',
  password: 'n0v@0707#',
  server: '192.168.100.202',
  database: 'db_pandurasa',
  options: {
    encrypt: false,
    trustServerCertificate: true,
    connectTimeout: 30000,
    requestTimeout: 30000
  },
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000
  }
};