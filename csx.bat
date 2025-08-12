@echo off
rem =======================================================
rem Skrip Deployment Aplikasi Node.js tanpa PM2
rem Semua proses akan berjalan di latar belakang jendela ini.
rem =======================================================

echo Memulai proses deployment...
echo ----------------------------------------

rem --- Langkah 1: Pindah ke direktori aplikasi ---
rem Ganti 'C:\jalur\ke\proyek' dengan jalur direktori proyek Anda
echo Pindah ke direktori aplikasi...
cd /d C:\jalur\ke\proyek\sapapi

rem --- Langkah 2: Tarik kode terbaru dari Git ---
echo Menarik kode terbaru dari repositori Git...
git pull

rem --- Langkah 3: Menghentikan proses Node.js yang berjalan sebelumnya (opsional) ---
rem Skrip ini tidak secara otomatis menghentikan proses sebelumnya.
rem Anda harus menghentikannya secara manual atau menggunakan alat lain.
echo Skrip ini tidak menghentikan proses Node.js yang sudah berjalan.
echo Proses akan dimulai kembali dan berjalan di latar belakang jendela ini.

rem --- Langkah 4: Mulai semua aplikasi Node.js dalam satu jendela ---
echo Memulai semua aplikasi Node.js...

rem Mulai server.js (Delivery Note)
echo Memulai DeliveryNote...
start /b node server.js

rem Mulai guling.js (Tukar Guling)
echo Memulai TukarGuling...
start /b node guling.js

rem Mulai retur.js (Retur)
echo Memulai Retur...
start /b node retur.js

rem Mulai rijek.js (Rejection)
echo Memulai Rejection...
start /b node rijek.js

rem Mulai sto.js (STO)
echo Memulai STO...
start /b node sto.js

rem Mulai prod.js
echo Memulai prod-service...
start /b node prod.js

rem Mulai grpo.js
echo Memulai grpo-service...
start /b node grpo.js

echo ----------------------------------------
echo Deployment selesai.
echo Semua aplikasi Node.js berjalan di latar belakang jendela ini.
echo Jika Anda menutup jendela ini, semua aplikasi akan berhenti.
echo Untuk melihat output, periksa file log atau ubah start /b menjadi start.