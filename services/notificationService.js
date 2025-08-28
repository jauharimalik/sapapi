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

/**
 * Mengirim notifikasi ke WhatsApp dan Telegram.
 * Ini adalah fungsi utama untuk pengiriman notifikasi.
 */
exports.sendNotification = async (doNo, docNum, docEntry, note, isSuccess, pool) => {
    try {
        // Logika pengiriman WhatsApp
        const whatsAppSuccess = await sendWhatsApp(doNo, docNum, docEntry, note, isSuccess);

        // Logika pengiriman Telegram
        const telegramSuccess = await sendTelegram(note, isSuccess);

        // Update status database hanya jika salah satu notifikasi berhasil
        if (isSuccess && (whatsAppSuccess.success || telegramSuccess.success)) {
            await updateNotificationStatus(doNo, pool);
        } else if (!isSuccess) {
            // Jika gagal, reset status notifikasi
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
 * Mengirim notifikasi ke Telegram saja
 */
exports.sendTelegramNotification = async (note, isSuccess) => {
    try {
        const url = isSuccess ? TELEGRAM_CONFIG.successUrl : TELEGRAM_CONFIG.failureUrl;
        const message = note.replace(/\n/g, ' '); // Ganti baris baru dengan spasi untuk Telegram
        
        await axios.post(url, { message }, {
            timeout: 10000
        });

        console.log(`Notifikasi Telegram berhasil dikirim ke endpoint ${url}`);
        return {
            success: true
        };
    } catch (error) {
        console.error(`Gagal mengirim notifikasi Telegram ke endpoint ${url}:`, error.message);
        return {
            success: false,
            error: error.message
        };
    }
};

/**
 * Mengirim notifikasi ke WhatsApp.
 * Fungsi internal, tidak diekspor.
 */
async function sendWhatsApp(doNo, docNum, docEntry, note, isSuccess) {
    const groupId = isSuccess ? config.successGroup : config.failureGroup;
    const statusText = isSuccess ? 'SUCCESS' : 'FAILED';
    const message = formatWhatsAppMessage(doNo, docNum, docEntry, note, isSuccess, statusText);

    const form = new FormData();
    form.append('id_group', groupId);
    form.append('message', message);

    try {
        const response = await axios.post(config.apiUrl, form, {
            headers: {
                ...form.getHeaders(),
                'Accept': 'application/json'
            },
            timeout: 300000
        });

        console.log(`Notifikasi WhatsApp berhasil dikirim untuk DO ${doNo} ke grup ${groupId}`);
        return {
            success: true,
            messageId: response.data?.id || null
        };
    } catch (error) {
        console.error(`Gagal mengirim notifikasi WhatsApp untuk DO ${doNo}:`, {
            error: error.message,
            response: error.response?.data
        });
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * Mengirim notifikasi ke Telegram.
 * Fungsi internal, tidak diekspor.
 */
async function sendTelegram(note, isSuccess) {
    const url = isSuccess ? TELEGRAM_CONFIG.successUrl : TELEGRAM_CONFIG.failureUrl;
    const message = note.replace(/\n/g, ' '); // Ganti baris baru dengan spasi untuk Telegram
    
    try {
        await axios.post(url, { message }, {
            timeout: 10000
        });

        console.log(`Notifikasi Telegram berhasil dikirim ke endpoint ${url}`);
        return {
            success: true
        };
    } catch (error) {
        console.error(`Gagal mengirim notifikasi Telegram ke endpoint ${url}:`, error.message);
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * Memformat pesan untuk WhatsApp.
 */
function formatWhatsAppMessage(doNo, docNum, docEntry, note, isSuccess, statusText) {
    const header = `*DO CHECKER NOTIFICATION - ${statusText}*`;
    let docInfo = `*DO No:* ${doNo}`;

    if (docNum !== undefined && docNum !== null && docNum !== '') {
        docInfo += `\n*Doc Num:* ${docNum}`;
    }
    if (docEntry !== undefined && docEntry !== null && docEntry !== '') {
        docInfo += `\n*Doc Entry:* ${docEntry}`;
    }

    if (isSuccess) {
        return `${header}\n\n${docInfo}`;
    } else {
        const details = (note !== undefined && note !== null && note !== '') ? `\n\n*Details:*\n${note}` : '';
        return `${header}\n\n${docInfo}${details}`;
    }
}

/**
 * Memperbarui status notifikasi di database.
 */
async function updateNotificationStatus(doNo, pool) {
    try {
        await pool.request()
            .input('doNo', sql.Int, doNo)
            .query('UPDATE r_dn_coldspace SET iswa = 1 WHERE do_no = @doNo');
    } catch (error) {
        console.error(`Gagal update status notifikasi untuk DO ${doNo}:`, error.message);
    }
}

/**
 * Mereset status notifikasi di database.
 */
async function resetNotificationStatus(doNo, pool) {
    try {
        await pool.request()
            .input('doNo', sql.Int, doNo)
            .query('UPDATE r_dn_coldspace SET iswa = 0 WHERE do_no = @doNo');
    } catch (error) {
        console.error(`Gagal reset status notifikasi untuk DO ${doNo}:`, error.message);
    }
}