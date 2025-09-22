const axios = require('axios');
const https = require('https');
const sql = require('mssql');
const dbConfig = require('../config/dbConfig');
const notificationService = require('./notificationService');

const SAP_CONFIG = {
  BASE_URL: 'https://192.168.101.254:50000/b1s/v2',
  COMPANY_DB: 'PANDURASA_LIVE',
  CREDENTIALS: {
    username: 'Manager',
    password: 'Password#1'
  }
};

let sapSessionCache = {
  cookie: null,
  expires: null
};

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

let getDfltwhForSKU = async (sku) => {
  if (sku === 'G502') return 'BS03';
  if (sku === 'K102') return 'BS04';
  if (sku === 'F001') return 'BS02';
  return null;
};

exports.loginToB1ServiceLayer = async () => {
  if (sapSessionCache.cookie && sapSessionCache.expires > new Date()) {
    return sapSessionCache.cookie;
  }

  try {
    const response = await axios.post(
      `${SAP_CONFIG.BASE_URL}/Login`,
      {
        CompanyDB: SAP_CONFIG.COMPANY_DB,
        UserName: SAP_CONFIG.CREDENTIALS.username,
        Password: SAP_CONFIG.CREDENTIALS.password
      },
      {
        httpsAgent: new https.Agent({ rejectUnauthorized: false }),
        timeout: 10000
      }
    );

    const cookies = response.headers['set-cookie'];
    if (!cookies) throw new Error('No session cookie received');

    const sessionCookie = cookies
      .filter(c => c.includes('B1SESSION=') || c.includes('ROUTEID='))
      .map(c => c.split(';')[0])
      .join('; ');

    sapSessionCache = {
      cookie: sessionCookie,
      expires: new Date(Date.now() + 30 * 60 * 1000)
    };

    return sessionCookie;
  } catch (error) {
    console.error('SAP Login Error:', error.response?.data || error.message);
    throw new Error(`Login failed: ${error.message}`);
  }
};

const makeApiRequest = async (url, method = 'GET', sessionCookie = null, data = null) => {
  const config = {
    method,
    url,
    httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    timeout: 45000,
    headers: {
      'Content-Type': 'application/json'
    }
  };

  if (sessionCookie) {
    config.headers.Cookie = sessionCookie;
  }

  if (data && method !== 'GET') {
    config.data = data;
  }

  try {
    const response = await axios(config);
    return response.data;
  } catch (error) {
    const errorDetails = {
      url,
      method,
      status: error.response?.status,
      sapError: error.response?.data?.error,
      message: error.message
    };
    throw new Error(JSON.stringify(errorDetails));
  }
};
const updateDOStatusWithNote = async (doNo, docNum, joStatus, errorDetails, pool) => {
  let errorMessageToLog = "Unknown error occurred.";
  if (errorDetails.message) {
      errorMessageToLog = errorDetails.message;
  } else if (errorDetails.sapError?.message?.value) {
      errorMessageToLog = errorDetails.sapError.message.value;
  }

  const isClosedError = errorMessageToLog.toLowerCase().includes('closed');
  
  let statusx = joStatus;
  let note = errorMessageToLog;

  if (isClosedError) {
      statusx = 3;
      note = 'Successfully posted to SAP';
  } else {
      statusx = (errorMessageToLog.toLowerCase().includes('matching') || errorMessageToLog.toLowerCase().includes('match')) ? 0 : joStatus;
  }
  
  await pool.request()
      .input('doNo', sql.Int, doNo)
      .input('status', sql.Int, statusx)
      .input('error', sql.NVarChar, note)
      .query(`
          UPDATE r_dn_coldspace
          SET note = @error, jo_status = @status, iswa = 1
          WHERE DO_NO = @doNo
      `);
};

const formatDateToISO = (date) => {
  if (!date) return null;
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

async function getBatchNumbers(doNo, line, pool, sapOrderData) {
  const batchNumbers = [];

  try {
    const coldspaceQuery = `
      SELECT TOP 1 batchnum, QTY
      FROM r_dn_coldspace
      WHERE DO_NO = @doNo AND SKU = @sku`;

    const coldspaceResult = await pool.request()
      .input('doNo', sql.Int, doNo)
      .input('sku', sql.VarChar, line.ItemCode)
      .query(coldspaceQuery);

    if (coldspaceResult.recordset.length > 0 && coldspaceResult.recordset[0].batch_num) {
      batchNumbers.push({
        "BatchNumber": coldspaceResult.recordset[0].batch_num,
        "Quantity": parseFloat(coldspaceResult.recordset[0].QTY)
      });
      return batchNumbers;
    }
  } catch (error) {
    console.error('Error fetching batch_num from r_dn_coldspace:', error);
  }

  const sapBatchNumbers = line.BatchNumbers || [];
  if (sapBatchNumbers.length > 0) {
    for (const batch of sapBatchNumbers) {
      if (batch.BatchNumber && batch.Quantity !== undefined) {
        batchNumbers.push({
          "BatchNumber": batch.BatchNumber,
          "Quantity": parseFloat(batch.Quantity)
        });
      }
    }
    if (batchNumbers.length > 0) {
      return batchNumbers;
    }
  }

  try {
    const result = await pool.request()
      .input('doNo', sql.Int, doNo)
      .input('sku', sql.VarChar, line.ItemCode)
      .query(`SELECT TOP 1 oibt.batchnum 
              FROM [db_pandurasa].dbo.r_dn_coldspace t0
              INNER JOIN [PKSRV-SAP].[PANDURASA_LIVE].dbo.OIBT 
                ON OIBT.ItemCode COLLATE SQL_Latin1_General_CP1_CI_AS = t0.SKU COLLATE SQL_Latin1_General_CP1_CI_AS
                AND OIBT.Quantity > t0.QTY 
                AND OIBT.Batchnum COLLATE SQL_Latin1_General_CP1_CI_AS like '%' + t0.expired_date + '%' COLLATE SQL_Latin1_General_CP1_CI_AS
              WHERE t0.ORDER_TYPE != 'N-STO' 
                AND t0.ORDER_TYPE != 'PROD' 
                AND t0.ismatch = 1 
                AND (t0.jo_status IS NULL OR t0.iswa IS NULL) 
                AND t0.DO_NO = @doNo 
                AND t0.SKU = @sku`);

    if (result.recordset.length > 0) {
      batchNumbers.push({
        "BatchNumber": result.recordset[0].batchnum,
        "Quantity": parseFloat(line.Quantity)
      });
    } else {
      batchNumbers.push({
        "BatchNumber": `BATCH-${line.ItemCode}-${Date.now()}`,
        "Quantity": parseFloat(line.Quantity)
      });
    }
  } catch (error) {
    batchNumbers.push({
      "BatchNumber": `BATCH-${line.ItemCode}-${Date.now()}`,
      "Quantity": parseFloat(line.Quantity)
    });
  }

  return batchNumbers;
}
async function getWarehouseData(doNo, itemCode, pool) {
  const query = `
    SELECT TOP 1 
    t1.sup_site as site
    FROM r_dn_coldspace t0
    INNER JOIN r_do_coldspace_dev t1 ON t0.do_no = t1.do_no
    WHERE t0.DO_NO = @doNo 
    AND t0.SKU = @itemCode
    AND t0.ORDER_TYPE != 'N-STO' 
    AND t0.order_type != 'PROD' 
    AND t0.ismatch = 1`;

  try {
    const result = await pool.request()
      .input('doNo', sql.Int, doNo)
      .input('itemCode', sql.VarChar, itemCode)
      .query(query);

    if (result.recordset.length > 0 && result.recordset[0].site) {
      const record = result.recordset[0];
      return { code: record.site };
    }
    
    // Fallback if no matching record is found or 'site' is null
    console.log(`Warning: No specific warehouse found for DO ${doNo}, SKU ${itemCode}. Using default 'CS-03'.`);
    return { code: 'CS-03' };

  } catch (error) {
    console.error(`Error fetching warehouse data for DO ${doNo}, SKU ${itemCode}:`, error);
    // Fallback on query error
    return { code: 'CS-03' };
  }
}
async function createDocumentLines(sapOrderData, doNo, pool, sessionCookie) {
  const documentLines = [];
  
  if (!sapOrderData.DocumentLines || sapOrderData.DocumentLines.length === 0) {
    throw new Error('No document lines found in SAP order data');
  }

  for (const line of sapOrderData.DocumentLines) {
    try {
      if (!line.ItemCode || line.Quantity === undefined || line.Quantity === null) {
        continue;
      }

      const warehouseData = await getWarehouseData(doNo, line.ItemCode, pool);
      
      const documentLine = {
        "ItemCode": line.ItemCode,
        "Quantity": parseFloat(line.Quantity),
        "BaseType": 17,
        "BaseEntry": sapOrderData.DocEntry,
        "BaseLine": line.LineNum,
        "WarehouseCode": warehouseData.code || 'CS-03'
      };

      documentLine.BatchNumbers = await getBatchNumbers(doNo, line, pool, sapOrderData);

      documentLines.push(documentLine);
    } catch (lineError) {
    }
  }

  return documentLines;
}

// exports.postDeliveryNoteToSAP = async (doNo, pool) => {
//   const checkExistingQuery = `
//     SELECT jo_status, note, doc_num, doc_entry 
//     FROM r_dn_coldspace 
//     WHERE DO_NO = @doNo
//   `;
  
//   const existingResult = await pool.request()
//     .input('doNo', sql.Int, doNo)
//     .query(checkExistingQuery);
  
//   if (existingResult.recordset.length > 0) {
//     const existingData = existingResult.recordset[0];
    
//     if (existingData.jo_status === 3 && existingData.note?.includes('Successfully posted to SAP')) {
//       console.log(`Process : ${doNo} | Already processed successfully, skipping...`);
//       return {
//         status: 'success',
//         docEntry: existingData.doc_entry,
//         docNum: existingData.doc_num,
//         message: 'Already processed successfully'
//       };
//     }
    
//     if (existingData.note?.toLowerCase().includes('closed') && existingData.jo_status !== 3) {
//       console.log(`Process : ${doNo} | Document already closed, updating status...`);
      
//       await pool.request()
//         .input('doNo', sql.Int, doNo)
//         .input('status', sql.Int, 3)
//         .input('note', sql.NVarChar, 'Successfully posted to SAP')
//         .query(`
//             UPDATE r_dn_coldspace
//             SET note = @note, jo_status = @status, iswa = 1
//             WHERE DO_NO = @doNo
//         `);
      
//       return {
//         status: 'success',
//         docEntry: existingData.doc_entry,
//         docNum: existingData.doc_num,
//         message: 'Document already closed, status updated to success'
//       };
//     }
//   }

//   let sessionCookie;
//   let docEntryFromSAP, docNumFromSAP;

//   try {
//     await delay(300);

//     sessionCookie = await exports.loginToB1ServiceLayer();
//     const docEntryRequest = pool.request();
//     const docEntryResult = await docEntryRequest
//       .input('doNo', sql.Int, doNo)
//       .query('SELECT DISTINCT DocEntry FROM [pksrv-sap].pandurasa_live.dbo.ORDR WITH (NOLOCK) WHERE DocNum = @doNo');

//     if (!docEntryResult.recordset || docEntryResult.recordset.length === 0) {
//       throw new Error(`Order ${doNo} not found in local DB/SAP (no DocEntry found for this DocNum).`);
//     }

//     const docEntry = docEntryResult.recordset[0].DocEntry;
//     const orderUrl = `${SAP_CONFIG.BASE_URL}/Orders(${docEntry})`;
//     const sapOrderData = await makeApiRequest(orderUrl, 'GET', sessionCookie);

//     if (!sapOrderData || !sapOrderData.DocDueDate || !sapOrderData.CardCode || !sapOrderData.DocumentLines) {
//       throw new Error('Incomplete order data received from SAP');
//     }

//     docEntryFromSAP = sapOrderData.DocEntry;
//     docNumFromSAP = sapOrderData.DocNum;

//     const validationResult = await this.validateOrderWithColdspace(doNo, sapOrderData.DocumentLines, pool);
//     if (!validationResult.isValid) {
//       throw new Error(`Validation failed: ${validationResult.message}`);
//     }

//     const addressExtensionQuery = `
//       SELECT TOP 1
//           T0.U_IDU_Nama_SupirS, T0.U_IDU_Nama_SupirB, T0.U_IDU_NoPlat_MblS, T0.U_IDU_NoPlat_MblB,
//           T0.U_IDU_RuteS, T0.U_IDU_RuteB, T0.U_IDU_Rute_NameS, T0.U_IDU_Rute_NameB,
//           T0.U_IDU_Status_DO,
//           T1.Street AS ShipToStreet, T1.City AS ShipToCity, T1.ZipCode AS ShipToZipCode, T1.Country AS ShipToCountry,
//           T2.Street AS BillToStreet, T2.Country AS BillToCountry
//       FROM [pksrv-sap].pandurasa_live.dbo.ORDR T0
//       LEFT JOIN [pksrv-sap].pandurasa_live.dbo.CRD1 T1 ON T0.CardCode = T1.CardCode AND T1.Address = T0.ShipToCode AND T1.AdresType = 'S'
//       LEFT JOIN [pksrv-sap].pandurasa_live.dbo.CRD1 T2 ON T0.CardCode = T2.CardCode AND T2.AdresType = 'B'
//       WHERE T0.DocNum = @doNo
//     `;

//     let addressExtensionData = {};
//     try {
//       const addressExtensionResult = await pool.request()
//         .input('doNo', sql.Int, doNo)
//         .query(addressExtensionQuery);

//       if (addressExtensionResult.recordset.length > 0) {
//         const data = addressExtensionResult.recordset[0];
//         addressExtensionData = {
//           "ShipToStreet": data.ShipToStreet,
//           "ShipToCity": data.ShipToCity,
//           "ShipToZipCode": data.ShipToZipCode,
//           "ShipToCountry": data.ShipToCountry,
//           "BillToStreet": data.BillToStreet,
//           "BillToCountry": data.BillToCountry,
//           "U_IDU_Nama_SupirS": data.U_IDU_Nama_SupirS,
//           "U_IDU_Nama_SupirB": data.U_IDU_Nama_SupirB,
//           "U_IDU_NoPlat_MblS": data.U_IDU_NoPlat_MblS,
//           "U_IDU_NoPlat_MblB": data.U_IDU_NoPlat_MblB,
//           "U_IDU_RuteS": data.U_IDU_RuteS,
//           "U_IDU_RuteB": data.U_IDU_RuteB,
//           "U_IDU_Rute_NameS": data.U_IDU_Rute_NameS,
//           "U_IDU_Rute_NameB": data.U_IDU_Rute_NameB
//         };
//       }
//     } catch (err) {
//     }

//     const documentLines = await createDocumentLines(sapOrderData, doNo, pool, sessionCookie);
//     if (!documentLines || documentLines.length === 0) {
//       throw new Error('No valid document lines found for this delivery note');
//     }

//     const deliveryNotePayload = {
//       "CardCode": sapOrderData.CardCode,
//       "DocDate": formatDateToISO(new Date()), 
//       "DocDueDate": formatDateToISO(sapOrderData.DocDueDate),
//       "TaxDate": formatDateToISO(new Date()), 
//       "Comments": sapOrderData.Comments || "Based On Sales Order " + sapOrderData.DocNum,
//       "BPL_IDAssignedToInvoice": sapOrderData.BPL_IDAssignedToInvoice || null,
//       "TransportationCode": sapOrderData.TransportationCode || -1,
//       "PaymentGroupCode": sapOrderData.PaymentGroupCode || 8,
//       "SalesPersonCode": sapOrderData.SalesPersonCode || 12,
//       "ShipToCode": sapOrderData.ShipToCode, 
//       "U_IDU_Status_DO": addressExtensionData.U_IDU_Status_DO || "Kirim Besok",
//       "DocumentLines": documentLines,
//       ...Object.keys(addressExtensionData).length > 0 && { "AddressExtension": addressExtensionData },
//     };

//     console.log(JSON.stringify(deliveryNotePayload,null,2));

//     const response = await makeApiRequest(
//       `${SAP_CONFIG.BASE_URL}/DeliveryNotes`,
//       'POST',
//       sessionCookie,
//       deliveryNotePayload
//     );

//     await pool.request()
//       .input('doNo', sql.Int, doNo)
//       .input('docEntry', sql.Int, response.DocEntry)
//       .input('docNum', sql.Int, response.DocNum)
//       .query(`
//         UPDATE r_dn_coldspace
//         SET doc_entry = @docEntry, doc_num = @docNum, jo_status = 3, note = 'Successfully posted to SAP'
//         WHERE DO_NO = @doNo
//       `);

//     console.log('------------------------------------------------------------------------------------');
//     console.log('Process : ' + doNo + ' | Status : Success');

//     await delay(300);
//     const notificationResult = await notificationService.sendWhatsApp(
//       doNo,
//       response.DocNum,
//       response.DocEntry,
//       'Proses DO Berhasil',
//       true,
//       pool
//     );

//     if (notificationResult.success) {
//       await pool.request()
//         .input('doNo', sql.Int, doNo)
//         .query('UPDATE r_dn_coldspace SET iswa = 1 WHERE DO_NO = @doNo');
//     }

//     return {
//       status: 'success',
//       docEntry: response.DocEntry,
//       docNum: response.DocNum
//     };

//   } catch (error) {
//     let errorDetails = {};
//     if (error.message) {
//       try {
//         errorDetails = JSON.parse(error.message);
//       } catch (parseError) {
//         errorDetails = { message: error.message };
//       }
//     } else {
//       errorDetails = { message: "An unexpected error occurred." };
//     }

//     const errorMessageToLog = errorDetails.sapError?.message?.value || errorDetails.message || "Unknown error occurred.";

//     await updateDOStatusWithNote(
//       doNo,
//       docNumFromSAP,
//       2,
//       {
//         type: 'PROCESSING_ERROR',
//         message: errorMessageToLog,
//         docEntry: docEntryFromSAP,
//         sapError: errorDetails.sapError
//       },
//       pool
//     );

//     return {
//       status: 'error',
//       message: errorMessageToLog,
//       sapError: errorDetails.sapError
//     };
//   }
// };

exports.postDeliveryNoteToSAP = async (doNo, pool) => {
  const checkExistingQuery = `
    SELECT jo_status, note, doc_num, doc_entry
    FROM r_dn_coldspace
    WHERE DO_NO = @doNo
  `;
  
  const existingResult = await pool.request()
      .input('doNo', sql.Int, doNo)
      .query(checkExistingQuery);
  
  if (existingResult.recordset.length > 0) {
      const existingData = existingResult.recordset[0];
      
      if (existingData.jo_status === 3 && existingData.note?.includes('Successfully posted to SAP')) {
          console.log(`Process : ${doNo} | Already processed successfully, skipping...`);
          return {
              status: 'success',
              docEntry: existingData.doc_entry,
              docNum: existingData.doc_num,
              message: 'Already processed successfully'
          };
      }
      
      if (existingData.note?.toLowerCase().includes('closed') && existingData.jo_status !== 3) {
          console.log(`Process : ${doNo} | Document already closed, updating status...`);
          
          await pool.request()
              .input('doNo', sql.Int, doNo)
              .input('status', sql.Int, 3)
              .input('note', sql.NVarChar, 'Successfully posted to SAP')
              .query(`
                  UPDATE r_dn_coldspace
                  SET note = @note, jo_status = @status, iswa = 1
                  WHERE DO_NO = @doNo
              `);
          
          return {
              status: 'success',
              docEntry: existingData.doc_entry,
              docNum: existingData.doc_num,
              message: 'Document already closed, status updated to success'
          };
      }
  }

  let sessionCookie;
  let docEntryFromSAP, docNumFromSAP;
  let notificationNote = '';
  let notificationSuccess = false;

  try {
      await delay(300);

      sessionCookie = await exports.loginToB1ServiceLayer();
      const docEntryRequest = pool.request();
      const docEntryResult = await docEntryRequest
          .input('doNo', sql.Int, doNo)
          .query('SELECT DISTINCT DocEntry FROM [pksrv-sap].pandurasa_live.dbo.ORDR WITH (NOLOCK) WHERE DocNum = @doNo');

      if (!docEntryResult.recordset || docEntryResult.recordset.length === 0) {
          throw new Error(`Order ${doNo} not found in local DB/SAP (no DocEntry found for this DocNum).`);
      }

      const docEntry = docEntryResult.recordset[0].DocEntry;
      const orderUrl = `${SAP_CONFIG.BASE_URL}/Orders(${docEntry})`;
      const sapOrderData = await makeApiRequest(orderUrl, 'GET', sessionCookie);

      if (!sapOrderData || !sapOrderData.DocDueDate || !sapOrderData.CardCode || !sapOrderData.DocumentLines) {
          throw new Error('Incomplete order data received from SAP');
      }

      docEntryFromSAP = sapOrderData.DocEntry;
      docNumFromSAP = sapOrderData.DocNum;

      const validationResult = await this.validateOrderWithColdspace(doNo, sapOrderData.DocumentLines, pool);
      if (!validationResult.isValid) {
          throw new Error(`Validation failed: ${validationResult.message}`);
      }

      const addressExtensionQuery = `
        SELECT TOP 1
            T0.U_IDU_Nama_SupirS, T0.U_IDU_Nama_SupirB, T0.U_IDU_NoPlat_MblS, T0.U_IDU_NoPlat_MblB,
            T0.U_IDU_RuteS, T0.U_IDU_RuteB, T0.U_IDU_Rute_NameS, T0.U_IDU_Rute_NameB,
            T0.U_IDU_Status_DO,
            T1.Street AS ShipToStreet, T1.City AS ShipToCity, T1.ZipCode AS ShipToZipCode, T1.Country AS ShipToCountry,
            T2.Street AS BillToStreet, T2.Country AS BillToCountry
        FROM [pksrv-sap].pandurasa_live.dbo.ORDR T0
        LEFT JOIN [pksrv-sap].pandurasa_live.dbo.CRD1 T1 ON T0.CardCode = T1.CardCode AND T1.Address = T0.ShipToCode AND T1.AdresType = 'S'
        LEFT JOIN [pksrv-sap].pandurasa_live.dbo.CRD1 T2 ON T0.CardCode = T2.CardCode AND T2.AdresType = 'B'
        WHERE T0.DocNum = @doNo
      `;

      let addressExtensionData = {};
      try {
          const addressExtensionResult = await pool.request()
              .input('doNo', sql.Int, doNo)
              .query(addressExtensionQuery);

          if (addressExtensionResult.recordset.length > 0) {
              const data = addressExtensionResult.recordset[0];
              addressExtensionData = {
                  "ShipToStreet": data.ShipToStreet,
                  "ShipToCity": data.ShipToCity,
                  "ShipToZipCode": data.ShipToZipCode,
                  "ShipToCountry": data.ShipToCountry,
                  "BillToStreet": data.BillToStreet,
                  "BillToCountry": data.BillToCountry,
                  "U_IDU_Nama_SupirS": data.U_IDU_Nama_SupirS,
                  "U_IDU_Nama_SupirB": data.U_IDU_Nama_SupirB,
                  "U_IDU_NoPlat_MblS": data.U_IDU_NoPlat_MblS,
                  "U_IDU_NoPlat_MblB": data.U_IDU_NoPlat_MblB,
                  "U_IDU_RuteS": data.U_IDU_RuteS,
                  "U_IDU_RuteB": data.U_IDU_RuteB,
                  "U_IDU_Rute_NameS": data.U_IDU_Rute_NameS,
                  "U_IDU_Rute_NameB": data.U_IDU_Rute_NameB
              };
          }
      } catch (err) {
      }

      const documentLines = await createDocumentLines(sapOrderData, doNo, pool, sessionCookie);
      if (!documentLines || documentLines.length === 0) {
          throw new Error('No valid document lines found for this delivery note');
      }

      const deliveryNotePayload = {
          "CardCode": sapOrderData.CardCode,
          "DocDate": formatDateToISO(new Date()),
          "DocDueDate": formatDateToISO(sapOrderData.DocDueDate),
          "TaxDate": formatDateToISO(new Date()),
          "Comments": sapOrderData.Comments || "Based On Sales Order " + sapOrderData.DocNum,
          "BPL_IDAssignedToInvoice": sapOrderData.BPL_IDAssignedToInvoice || null,
          "TransportationCode": sapOrderData.TransportationCode || -1,
          "PaymentGroupCode": sapOrderData.PaymentGroupCode || 8,
          "SalesPersonCode": sapOrderData.SalesPersonCode || 12,
          "ShipToCode": sapOrderData.ShipToCode,
          "U_IDU_Status_DO": addressExtensionData.U_IDU_Status_DO || "Kirim Besok",
          "DocumentLines": documentLines,
          ...Object.keys(addressExtensionData).length > 0 && { "AddressExtension": addressExtensionData },
      };

      console.log(JSON.stringify(deliveryNotePayload, null, 2));

      const response = await makeApiRequest(
          `${SAP_CONFIG.BASE_URL}/DeliveryNotes`,
          'POST',
          sessionCookie,
          deliveryNotePayload
      );

      await pool.request()
          .input('doNo', sql.Int, doNo)
          .input('docEntry', sql.Int, response.DocEntry)
          .input('docNum', sql.Int, response.DocNum)
          .query(`
              UPDATE r_dn_coldspace
              SET doc_entry = @docEntry, doc_num = @docNum, jo_status = 3, note = 'Successfully posted to SAP'
              WHERE DO_NO = @doNo
          `);
      
      console.log('------------------------------------------------------------------------------------');
      console.log('Process : ' + doNo + ' | Status : Success');
      
      notificationNote = 'Proses DO Berhasil';
      notificationSuccess = true;
      docEntryFromSAP = response.DocEntry;
      docNumFromSAP = response.DocNum;

      return {
          status: 'success',
          docEntry: response.DocEntry,
          docNum: response.DocNum
      };

  } catch (error) {
      let errorDetails = {};
      if (error.message) {
          try {
              errorDetails = JSON.parse(error.message);
          } catch (parseError) {
              errorDetails = { message: error.message };
          }
      } else {
          errorDetails = { message: "An unexpected error occurred." };
      }

      const errorMessageToLog = errorDetails.sapError?.message?.value || errorDetails.message || "Unknown error occurred.";

      await updateDOStatusWithNote(
          doNo,
          docNumFromSAP,
          2,
          {
              type: 'PROCESSING_ERROR',
              message: errorMessageToLog,
              docEntry: docEntryFromSAP,
              sapError: errorDetails.sapError
          },
          pool
      );
      
      notificationNote = errorMessageToLog;
      notificationSuccess = false;

      return {
          status: 'error',
          message: errorMessageToLog,
          sapError: errorDetails.sapError
      };

  } finally {
      if (notificationNote) {
          await notificationService.sendNotification(
              doNo,
              docNumFromSAP,
              docEntryFromSAP,
              notificationNote,
              notificationSuccess,
              pool
          );
      }
  }
};

exports.validateOrderWithColdspace = async (doNo, sapOrderData, pool) => {
  try {
    const coldspaceQuery = `
      SELECT SKU, QTY, LineNum
      FROM r_dn_coldspace
      WHERE DO_NO = @doNo
      ORDER BY LineNum`;

    const coldspaceResult = await pool.request()
      .input('doNo', sql.Int, doNo)
      .query(coldspaceQuery);

    if (coldspaceResult.recordset.length === 0) {
      return { isValid: false, message: 'No coldspace data found for this DO' };
    }

    const coldspaceItems = coldspaceResult.recordset;

    if (sapOrderData.length !== coldspaceItems.length) {
      return {
        isValid: false,
        message: `Item count mismatch - SAP: ${sapOrderData.length}, Coldspace: ${coldspaceItems.length}`
      };
    }

    const mismatches = [];
    const sapItemsMap = new Map();

    sapOrderData.forEach(item => {
      if (!sapItemsMap.has(item.LineNum)) {
        sapItemsMap.set(item.LineNum, {
          ItemCode: item.ItemCode,
          Quantity: item.Quantity,
          LineNum: item.LineNum
        });
      }
    });

    for (const coldspaceItem of coldspaceItems) {
      const sapItem = sapItemsMap.get(coldspaceItem.LineNum);

      if (!sapItem) {
        mismatches.push({
          lineNum: coldspaceItem.LineNum,
          message: `Item not found in SAP data`
        });
        continue;
      }

      if (sapItem.ItemCode !== coldspaceItem.SKU) {
        mismatches.push({
          lineNum: coldspaceItem.LineNum,
          message: `SKU mismatch - SAP: ${sapItem.ItemCode}, Coldspace: ${coldspaceItem.SKU}`
        });
      }

      if (Math.abs(sapItem.Quantity) !== Math.abs(coldspaceItem.QTY)) {
        mismatches.push({
          lineNum: coldspaceItem.LineNum,
          message: `Quantity mismatch - SAP: ${sapItem.Quantity}, Coldspace: ${coldspaceItem.QTY}`
        });
      }
    }

    if (mismatches.length > 0) {
      return {
        isValid: false,
        message: 'Item validation failed',
        details: mismatches
      };
    }

    return { isValid: true, message: 'Validation successful' };
  } catch (error) {
    return { isValid: false, message: 'Validation error: ' + error.message };
  }
};

exports.checkDeliveryNoteStatus = async (docEntry) => {
  try {
    await delay(300);
    const sessionCookie = await this.loginToB1ServiceLayer();
    const url = `${SAP_CONFIG.BASE_URL}/DeliveryNotes(${docEntry})`;
    
    const response = await this.makeApiRequest(
      url,
      'GET',
      sessionCookie
    );

    return {
      status: response.DocumentStatus,
      docNum: response.DocNum,
      details: response
    };
  } catch (error) {
    throw error;
  }
};

exports.makeApiRequest = async (url, method = 'GET', sessionCookie = null, data = null) => {
  const config = {
    method,
    url,
    httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    timeout: 15000,
    headers: {
      'Content-Type': 'application/json'
    }
  };

  if (sessionCookie) {
    config.headers.Cookie = sessionCookie;
  }

  if (data && method !== 'GET') {
    config.data = data;
  }

  try {
    const response = await axios(config);
    return response.data;
  } catch (error) {
    const errorDetails = {
      url,
      method,
      status: error.response?.status,
      sapError: error.response?.data?.error,
      message: error.message
    };
    
    throw new Error(JSON.stringify(errorDetails));
  }
};

exports.getOrderFromSAP = async (docNum, pool) => {
  let sapDocEntry;

  const docEntryRequest = pool.request();
  const docEntryResult = await docEntryRequest
    .input('doNo', sql.Int, docNum)
    .query('SELECT DISTINCT DocEntry FROM [pksrv-sap].pandurasa_live.dbo.ORDR WITH (NOLOCK) WHERE DocNum = @doNo');

  if (!docEntryResult.recordset || docEntryResult.recordset.length === 0) {
    sapDocEntry = docNum;
  } else {
    sapDocEntry = docEntryResult.recordset[0].DocEntry;
  }

  await delay(300);
  const sessionCookie = await this.loginToB1ServiceLayer();
  const url = `${SAP_CONFIG.BASE_URL}/Orders(${sapDocEntry})`;

  try {
    const response = await this.makeApiRequest(url, 'GET', sessionCookie);
    if (response && Object.keys(response).length > 0) {
      return response;
    } else {
      console.log('------------------------------------------------------------------------------------');
      console.log('Process : '+docNum+' | Error : No order data or empty response found from SAP for DocEntry:'+sapDocEntry);
      return null;
    }
  } catch (error) {
    const errorMessageObject = JSON.parse(error.message);
    console.log('------------------------------------------------------------------------------------');
    console.log('Process : '+docNum+' | Error :'+errorMessageObject.sapError.message.value);
  }
};

exports.SAP_CONFIG = SAP_CONFIG;