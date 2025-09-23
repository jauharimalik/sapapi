const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const mime = require('mime-types');
const sql = require('mssql');
const config = require('../config/whatsappConfig');

const WHATSAPP_PERSONAL_NUMBER = '085781550337';
const TELEGRAM_CONFIG = {
    // Anda harus mengisi TELEGRAM_CHAT_ID yang benar di sini.
    // Contoh: 'TELEGRAM_CHAT_ID': '-1002030113192'
    successUrl: 'http://192.168.100.202:40200/group-cs-success',
    failureUrl: 'http://162.168.100.202:40200/group-cs-error'
};


function sleep(ms = 100) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function delayBeforeSend() {
    await sleep(100); // Jeda dikurangi menjadi 100ms
}

exports.sendNotification = async (doNo, docNum, docEntry, note, isSuccess, pool) => {
    try {
        if (note && note.toLowerCase().includes('closed')) {
            await updateMassalClosed(pool);
            note = 'Successfully posted to SAP';
        }

        await delayBeforeSend();

        const whatsAppSuccess = await exports.sendWhatsApp(doNo, docNum, docEntry, note, isSuccess);
        await sleep(100);

        const telegramSuccess = await exports.sendTelegramNotification(note, isSuccess);
        await sleep(100);

        if (isSuccess && (whatsAppSuccess.success || telegramSuccess.success)) {
            await updateNotificationStatus(doNo, pool);
        }

        return {
            success: whatsAppSuccess.success || telegramSuccess.success,
            whatsAppMessageId: whatsAppSuccess.messageId,
            error: whatsAppSuccess.error || telegramSuccess.error
        };
    } catch (error) {
        return {
            success: false,
            error: error.message
        };
    }
};

exports.startDocumentChecker = async (checkFunction) => {
    let isProcessing = false;

    while (true) {
        try {
            if (!isProcessing) {
                isProcessing = true;
                await checkFunction();
                isProcessing = false;
            }
        } catch (err) {
            isProcessing = false;
        }

        await sleep(300);
    }
};

exports.sendTelegramNotification = async (note, isSuccess) => {
    const statusText = isSuccess ? 'SUCCESS' : 'FAILURE';
    const message = `*DO CHECKER NOTIFICATION - ${statusText}*\n\n${note}`;
    const url = isSuccess ? TELEGRAM_CONFIG.successUrl : TELEGRAM_CONFIG.failureUrl;
    
    try {
        const response = await axios.post(url, { message });
        return { success: response.status === 200, error: null };
    } catch (error) {
        console.error('Failed to send Telegram notification:', error.message);
        return { success: false, error: error.message };
    }
};

exports.sendWhatsApp = async (doNo, docNum, docEntry, note, isSuccess) => {
    const statusText = isSuccess ? 'SUCCESS' : 'FAILURE';
    const message = formatWhatsAppMessage(doNo, docNum, docEntry, note, isSuccess, statusText);

    try {
        return { success: true, messageId: 1 ?? 'N/A' };
        
        // const result = await sendToWhatsAppAPI(WHATSAPP_PERSONAL_NUMBER, message);
        // if (result && result.status) {
        //     return { success: true, messageId: result.data ? result.data.id : 'N/A' };
        // } else {
        //     return { success: false, error: result ? result.message : 'Unknown error from WhatsApp API' };
        // }
    } catch (err) {
        return { success: false, error: err.message };
    }
};

async function sendToWhatsAppAPI(number, message, filePath = null) {
    try {
        if (number.startsWith('62')) number = '0' + number.slice(2);

        const formData = new FormData();
        formData.append('number', number);
        formData.append('message', message);

        if (filePath && fs.existsSync(filePath)) {
            const mimeType = mime.lookup(filePath) || 'application/octet-stream';
            formData.append('file_dikirim', fs.createReadStream(filePath), { filename: path.basename(filePath), contentType: mimeType });
        }

        const response = await axios.post('http://103.169.73.3:4040/send-message', formData, {
            headers: formData.getHeaders(),
            maxBodyLength: Infinity,
            maxContentLength: Infinity
        });

        if (response.data?.status) {
            console.log('-------------------------------------------------------\nWhatsApp terkirim ke', number);
            if (filePath) console.log('-------------------------------------------------------\nFile terlampir:', filePath);
        } else {
            console.log('-------------------------------------------------------\nWhatsApp gagal terkirim ke', number, response.data);
        }

        return response.data;
    } catch (err) {
        console.log('-------------------------------------------------------\nGagal mengirim WhatsApp ke', number, err.message);
        return null;
    }
}

function formatWhatsAppMessage(doNo, docNum, docEntry, note, isSuccess, statusText) {
    const header = `*DO CHECKER NOTIFICATION - ${statusText}*`;
    let docInfo = `*DO No:* ${doNo}`;
    if (docNum) docInfo += `\n*Doc Num:* ${docNum}`;
    if (docEntry) docInfo += `\n*Doc Entry:* ${docEntry}`;
    const details = (!isSuccess && note) ? `\n\n*Details:*\n${note}` : '';
    return `${header}\n\n${docInfo}${details}`;
}

async function updateNotificationStatus(doNo, pool) {
    try {
        await pool.request().input('doNo', sql.Int, doNo)
            .query('UPDATE r_dn_coldspace SET iswa = 1 WHERE do_no = @doNo');
    } catch (error) {
    }
}

async function resetNotificationStatus(doNo, pool) {
    try {
        await pool.request().input('doNo', sql.Int, doNo)
            .query('UPDATE r_dn_coldspace SET iswa = 0 WHERE do_no = @doNo');
    } catch (error) {
    }
}

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
    } catch (error) {
    }
}