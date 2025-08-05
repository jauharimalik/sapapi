const notificationService = require('../services/notificationService');

exports.sendTestNotification = async (req, res) => {
  try {
    const form = new FormData();
    form.append('id_group', req.config.successGroup);
    form.append('message', 'TEST FORM DATA dari NodeJS');

    const response = await notificationService.sendWhatsAppMessage(form);
    res.json({
      status: 'success',
      responseData: response.data
    });
  } catch (error) {
    console.error('Test Error:', error);
    res.status(500).json({
      status: 'error',
      error: {
        message: error.message,
        response: error.response?.data,
        stack: error.stack
      }
    });
  }
};

exports.sendSuccessNotifications = async (req, res) => {
  try {
    const result = await req.pool.request()
      .query(`SELECT DO_NO, doc_num, doc_entry, note 
              FROM [appsrv].db_pandurasa.dbo.r_dn_coldspace WITH (NOLOCK) 
              WHERE jo_status = 3 and del_date >= '2025-07-01'
              ORDER BY DO_NO ASC`);

    const successDOs = result.recordset;
    
    if (!successDOs || successDOs.length === 0) {
      return res.json({ 
        status: 'empty', 
        message: 'No DOs with status 3 found' 
      });
    }

    const notificationResults = [];
    
    for (const doItem of successDOs) {
      try {
        const notificationSent = await notificationService.sendWhatsAppNotification(
          doItem.DO_NO,
          doItem.doc_num,
          doItem.doc_entry,
          doItem.note || '[PROCESSED] Berhasil diproses ke SAP',
          true,
          req.pool
        );

        notificationResults.push({
          do_no: doItem.DO_NO,
          status: notificationSent ? 'success' : 'failed',
          message: notificationSent ? 'Notification sent' : 'Failed to send notification'
        });
      } catch (error) {
        console.error(`Failed to send notification for DO ${doItem.DO_NO}:`, error.message);
        notificationResults.push({
          do_no: doItem.DO_NO,
          status: 'error',
          message: error.message
        });
      }
    }

    res.json({
      status: 'complete',
      processedCount: successDOs.length,
      results: notificationResults
    });

  } catch (error) {
    console.error('Error in sendSuccessNotifications:', error.message);
    res.status(500).json({ 
      error: `Request failed: ${error.message}`,
      details: error.stack 
    });
  }
};