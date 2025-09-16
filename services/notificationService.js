const axios = require('axios');
const FormData = require('form-data');
const config = require('../config/whatsappConfig');
const sql = require('mssql');

// --- Konfigurasi Telegram ---
const TELEGRAM_CONFIG = {
    successUrl: 'http://192.168.100.202:40200/group-cs-success',
    failureUrl: 'http://192.168.100.202:40200/group-cs-error'
};
// --- Akhir Konfigurasi ---

// Helper sleep
function sleep(ms = 1000) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Helper untuk delay 30 detik sebelum kirim notifikasi
async function delayBeforeSend() {
    console.log('Menunggu 30 detik sebelum mengirim notifikasi...');
    await sleep(30000);
}

/**
 * Fungsi utama untuk mengirim notifikasi WA dan Telegram
 */
exports.sendNotification = async (doNo, docNum, docEntry, note, isSuccess, pool) => {
    try {
        // Jika note mengandung kata "closed" (case-insensitive)
        if (note && note.toLowerCase().includes('closed')) {
            console.log(`Note mengandung 'closed'. Update massal data...`);
            await updateMassalClosed(pool);
            note = 'Successfully posted to SAP'; // ubah note yang dikirim
        }

        // Jeda 30 detik sebelum mulai mengirimkan pesan untuk per DO_NO
        await delayBeforeSend();

        // Kirim WhatsApp
        const whatsAppSuccess = await sendWhatsApp(doNo, docNum, docEntry, note, isSuccess);
        await sleep(1000); // jeda 1 detik antar pengiriman

        // Kirim Telegram
        const telegramSuccess = await sendTelegram(note, isSuccess);
        await sleep(1000); // jeda 1 detik antar pengiriman

        // Update status database
        if (isSuccess && (whatsAppSuccess.success || telegramSuccess.success)) {
            await updateNotificationStatus(doNo, pool);
        } else if (!isSuccess) {
            await resetNotificationStatus(doNo, pool);
        }

        return {
            success: whatsAppSuccess.success || telegramSuccess.success,
            whatsAppMessageId: whatsAppSuccess.messageId,
            error: whatsAppSuccess.error || telegramSuccess.error
        };
    } catch (error) {
        console.error(`Terjadi kesalahan fatal saat mengirim notifikasi untuk DO ${doNo}:`, error.message);
        return {
            success: false,
            error: error.message
        };
    }
};

/**
 * Fungsi pengecekan dokumen baru (dijeda setiap 1 menit)
 * - Looping terus menerus
 * - Hanya cek API SAP setiap 1 menit
 */
exports.startDocumentChecker = async (checkFunction) => {
    console.log('Memulai pengecekan dokumen baru setiap 1 menit...');
    
    // Tambahkan flag untuk mengontrol eksekusi
    let isProcessing = false;
    
    while (true) {
        try {
            if (!isProcessing) {
                isProcessing = true;
                await checkFunction(); // jalankan fungsi cek dokumen
                isProcessing = false;
            }
        } catch (err) {
            isProcessing = false;
            console.error('Error saat pengecekan dokumen:', err.message);
        }
        
        console.log('Menunggu 1 menit sebelum pengecekan berikutnya...');
        await sleep(60000); // delay 1 menit
    }
};
/**
 * Mengirim notifikasi Telegram saja
 */
exports.sendTelegramNotification = async (note, isSuccess) => {
    const url = isSuccess ? TELEGRAM_CONFIG.successUrl : TELEGRAM_CONFIG.failureUrl;
    try {
        await delayBeforeSend(); // delay 30 detik sebelum kirim Telegram
        const message = note.replace(/\n/g, ' ');
        await axios.post(url, { message }, { timeout: 10000 });
        console.log(`Notifikasi Telegram berhasil dikirim ke endpoint ${url}`);
        return { success: true };
    } catch (error) {
        console.error(`Gagal mengirim notifikasi Telegram ke endpoint ${url}:`, error.message);
        return { success: false, error: error.message };
    }
};

/**
 * Mengirim notifikasi WhatsApp
 */
// exports.sendWhatsApp  = async (doNo, docNum, docEntry, note, isSuccess)=>{
//     const groupId = isSuccess ? config.successGroup : config.failureGroup;
//     const statusText = isSuccess ? 'SUCCESS' : 'FAILED';
//     const message = formatWhatsAppMessage(doNo, docNum, docEntry, note, isSuccess, statusText);

//     const form = new FormData();
//     form.append('id_group', groupId);
//     form.append('message', message);

//     try {
//         const response = await axios.post(config.apiUrl, form, {
//             headers: { ...form.getHeaders(), 'Accept': 'application/json' },
//             timeout: 300000
//         });
//         console.log(`Notifikasi WhatsApp berhasil dikirim untuk DO ${doNo} ke grup ${groupId}`);
//         return { success: true, messageId: response.data?.id || null };
//     } catch (error) {
//         console.error(`Gagal mengirim notifikasi WhatsApp untuk DO ${doNo}:`, {
//             error: error.message,
//             response: error.response?.data
//         });
//         return { success: false, error: error.message };
//     }
// }
exports.sendWhatsApp  = async (doNo, docNum, docEntry, note, isSuccess)=>{
    // Pilih endpoint berdasarkan status
    const url = isSuccess ? config.successUrl : config.failureUrl;

    const message = formatWhatsAppMessage(doNo, docNum, docEntry, note, isSuccess);
    try {
        const response = await axios.post(url, { message }, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 300000
        });
        console.log(`Notifikasi WhatsApp berhasil dikirim untuk DO ${doNo} ke endpoint ${url}`);
        return { success: true, messageId: response.data?.id || null };
    } catch (error) {
        console.error(`Gagal mengirim notifikasi WhatsApp untuk DO ${doNo}:`, {
            error: error.message,
            status: error.response?.status,
            response: error.response?.data
        });
        return { success: false, error: error.message };
    }
}

/**
 * Mengirim notifikasi Telegram
 */
async function sendTelegram(note, isSuccess) {
    const url = isSuccess ? TELEGRAM_CONFIG.successUrl : TELEGRAM_CONFIG.failureUrl;
    const message = note.replace(/\n/g, ' ');

    try {
        await axios.post(url, { message }, { timeout: 10000 });
        console.log(`Notifikasi Telegram berhasil dikirim ke endpoint ${url}`);
        return { success: true };
    } catch (error) {
        console.error(`Gagal mengirim notifikasi Telegram ke endpoint ${url}:`, error.message);
        return { success: false, error: error.message };
    }
}

/**
 * Format pesan untuk WhatsApp
 */
function formatWhatsAppMessage(doNo, docNum, docEntry, note, isSuccess, statusText) {
    const header = `*DO CHECKER NOTIFICATION - ${statusText}*`;
    let docInfo = `*DO No:* ${doNo}`;
    if (docNum) docInfo += `\n*Doc Num:* ${docNum}`;
    if (docEntry) docInfo += `\n*Doc Entry:* ${docEntry}`;
    const details = (!isSuccess && note) ? `\n\n*Details:*\n${note}` : '';
    return `${header}\n\n${docInfo}${details}`;
}

/**
 * Update status notifikasi di database
 */
async function updateNotificationStatus(doNo, pool) {
    try {
        await pool.request().input('doNo', sql.Int, doNo)
            .query('UPDATE r_dn_coldspace SET iswa = 1 WHERE do_no = @doNo');
    } catch (error) {
        console.error(`Gagal update status notifikasi untuk DO ${doNo}:`, error.message);
    }
}

/**
 * Reset status notifikasi di database
 */
async function resetNotificationStatus(doNo, pool) {
    try {
        await pool.request().input('doNo', sql.Int, doNo)
            .query('UPDATE r_dn_coldspace SET iswa = 0 WHERE do_no = @doNo');
    } catch (error) {
        console.error(`Gagal reset status notifikasi untuk DO ${doNo}:`, error.message);
    }
}

/**
 * Update massal jika note mengandung 'closed'
 */
async function updateMassalClosed(pool) {
    try {
        await pool.request().query(`
            UPDATE r_dn_coldspace
            SET jo_status = 3,
                note = 'Successfully posted to SAP'
            WHERE docnum IS NOT NULL 
              AND doc_entry IS NOT NULL
              AND note LIKE '%closed%'
        `);
        console.log('Update massal berhasil untuk data yang note mengandung "closed".');
    } catch (error) {
        console.error('Gagal melakukan update massal:', error.message);
    }
}
