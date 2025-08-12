#!/bin/bash

# =======================================================
# Skrip Deployment Aplikasi Node.js dengan PM2
# =======================================================

echo "Memulai proses deployment..."
echo "----------------------------------------"

# --- Langkah 1: Pindah ke direktori aplikasi ---
# Ganti '/var/www/sapapi' dengan jalur direktori proyek Anda
echo "Pindah ke direktori aplikasi..."
cd /var/www/sapapi

# --- Langkah 2: Tarik kode terbaru dari Git ---
echo "Menarik kode terbaru dari repositori Git..."
git pull

# --- Langkah 3: Hentikan dan hapus semua proses PM2 yang ada ---
echo "Menghentikan dan menghapus semua proses PM2 yang berjalan..."
pm2 stop all
pm2 delete all

# --- Langkah 4: Mulai kembali semua aplikasi Node.js dengan PM2 ---
echo "Memulai semua aplikasi Node.js dengan PM2..."

# Mulai server.js (Delivery Note)
pm2 start server.js --name "DeliveryNote" --watch --ignore-watch "node_modules"

# Mulai guling.js (Tukar Guling)
pm2 start guling.js --name "TukarGuling" --watch --ignore-watch "node_modules"

# Mulai retur.js (Retur)
pm2 start retur.js --name "Retur" --watch --ignore-watch "node_modules"

# Mulai rijek.js (Rejection)
pm2 start rijek.js --name "Rejection" --watch --ignore-watch "node_modules"

# Mulai sto.js (STO)
pm2 start sto.js --name "STO" --watch --ignore-watch "node_modules"

# Mulai prod.js (Tambahan dari contoh GitHub Actions)
pm2 start prod.js --name "prod-service" --watch --ignore-watch "node_modules"

# Mulai grpo.js (Tambahan dari contoh GitHub Actions)
pm2 start grpo.js --name "grpo-service" --watch --ignore-watch "node_modules"


# --- Langkah 5: Simpan daftar proses PM2 agar dapat dipulihkan setelah reboot ---
echo "Menyimpan daftar proses PM2..."
pm2 save

echo "----------------------------------------"
echo "Deployment selesai."
echo "Aplikasi Node.js sekarang berjalan di latar belakang."
echo "Status PM2 saat ini:"
pm2 list