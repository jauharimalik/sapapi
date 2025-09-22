module.exports = {
  user: 'PK-SERVE',
  password: 'n0v@0707#',
  server: '192.168.100.202',
  database: 'db_pandurasa',
  options: {
    encrypt: false,
    trustServerCertificate: true,
    connectTimeout: 600000,      // Naikkan menjadi 60 detik
    requestTimeout: 1200000,     // Naikkan menjadi 120 detik (2 menit)
    enableArithAbort: true,
    maxRetriesOnTransientErrors: 3,     // Retry untuk transient errors
    connectionRetryInterval: 30000,      // Interval retry 3 detik
  },
  pool: {
    max: 15,                    // Naikkan max connections
    min: 2,                     // Minimal connections
    idleTimeoutMillis: 300000,
    acquireTimeoutMillis: 600000, // Timeout untuk mendapatkan connection
    createRetryIntervalMillis: 20000,
    createTimeoutMillis: 600000
  }
};