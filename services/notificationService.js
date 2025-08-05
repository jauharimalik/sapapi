const axios = require('axios');
const FormData = require('form-data');
const config = require('../config/whatsappConfig');
const sql = require('mssql');

exports.sendWhatsAppNotification = async (doNo, docNum, docEntry, note, isSuccess, pool) => {
  const groupId = isSuccess ? config.successGroup : config.failureGroup;
  const statusText = isSuccess ? 'SUCCESS' : 'FAILED';
  
  try {
    // Format pesan WhatsApp
    const message = formatWhatsAppMessage(doNo, docNum, docEntry, note, isSuccess, statusText);

    // Gunakan FormData untuk mengirim pesan
    const form = new FormData();
    form.append('id_group', groupId);
    form.append('message', message);

    // Kirim pesan ke API WhatsApp
    const response = await axios.post(config.apiUrl, form, {
      headers: {
        ...form.getHeaders(),
        'Accept': 'application/json'
      },
      timeout: 300000
    });

    console.log('------------------------------------------------------------------------------------');
    console.log(`WhatsApp notification sent for DO ${doNo} to group ${groupId}`);

    // Update status iswa jika sukses
    if (isSuccess) {
      await updateNotificationStatus(doNo, pool);
    }

    return {
      success: true,
      messageId: response.data?.id || null
    };
  } catch (error) {
    console.error(`Failed to send WhatsApp notification for DO ${doNo}:`, {
      error: error.message,
      response: error.response?.data
    });
    
    await updateNotificationStatus(doNo, pool);
    return {
      success: false,
      error: error.message
    };
  }
};

exports.sendWhatsAppMessage = async (formData) => {
  try {
    const response = await axios.post(config.apiUrl, formData, {
      headers: {
        ...formData.getHeaders(),
        'Accept': 'application/json'
      },
      timeout: 300000
    });
    return response.data;
  } catch (error) {
    console.error('Failed to send WhatsApp message:', error.message);
    throw error;
  }
};
function formatWhatsAppMessage(doNo, docNum, docEntry, note, isSuccess, statusText) {
  const header = `*DO CHECKER NOTIFICATION - ${statusText}*`;
  
  let docInfo = `*DO No:* ${doNo}`
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

async function updateNotificationStatus(doNo, pool) {
  try {
    await pool.request()
      .input('doNo', sql.Int, doNo)
      .query('UPDATE r_dn_coldspace SET iswa = 1 WHERE do_no = @doNo');
  } catch (error) {
    console.error(`Failed to update notification status for DO ${doNo}:`, error.message);
  }
}

async function resetNotificationStatus(doNo, pool) {
  try {
    // await pool.request()
    //   .input('doNo', sql.Int, doNo)
    //   .query('UPDATE r_dn_coldspace SET iswa = NULL WHERE do_no = @doNo');
    
    await pool.request()
      .input('doNo', sql.Int, doNo)
      .query('UPDATE r_dn_coldspace SET iswa = 1 WHERE do_no = @doNo');
  } catch (error) {
    console.error(`Failed to reset notification status for DO ${doNo}:`, error.message);
  }
}