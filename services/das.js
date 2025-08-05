const sapService = require('./sapService');
const dbService = require('./dbService');
const sql = require('mssql');
const notificationService = require('./notificationService');


exports.checkSingleDO = async (doNo, pool) => {  
  let docEntry, docNum;
  
  try {
    // 1. Cek informasi dokumen
    const docInfoQuery = `
      SELECT t3.docentry as doc_entry, t3.DocNum as doc_num
      FROM [pksrv-sap].test.dbo.ORDR T0 WITH (NOLOCK)
      INNER JOIN [pksrv-sap].test.dbo.RDR1 T1 WITH (NOLOCK) ON T0.DocEntry = T1.DocEntry 
      LEFT JOIN [pksrv-sap].test.dbo
      .DLN1 T2 WITH (NOLOCK) ON T2.BaseEntry = T1.DocEntry AND T2.BaseLine = T1.LineNum AND T2.BaseType = 17
      LEFT JOIN [pksrv-sap].test.dbo.ODLN T3 WITH (NOLOCK) ON T2.DocEntry = T3.DocEntry
      WHERE t0.docnum = @doNo`;
    
    const docInfoResult = await pool.request()
      .input('doNo', sql.Int, doNo)
      .query(docInfoQuery);
    
    const docInfo = docInfoResult.recordset[0] || {};
    docEntry = docInfo.doc_entry || null;
    docNum = docInfo.doc_num || null;
    let allValid = true;

    // 2. Check if DO exists in the goods issue query
    const goodsIssueQuery = `
      SELECT  
        COMP_CODE, DO_NO, TRIM(STO_NO) STO_NO, ORDER_TYPE, DO_DATE, DEL_DATE, SUP_SITE, [SITE], LINE_NO, SKU, ItemName,
        SUM(QTY) AS QTY, QTY_BATCH, LOT, BATCHNUM, PRICE, ADDRESS1 AS ADDRESS, ADDRESS2, URGENT, ETA, GENCOMM, 
        CUST_INST, OUTLEDID AS OUTLETID, PO_EXPIRY_DATE, MED_TYPE, MED_REASON, [CONSIGNEE_DESC], Series
      FROM (
        SELECT DISTINCT 
          CASE  
            WHEN T3.FromWhsCod = 'CS-03' THEN '1108'
            WHEN T11.[Location] = 1 THEN '1109'  
            WHEN T11.[Location] = 2 THEN '1110' 
            ELSE '1107'
          END AS COMP_CODE,
          T2.[DocNum] AS DO_NO,
          LEFT(T2.COMMENTS, 10) AS STO_NO,
          CASE 
            WHEN T10.SeriesName LIKE 'RF%' THEN 'SMPL'
            WHEN T10.SeriesName LIKE 'LS%' THEN 'LSTG'
            WHEN T10.SeriesName LIKE 'TG%' THEN 'RPLC'
          END AS ORDER_TYPE,
          CAST(CONVERT(DATE, T2.DocDate) AS VARCHAR) AS DO_DATE,
          CAST(CONVERT(DATE, T2.DocDueDate) AS VARCHAR) AS DEL_DATE, 
          T2.Filler AS SUP_SITE, 
          CASE
            WHEN T2.CardCode IS NULL THEN (isnull((
                select top 1 site from [appsrv].db_pandurasa.dbo.r_dn_coldspace csx where csx.do_no = t2.docnum
            ),'VIRTUAL') COLLATE SQL_Latin1_General_CP1_CI_AS) -- Apply COLLATE here
            ELSE T2.CardCode COLLATE SQL_Latin1_General_CP1_CI_AS -- Apply COLLATE here
          END AS [SITE],
          T3.LineNum AS LINE_NO,
          T3.[ItemCode] AS SKU,
          T5.ItemName,
          SUM(T6.Quantity) AS QTY,
          CONVERT(VARCHAR(10), T7.ExpDate, 12) AS LOT,
          T3.PRICE,
          '' AS ADDRESS1, 
          '' AS ADDRESS2,
          '' AS URGENT,
          '' AS ETA,
          '' AS GENCOMM,
          '' AS CUST_INST,
          CASE 
            WHEN T2.CardCode IS NULL THEN T11.WhsName 
            ELSE T2.CardCode 
          END AS OUTLEDID,
          CONVERT(VARCHAR(10), T2.[DocDate] + 7, 112) AS PO_EXPIRY_DATE,
          2 AS MED_TYPE,
          CASE 
            WHEN T10.SeriesName LIKE 'RF%' THEN 'SAMPLE'
            WHEN T10.SeriesName LIKE 'LS%' THEN 'LISTING'
            WHEN T10.SeriesName LIKE 'TG%' THEN 'TUKAR GULING'
          END MED_REASON,
          CASE 
            WHEN T2.CardName IS NULL THEN T11.WhsName 
            WHEN T2.CardCode IS NULL THEN T11.WhsName
            ELSE T2.CardCode 
          END AS [CONSIGNEE_DESC],
          T6.BATCHNUM,
          T6.Quantity QTY_BATCH,
           CASE 
            WHEN T10.SeriesName LIKE 'RF%' THEN 684
            WHEN T10.SeriesName LIKE 'LS%' THEN 682
            WHEN T10.SeriesName LIKE 'TG%' THEN 685
          END Series
        FROM [PKSRV-SAP].[test].DBO.OWTR T2 WITH (NOLOCK)
        INNER JOIN [PKSRV-SAP].[test].DBO.WTR1 T3 WITH (NOLOCK) ON T2.[DocEntry] = T3.[DocEntry]
        INNER JOIN [PKSRV-SAP].[test].DBO.OITM T5 WITH (NOLOCK) ON T3.ItemCode = T5.ItemCode
        LEFT JOIN [PKSRV-SAP].[test].DBO.OWHS T11 WITH (NOLOCK) ON T3.FromWhsCod = T11.WhsCode AND T11.[Location] IS NOT NULL
        INNER JOIN [PKSRV-SAP].[test].DBO.NNM1 T10 WITH (NOLOCK) ON T2.Series = T10.Series
        LEFT JOIN (
          SELECT T6.ITEMCODE, BATCHNUM, BASEENTRY, BASENUM, BSDOCENTRY, BASELINNUM, T6.Quantity, BASETYPE
          FROM [PKSRV-SAP].[test].DBO.IBT1 T6 WITH (NOLOCK)
        ) T6 ON T3.DocEntry = T6.BaseEntry AND T6.BaseType = 67 AND T3.ItemCode = T6.ItemCode and T6.BaseType = 67 
        LEFT JOIN [PKSRV-SAP].[test].DBO.OBTN T7 WITH (NOLOCK) ON T6.ItemCode = T7.ItemCode AND T6.BatchNum = T7.DistNumber
        WHERE T2.Docnum = @doNo and CONVERT(date, T2.DocDate) > '2025-07-01'
        GROUP BY T3.[ItemCode], T5.FrgnName, T2.DocDueDate, T3.[Dscription], T5.[FrgnName], T3.[WhsCode], T2.Filler, T11.WhsName, 
          T3.LineNum, T6.BatchNum, T3.UomCode, PRICE, CardName, T2.[DocDate], T2.[DocNum], T7.ExpDate, T5.ItemName, 
          T11.[Location], T2.COMMENTS, T10.SeriesName, T2.CardCode, T3.FromWhsCod, T5.ItemName, T10.Series, T6.BATCHNUM, T6.Quantity
      ) po 
      GROUP BY COMP_CODE, DO_NO, STO_NO, ORDER_TYPE, DO_DATE, DEL_DATE, SUP_SITE, [SITE], LINE_NO, SKU, ItemName, QTY, 
        LOT, PRICE, ADDRESS1, ADDRESS2, URGENT, ETA, GENCOMM, CUST_INST, OUTLEDID, PO_EXPIRY_DATE, MED_TYPE, 
        MED_REASON, [CONSIGNEE_DESC], Series, BATCHNUM, QTY_BATCH`;

    const goodsIssueResult = await pool.request()
      .input('doNo', sql.Int, doNo)
      .query(goodsIssueQuery);

    if (goodsIssueResult.recordset.length === 0) {
        // No goods issue data found, continue to next process
        // 2. Dapatkan data order dari SAP
        
        //check production dulu
        const orderData = await sapService.getOrderFromSAP(doNo,pool);
        // console.log(orderData);
        if (!orderData) {
        await this.updateDOStatusWithNote(doNo, null, 0, {
            type: 'DOCUMENT_NOT_FOUND',
            docNum: doNo,
            docEntry: docEntry
        }, pool);
        return { status: 'error', message: `No order found with DocNum: ${doNo}` };
        }

        // Enhanced validation before processing to SAP
        const validationResult = await this.validateOrderData(doNo, orderData, pool);
        if (!validationResult.isValid) {
            await this.updateDOStatusWithNote(doNo, null, 0, {
                type: 'VALIDATION_FAILED',
                message: validationResult.message,
                docNum: doNo,
                docEntry: docEntry
            }, pool);
            return { status: 'error', message: validationResult.message };
        }

        // 3. Validasi data Coldspace vs SAP
        const coldspaceData = await pool.request()
        .input('doNo', sql.Int, doNo)
        .query('SELECT * FROM r_dn_coldspace WITH (NOLOCK) WHERE DO_NO = @doNo ORDER BY LineNum');

        // 4. Jika semua valid, proses ke SAP
        if (allValid) {
            const sapResult = await sapService.postDeliveryNoteToSAP(doNo, pool);
            
            return {
                status: sapResult.status === 'success' ? 'processed' : 'matched_but_failed',
                message: sapResult.message
            };
        }

      return { status: 'no_goods_issue', message: `No goods issue data found for DO: ${doNo}` };
    } else {
        // 3. Prepare the JSON payload for InventoryGenExits
        const firstRecord = goodsIssueResult.recordset[0];
        const groupedItems = goodsIssueResult.recordset.reduce((acc, item) => {
          const key = `${item.SKU}-${item.LINE_NO}`;
            if (!acc[key]) {
                acc[key] = {
                    "ItemCode": item.SKU,
                    "Quantity": 0,
                    "WarehouseCode": item.SITE === 'VIRTUAL' ? 'CS-03' : item.SITE,
                    "AccountCode": "101120103",
                    "BatchNumbers": []
                };
            }

            if (item.BATCHNUM) {
                const batchQuantity = Math.abs(item.QTY_BATCH);
                acc[key].BatchNumbers.push({
                    "BatchNumber": item.BATCHNUM,
                    "Quantity": batchQuantity
                });
                acc[key].Quantity += batchQuantity;
            } else {
                acc[key].Quantity += Math.abs(item.QTY);
            } return acc;
        }, {});
            
        const documentLines = Object.values(groupedItems);
        const payload = {
            "DocDate": firstRecord.DO_DATE,
            "DocDueDate": firstRecord.DEL_DATE,
            "Ref1":doNo.toString(),
            "U_Ref_CS":doNo,
            "TaxDate": firstRecord.DO_DATE,
            "Comments": firstRecord.STO_NO +" Dari DO_NO :"+doNo,
            "JournalMemo": "Goods Issue",
            "Series": firstRecord.Series,
            "DocObjectCode": "oInventoryGenExit",
            "DocumentLines": documentLines
        };
            
        // 4. Post to SAP InventoryGenExits endpoint
        const sessionCookie = await sapService.loginToB1ServiceLayer();
        const sapResponse = await sapService.makeApiRequest(
            'https://192.168.101.254:50000/b1s/v2/InventoryGenExits',
            'POST',
            sessionCookie,
            payload
        );

        const currentDoNo = doNo;
        const getDocEntryQuery = `
            SELECT DocEntry
            FROM [pksrv-sap].test.dbo.OIGE
            WHERE Comments LIKE '%${currentDoNo}%'`;

        let docEntryFromOIGE = null;
        const oigeQueryResult = await pool.request().query(getDocEntryQuery);
        if (oigeQueryResult.recordset.length > 0) {
          docEntryFromOIGE = oigeQueryResult.recordset[0].DocEntry;
          if (docEntryFromOIGE) {
            const patchPayload = {
                "U_Ref_CS": currentDoNo.toString(),
                "Ref2": currentDoNo.toString()
            };

            const patchUrl = `https://192.168.101.254:50000/b1s/v2/InventoryGenExits(${docEntryFromOIGE})`;
            await sapService.makeApiRequest(
                patchUrl,
                'PATCH',
                sessionCookie,
                patchPayload
            );
          }
        }

        // 5. Update status if successful
        await this.updateDOStatusWithNote(doNo, null, 3, {
            type: 'PROCESSED',
            docEntry: sapResponse.DocEntry,
            docNum: sapResponse.DocNum,
            message: 'Successfully posted to InventoryGenExits'
        }, pool);

        console.log('------------------------------------------------------------------------------------');
        console.log('Process : '+doNo+' | Status : Success Insert Into SAP');

        return {
            status: 'processed',
            message: 'Successfully posted to InventoryGenExits',
            sapResponse: sapResponse
        };
    }

  } catch (error) {
    const errorMessageObject = JSON.parse(error.message);
    console.log('------------------------------------------------------------------------------------');
    console.log('Process : '+doNo+' | Error :'+errorMessageObject.sapError.message.value);
    
    let statusx = (errorMessageObject.sapError.message.value.indexOf('matching') !== -1) ? 0 : 2;
    await this.updateDOStatusWithNote(doNo, null, statusx, {
      type: 'PROCESS_ERROR',
      message: errorMessageObject.sapError.message.value,
      docEntry: docEntry,
      docNum: docNum
    }, pool);
    return { status: 'error', message: errorMessageObject.sapError.message.value };
  }
};

// New validation function
exports.validateOrderData = async (doNo, orderData, pool) => {
    try {
        // 1. Validate document numbers
        if (!orderData.DocNum) {
            return { isValid: false, message: 'Invalid order data - missing DocNum' };
        }

        // 2. Get coldspace data for comparison
        const coldspaceData = await pool.request()
            .input('doNo', sql.Int, doNo)
            .query('SELECT * FROM r_dn_coldspace WITH (NOLOCK) WHERE DO_NO = @doNo ORDER BY LineNum');

        if (coldspaceData.recordset.length === 0) {
            return { isValid: false, message: 'No coldspace data found for this DO' };
        }

        // 3. Compare item quantities
        const sapItems = orderData.DocumentLines;
        const coldspaceItems = coldspaceData.recordset;

        const mismatches = [];
        
        for (const sapItem of sapItems) {
            const coldspaceItem = coldspaceItems.find(item => item.SKU === sapItem.ItemCode);
            
            if (!coldspaceItem) {
                mismatches.push({
                    sku: sapItem.ItemCode,
                    message: 'Item not found in coldspace data'
                });
                continue;
            }

            if (Math.abs(sapItem.Quantity) !== Math.abs(coldspaceItem.QTY)) {
                mismatches.push({
                    sku: sapItem.ItemCode,
                    message: `Quantity mismatch - SAP: ${sapItem.Quantity}, Coldspace: ${coldspaceItem.QTY}`
                });
            }
        }

        if (mismatches.length > 0) {
            return {
                isValid: false,
                message: 'Quantity/item mismatch detected',
                details: mismatches
            };
        }

        return { isValid: true, message: 'Validation successful' };
    } catch (error) {
        console.error('Validation error:', error);
        return { isValid: false, message: 'Validation error: ' + error.message };
    }
};

// Enhanced notification service with doc validation
exports.sendWhatsAppNotification = async (doNo, docNum, docEntry, message, isSuccess, pool) => {
    try {
        // 1. Validate document numbers before sending
        if (!docNum || !docEntry) {
            // Try to get the missing data from database
            const docInfo = await pool.request()
                .input('doNo', sql.Int, doNo)
                .query('SELECT doc_num, doc_entry FROM r_dn_coldspace WHERE DO_NO = @doNo');
            
            if (docInfo.recordset.length > 0) {
                docNum = docNum || docInfo.recordset[0].doc_num;
                docEntry = docEntry || docInfo.recordset[0].doc_entry;
            }
        }

        // 2. If still missing, log and don't send
        if (!docNum || !docEntry) {
            console.log(`Cannot send WhatsApp notification - missing document numbers for DO ${doNo}`);
            return false;
        }

        // 3. Prepare notification content
        const notificationContent = {
            doNo: doNo,
            docNum: docNum,
            docEntry: docEntry,
            message: message,
            timestamp: new Date().toISOString()
        };

        // 4. Send notification (implementation depends on your WhatsApp service)
        const notificationResult = await whatsappService.send(notificationContent);
        
        // 5. Update iswa status if successful
        if (notificationResult.success) {
            await pool.request()
                .input('doNo', sql.Int, doNo)
                .query('UPDATE r_dn_coldspace SET iswa = 1 WHERE DO_NO = @doNo');
        }

        return notificationResult;
    } catch (error) {
        console.error('WhatsApp notification error:', error);
        return { success: false, error: error.message };
    }
};

// Enhanced update function
exports.updateDOStatusWithNote = async (doNo, lineNum, status, errorDetails, pool) => {
  const maxRetries = 3;
  let retryCount = 0;

  while (retryCount < maxRetries) {
    const transaction = new sql.Transaction(pool);
    try {
      await transaction.begin();

      const request = new sql.Request(transaction);
      const noteMessage = buildNoteMessage(status, errorDetails);

      // Build the update query
      let query = `UPDATE r_dn_coldspace SET 
        jo_status = @status, 
        note = @note,
        iswa = CASE WHEN @status IN (1,3) THEN 1 ELSE iswa END`;

      request.input('status', sql.Int, status);
      request.input('note', sql.NVarChar, noteMessage);
      request.input('doNo', sql.Int, doNo);

      if (errorDetails?.docEntry) {
        query += `, doc_entry = @docEntry`;
        request.input('docEntry', sql.Int, errorDetails.docEntry);
      }
      
      if (errorDetails?.docNum) {
        query += `, doc_num = @docNum`;
        request.input('docNum', sql.Int, errorDetails.docNum);
      }
      
      query += ` WHERE DO_NO = @doNo`;
      
      if (lineNum !== null && lineNum !== undefined) {
        query += ` AND LineNum = @lineNum`;
        request.input('lineNum', sql.Int, lineNum);
      }

      await request.query(query);
      await transaction.commit();

      // Send notification if needed (with validation)
      if ([2, 3].includes(status)) {
        await notificationService.sendWhatsAppNotification(
          doNo,
          errorDetails?.docNum,
          errorDetails?.docEntry,
          noteMessage,
          status === 3,
          pool
        );
      }

      return true;
    } catch (error) {
      if (transaction) await transaction.rollback();
      if (error.message.includes('deadlock') && retryCount < maxRetries - 1) {
        retryCount++;
        await new Promise(resolve => setTimeout(resolve, 100 * Math.pow(2, retryCount)));
        continue;
      }
      throw error;
    }
  }
};


exports.dnbund = async (pool) => {
  try {
      const docEntryQuery = `
          SELECT T0.DocEntry, T1.DO_NO, T1.doc_num
          FROM [pksrv-sap].test.dbo.ODLN T0 WITH (NOLOCK)
          INNER JOIN r_dn_coldspace T1 WITH (NOLOCK) ON T0.DocEntry = T1.doc_entry
          WHERE T1.ORDER_TYPE LIKE '%bund%'
          AND T0.U_BUNDLING_CS IS NULL;
      `;

      const result = await pool.request().query(docEntryQuery);
      const docsToUpdate = result.recordset.map(row => ({
          docEntry: row.DocEntry,
          doNo: row.DO_NO,
          docNum: row.doc_num
      }));

      if (docsToUpdate.length === 0) {
          return { status: 'empty', message: 'No pending bundling DOs found.' };
      }

      const sessionCookie = await sapService.loginToB1ServiceLayer();

      const successfulUpdates = [];
      const failedUpdates = [];

      for (const doc of docsToUpdate) {
          const patchPayload = {
              "U_BUNDLING_CS": "Y"
          };

          const patchUrl = `${sapService.SAP_CONFIG.BASE_URL}/DeliveryNotes(${doc.docEntry})`;

          try {
              await sapService.makeApiRequest(
                  patchUrl,
                  'PATCH',
                  sessionCookie,
                  patchPayload
              );
              successfulUpdates.push(doc.docEntry);
              console.log(`Successfully patched DeliveryNote DocEntry: ${doc.docEntry}`);

              await notificationService.sendWhatsAppNotification(
                  doc.doNo,
                  doc.docNum,
                  doc.docEntry,
                  `Successfully updated U_BUNDLING_CS for DocEntry ${doc.docEntry}.`,
                  true,
                  pool
              );

          } catch (patchError) {
              let errorMessage = 'Unknown error during patch.';
              let sapErrorMessage = '';
              try {
                  const parsedError = JSON.parse(patchError.message);
                  if (parsedError && parsedError.sapError && parsedError.sapError.message && typeof parsedError.sapError.message.value === 'string') {
                      sapErrorMessage = parsedError.sapError.message.value;
                      errorMessage = `SAP Error: ${sapErrorMessage}`;
                  } else {
                      errorMessage = patchError.message;
                  }
              } catch (parseErr) {
                  errorMessage = patchError.message;
              }

              console.log('------------------------------------------------------------------------------------');
              console.log(`Process : ${doc.doNo} | Error Patching DocEntry ${doc.docEntry}: ${errorMessage}`);

              failedUpdates.push({ docEntry: doc.docEntry, error: errorMessage });

              await notificationService.sendWhatsAppNotification(
                  doc.doNo,
                  doc.docNum,
                  doc.docEntry,
                  `Failed to update U_BUNDLING_CS for DocEntry ${doc.docEntry}. Details: ${errorMessage}`,
                  false,
                  pool
              );
          }
      }

      console.log('------------------------------------------------------------------------------------');
      console.log(`Process : Bundling Complete. Total processed: ${docsToUpdate.length}`);
      console.log(`Successful updates: ${successfulUpdates.length}`);
      console.log(`Failed updates: ${failedUpdates.length}`);

      return {
          status: 'complete',
          processedCount: docsToUpdate.length,
          successfulUpdates: successfulUpdates,
          failedUpdates: failedUpdates
      };

  } catch (error) {
      let generalErrorMessage = 'Unknown error in dnbund function.';
      let sapErrorMessage = '';
      try {
          const parsedError = JSON.parse(error.message);
          if (parsedError && parsedError.sapError && parsedError.sapError.message && typeof parsedError.sapError.message.value === 'string') {
              sapErrorMessage = parsedError.sapError.message.value;
              generalErrorMessage = `SAP Error during initial query or login: ${sapErrorMessage}`;
          } else {
              generalErrorMessage = error.message;
          }
      } catch (parseErr) {
          generalErrorMessage = error.message;
      }

      console.log('------------------------------------------------------------------------------------');
      console.log(`Process : Bundling | General Error: ${generalErrorMessage}`);

      return { status: 'error', message: generalErrorMessage };
  }
};


exports.recheckNullIswaDOs = async (pool) => {
  const result = await pool.request()
      .query(`SELECT DISTINCT DO_NO FROM r_dn_coldspace WITH (NOLOCK) 
              WHERE iswa IS NULL AND del_date >= '2025-07-01'`);
    
    const doList = result.recordset.map(row => row.DO_NO);
    
    if (doList.length === 0) {
      console.log('No DOs with NULL iswa status');
      return { status: 'empty' };
    }

    const results = {};
    for (const doNo of doList) {
      results[doNo] = await this.checkSingleDO(doNo, pool);
    }
    
  try {
    const result = await pool.request()
      .query(`SELECT DISTINCT DO_NO FROM r_dn_coldspace WITH (NOLOCK) 
              WHERE iswa IS NULL AND del_date >= '2025-07-01'`);
    
    const doList = result.recordset.map(row => row.DO_NO);
    
    if (doList.length === 0) {
      console.log('No DOs with NULL iswa status');
      return { status: 'empty' };
    }

    const results = {};
    for (const doNo of doList) {
      results[doNo] = await this.checkSingleDO(doNo, pool);
    }

    return { status: 'complete', processed: doList.length, results };
  } catch (error) {
    // console.log(error);
    const errorMessageObject = JSON.parse(error.message);
    console.log('------------------------------------------------------------------------------------');
    console.log('Process : '+doNo+' | Error :'+errorMessageObject.sapError.message.value);
    // console.error('Recheck failed:', error);
    return { status: 'error', message: error.message };
  }
};

exports.updateDOStatusWithNote = async (doNo, lineNum, status, errorDetails, pool) => {
  const maxRetries = 3;
  let retryCount = 0;

  while (retryCount < maxRetries) {
    const transaction = new sql.Transaction(pool); // Added 'new' keyword
    try {
      await transaction.begin();

      const request = new sql.Request(transaction);
      const noteMessage = buildNoteMessage(status, errorDetails);

      // Build the update query
      let query = `UPDATE r_dn_coldspace SET 
        jo_status = @status, 
        note = @note,
        iswa = CASE WHEN @status IN (1,3) THEN 1 ELSE iswa END`;

      
      request.input('status', sql.Int, status);
      request.input('note', sql.NVarChar, noteMessage);
      request.input('doNo', sql.Int, doNo);

      if (errorDetails?.docEntry) {
        query += `, doc_entry = @docEntry`;
        request.input('docEntry', sql.Int, errorDetails.docEntry);
      }
      
      if (errorDetails?.docNum) {
        query += `, doc_num = @docNum`;
        request.input('docNum', sql.Int, errorDetails.docNum);
      }
      
      query += ` WHERE DO_NO = @doNo`;
      
      if (lineNum !== null && lineNum !== undefined) {
        query += ` AND LineNum = @lineNum`;
        request.input('lineNum', sql.Int, lineNum);
      }

      await request.query(query);
      await transaction.commit();

      // Send notification if needed
      if ([2, 3].includes(status)) {
        await notificationService.sendWhatsAppNotification(
          doNo,
          errorDetails?.docNum,
          errorDetails?.docEntry,
          noteMessage,
          status === 3
        );
      }

      return true;
    } catch (error) {
      if (transaction) await transaction.rollback();
      if (error.message.includes('deadlock') && retryCount < maxRetries - 1) {
        retryCount++;
        await new Promise(resolve => setTimeout(resolve, 100 * Math.pow(2, retryCount)));
        continue;
      }
      throw error;
    }
  }
};

function buildNoteMessage(status, errorDetails) {
  if (!errorDetails) {
    return status === 1 ? '[MATCH] Data sesuai dengan SAP' : 
           status === 3 ? '[PROCESSED] Berhasil diproses ke SAP' : 
           '[MISMATCH] Ketidakcocokan ditemukan';
  }

  let note = `[${errorDetails.type || 'ERROR'}] ${errorDetails.message || ''}\n`;
  if (errorDetails.docEntry) note += `DocEntry: ${errorDetails.docEntry}\n`;
  if (errorDetails.docNum) note += `DocNum: ${errorDetails.docNum}\n`;
  
  if (errorDetails.mismatchDetails) {
    note += "Detail Ketidakcocokan:\n";
    errorDetails.mismatchDetails.forEach(detail => {
      note += `- Line ${detail.lineNum}: ${detail.type}\n`;
    });
  }
  
  return note + `Timestamp: ${new Date().toISOString()}`;
}


exports.runAutoCheck = async (pool) => {
  try {
    const result = await pool.request()
      .query(`SELECT DISTINCT DO_NO FROM r_dn_coldspace WITH (NOLOCK) 
              WHERE jo_status IS NULL AND del_date >= '2025-07-01'`);
    
    const doList = result.recordset.map(row => row.DO_NO);
   
    if (doList.length === 0) { 
      console.log('------------------------------------------------------------------------------------');
      console.log('No pending DOs found for auto check');
      return { status: 'empty' };
    }

    const results = {};
    for (const doNo of doList) {
      results[doNo] = await this.checkSingleDO(doNo, pool);
    }

    return { status: 'complete', processed: doList.length, results };
  } catch (error) {
    
    // const errorMessageObject = JSON.parse(error.message);
    // console.log('------------------------------------------------------------------------------------');
    // console.log('Process : '+doNo+' | Error :'+errorMessageObject.sapError.message.value);
    // console.error('Auto check failed:', error);
    return { status: 'error', message: error.message };
  }
};
