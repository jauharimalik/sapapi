const sql = require('mssql');

// Konfigurasi koneksi database
const config = {
  user: 'sa',
  password: 'n0v@0707#',
  server: 'PK-QUERY',
  database: 'reporting',
  options: {
    trustServerCertificate: true, // Gunakan ini jika Anda mengalami masalah sertifikat
  }
};

// Skrip SQL yang akan dieksekusi
const sqlScript = `
DECLARE @RandomRows_Temp1 INT;
DECLARE @RandomRows_Temp2 INT;
DECLARE @RandomRows_StockHistory INT;
DECLARE @RandomRows_StockHistory2 INT;

-- Generate random numbers for each table (1 to 250)
SET @RandomRows_Temp1 = (SELECT CAST(RAND(CHECKSUM(NEWID())) * 250 AS INT) + 1);
SET @RandomRows_Temp2 = (SELECT CAST(RAND(CHECKSUM(NEWID())) * 250 AS INT) + 1);
SET @RandomRows_StockHistory = (SELECT CAST(RAND(CHECKSUM(NEWID())) * 250 AS INT) + 1);
SET @RandomRows_StockHistory2 = (SELECT CAST(RAND(CHECKSUM(NEWID())) * 250 AS INT) + 1);

-- --- HAPUS DATA DARI TABEL Temp1 ---
WITH CTE AS
(
    SELECT TOP (@RandomRows_Temp1) *
    FROM dbo.Temp1
    ORDER BY NEWID()
)
DELETE FROM CTE;

-- --- HAPUS DATA DARI TABEL Temp2 ---
WITH CTE AS
(
    SELECT TOP (@RandomRows_Temp2) *
    FROM dbo.Temp2
    ORDER BY NEWID()
)
DELETE FROM CTE;

-- --- HAPUS DATA DARI TABEL StockHistory ---
WITH CTE AS
(
    SELECT TOP (@RandomRows_StockHistory) *
    FROM dbo.StockHistory
    ORDER BY NEWID()
)
DELETE FROM CTE;

-- --- HAPUS DATA DARI TABEL StockHistory2 ---
WITH CTE AS
(
    SELECT TOP (@RandomRows_StockHistory2) *
    FROM dbo.StockHistory2
    ORDER BY NEWID()
)
DELETE FROM CTE;

-- --- MENAMPILKAN JUMLAH DATA YANG DIHAPUS ---
SELECT 
    'Temp1' AS Tabel, @RandomRows_Temp1 AS JumlahDihapus
UNION ALL
SELECT
    'Temp2' AS Tabel, @RandomRows_Temp2 AS JumlahDihapus
UNION ALL
SELECT
    'StockHistory' AS Tabel, @RandomRows_StockHistory AS JumlahDihapus
UNION ALL
SELECT
    'StockHistory2' AS Tabel, @RandomRows_StockHistory2 AS JumlahDihapus;
`;

// Fungsi untuk menghubungkan dan mengeksekusi skrip
async function runScript() {
  try {
    // Hubungkan ke database
    await sql.connect(config);
    console.log('Berhasil terhubung ke database.');

    // Jalankan skrip SQL
    const result = await sql.query(sqlScript);

    console.log('Skrip SQL berhasil dieksekusi.');
    console.log('\n--- Hasil Penghapusan Data ---');
    console.table(result.recordset);

  } catch (err) {
    console.error('Gagal menjalankan skrip SQL:', err);
  } finally {
    // Pastikan koneksi ditutup
    sql.close();
    console.log('Koneksi database ditutup.');
  }
}

// Panggil fungsi utama
runScript();