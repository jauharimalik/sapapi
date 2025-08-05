# Proyek SAP API Integration

Proyek ini berisi serangkaian server Node.js yang berfungsi sebagai API untuk mengintegrasikan berbagai proses bisnis dengan sistem SAP. Aplikasi ini mengelola fungsionalitas seperti `Delivery Note`, `Tukar Guling`, `Retur`, `Rejection`, dan `STO`.

---

## Cara Menjalankan Aplikasi

Anda dapat menjalankan semua server secara otomatis atau manual. Metode otomatis sangat disarankan untuk memastikan semua server berjalan dengan kode terbaru.

### 1. Metode Otomatis (Direkomendasikan)

Gunakan skrip `csx.bat` untuk menjalankan deployment secara lengkap. Skrip ini akan:
1.  Menghentikan semua proses Node.js yang sedang berjalan.
2.  Mengambil pembaruan kode terbaru dari repositori Git.
3.  Memulai ulang semua server Node.js menggunakan `nodemon` secara *background*.

Jalankan perintah berikut di Command Prompt:
```bash
csx.bat

# Untuk Delivery Note
nodemon server.js

# Untuk Tukar Guling
nodemon guling.js

# Untuk Retur
nodemon retur.js

# Untuk Rejection
nodemon rijek.js

# Untuk STO
nodemon sto.js

Konfigurasi
Semua konfigurasi penting untuk koneksi ke database, layanan SAP, dan WhatsApp disimpan dalam file terpisah. Pastikan Anda menyesuaikan nilai-nilai di bawah ini dengan setelan di lingkungan perusahaan Anda.

config.js
File ini berisi konfigurasi untuk koneksi ke database SQL Server.

