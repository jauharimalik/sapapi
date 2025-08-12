# PM2 Service Monitor

Ini adalah proyek sederhana yang menggunakan **GitHub Actions** untuk memantau status layanan (service) yang berjalan dengan **PM2** di server `self-hosted` secara berkala.

Setiap satu menit, workflow ini akan mengambil status PM2, menyimpannya ke dalam file JSON statis, dan meng-update-nya di repository ini. Hasil dari monitoring ini dapat diakses secara publik melalui **GitHub Pages**.

---

## Fitur Utama

-   **Pemantauan Otomatis:** Workflow berjalan setiap 1 menit sesuai jadwal yang telah ditentukan.
-   **Output Statis:** Hasil status PM2 disimpan dalam format **JSON** ke file `pm2-status.json`.
-   **Akses Publik:** Data status dapat diakses melalui GitHub Pages, memungkinkan Anda untuk membangun dashboard monitoring publik tanpa harus login.

---

## Cara Kerja

1.  **Workflow GitHub Actions:** File `.github/workflows/monitor.yml` berisi skrip yang akan dijalankan.
2.  **Eksekusi Perintah:** Skrip akan terhubung ke runner `self-hosted` dan menjalankan perintah `pm2 jlist` untuk mendapatkan daftar layanan dalam format JSON.
3.  **Update File:** Output JSON tersebut diarahkan ke file `pm2-status.json`.
4.  **Commit dan Push:** Skrip kemudian akan melakukan `git commit` dan `git push` untuk meng-update file `pm2-status.json` di repository ini.
5.  **GitHub Pages:** Karena file `pm2-status.json` berada di repository dan GitHub Pages telah diaktifkan, file tersebut dapat diakses secara publik melalui URL.

---

## Cara Menggunakan

### 1. Prasyarat

-   Sebuah server dengan **GitHub Actions Runner** terinstal dan terdaftar sebagai `self-hosted`.
-   PM2 sudah terinstal secara global di server tersebut (`npm install -g pm2`).

### 2. Konfigurasi Repository

-   Pastikan Anda telah mengaktifkan **GitHub Pages** untuk repository ini. Anda bisa mengaturnya di menu **Settings > Pages**.
-   Berikan izin **"Read and write permissions"** pada token `GITHUB_TOKEN` di menu **Settings > Actions > General**. Ini penting agar workflow dapat melakukan `commit` ke repository.

### 3. File Workflow

Pastikan file workflow Anda (`.github/workflows/monitor.yml`) sudah sesuai dengan skrip berikut:

```yaml
# .github/workflows/monitor.yml
name: PM2 Service Monitor

on:
  schedule:
    - cron: '*/1 * * * *'
  workflow_dispatch:

jobs:
  monitor:
    runs-on: self-hosted
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Add npm global to PATH
        run: echo "C:\Users\PROGRAM-002\AppData\Roaming\npm" | Out-File -FilePath $env:GITHUB_PATH -Append -Encoding utf8
        shell: powershell
        
      - name: Get PM2 process status as JSON
        run: pm2 jlist > pm2-status.json

      - name: Commit and push status file
        run: |
          git config --global user.email "github-actions[bot]@users.noreply.github.com"
          git config --global user.name "github-actions[bot]"
          git add pm2-status.json
          git diff-index --quiet HEAD || git commit -m "Update PM2 service status"
          git push