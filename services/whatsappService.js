const axios = require('axios');
const FormData = require('form-data');
const { WHATSAPP_CONFIG } = require('../utils/constants');

const formatWhatsAppMessage = (poNo, docNum, docEntry, note, isSuccess, statusText) => {
    const header = `*Tukar Guling - ${statusText}*`;
    let docInfo = `*PO No:* ${poNo}`;
    if (docNum) docInfo += `\n*Doc Num:* ${docNum}`;
    if (docEntry) docInfo += `\n*Doc Entry:* ${docEntry}`;
    
    return isSuccess
        ? `${header}\n\n${docInfo}`
        : `${header}\n\n${docInfo}\n\n*Details:*\n${note}`;
};

const sendWhatsApp = async (groupId, message) => {
    const form = new FormData();
    form.append('id_group', groupId);
    form.append('message', message);

    try {
        const response = await axios.post(WHATSAPP_CONFIG.apiUrl, form, {
            headers: {
                ...form.getHeaders(),
                'Accept': 'application/json'
            },
            timeout: 10000
        });
        return response.data;
    } catch (error) {
        throw new Error('Gagal mengirim notifikasi WhatsApp.');
    }
};

module.exports = {
    formatWhatsAppMessage,
    sendWhatsApp,
};