const axios = require('axios');
const https = require('https');
const sql = require('mssql');
const dbConfig = require('../config/dbConfig');

const notificationService = require('./notificationService');

// Konfigurasi SAP B1
const SAP_CONFIG = {
  BASE_URL: 'https://192.168.101.254:50000/b1s/v2',
  COMPANY_DB: 'TEST',
  CREDENTIALS: {
    username: 'Manager',
    password: 'Password#1'
  }
};

let sapSessionCache = {
  cookie: null,
  expires: null
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

  console.log('------------------------------------------------------------------------------------');
  console.log(`Process : ${doNo} | Error  Update : ${errorMessageToLog}`);

  let statusx = (errorMessageToLog.toLowerCase().includes('closed')) ? 3 : 
  (errorMessageToLog.toLowerCase().includes('matching') || errorMessageToLog.toLowerCase().includes('match')) ? 0 : 
  joStatus;

  if(statusx == 3){
    await notificationService.sendWhatsAppNotification(
        doNo,
        docNum || null,
        errorDetails.docEntry || null,
        errorMessageToLog,
        1,
        pool
    );
  }else{  
    await notificationService.sendWhatsAppNotification(
        doNo,
        docNum || null,
        errorDetails.docEntry || null,
        errorMessageToLog,
        false,
        pool
    );
  }

  await pool.request()
      .input('doNo', sql.Int, doNo)
      .input('status', sql.Int, statusx)
      .input('error', sql.NVarChar, errorMessageToLog)
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

exports.postDeliveryNoteToSAP = async (doNo, pool) => {
  let sessionCookie;
  let docEntryFromSAP, docNumFromSAP;

  try {
    sessionCookie = await exports.loginToB1ServiceLayer();

    const docEntryRequest = pool.request();
    const docEntryResult = await docEntryRequest
      .input('doNo', sql.Int, doNo)
      .query('SELECT DISTINCT DocEntry FROM [pksrv-sap].test.dbo.ORDR WITH (NOLOCK) WHERE DocNum = @doNo');

    if (!docEntryResult.recordset || docEntryResult.recordset.length === 0) {
      throw new Error(`Order ${doNo} not found in local DB/SAP (no DocEntry found for this DocNum).`);
    }

    const docEntry = docEntryResult.recordset[0].DocEntry;
    
    const orderQuery = `
      SELECT
        T0.DocEntry,
        T0.DocNum,
        T0.DocDueDate,
        T0.CardCode,
        T0.Comments,
        T0.BPLId,
        T0.TrnspCode,
        T0.SlpCode,
        T0.ShipToCode,
        T0.U_IDU_Status_DO,
        T1.ItemCode,
        T1.Quantity,
        T1.LineNum,
        T1.WhsCode AS WarehouseCode,
        T2.BatchNum,
        T2.Quantity AS BatchQty,
        T3.ExpDate AS ExpiryDate,
        T3.MnfDate AS ManufacturingDate,
        SeriesCodeTable.sercode as Series
      FROM [pksrv-sap].test.dbo.ORDR T0
      JOIN [pksrv-sap].test.dbo.RDR1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN [pksrv-sap].test.dbo.IBT1 T2 ON T1.DocEntry = T2.BaseEntry AND T1.LineNum = T2.BaseLinNum AND T2.BaseType = 17
      LEFT JOIN [pksrv-sap].test.dbo.OBTN T3 ON T2.ItemCode = T3.ItemCode AND T2.BatchNum = T3.DistNumber
      LEFT JOIN [pksrv-sap].test.dbo.NNM1 T4 ON T4.Series = T0.Series AND T4.Indicator = YEAR(GETDATE()) AND T4.ObjectCode = '17'
      LEFT JOIN [pksrv-sap].test.dbo.CRD1 CRD1_S ON T0.CardCode = CRD1_S.CardCode AND T0.ShipToCode = CRD1_S.Address AND CRD1_S.AdresType = 'S'
      LEFT JOIN [pksrv-sap].test.dbo.CRD1 CRD1_B ON T0.CardCode = CRD1_B.CardCode AND T0.PayToCode = CRD1_B.Address AND CRD1_B.AdresType = 'B'
      CROSS APPLY (
          SELECT TOP 1 series AS sercode
          FROM [pksrv-sap].test.dbo.NNM1 AS T5
          WHERE T5.SeriesName LIKE '%' + 
              (
                  CASE
                      WHEN T4.SeriesName LIKE 'DO-%' THEN 'DJ-' + SUBSTRING(T4.SeriesName, CHARINDEX('-', T4.SeriesName) + 1, LEN(T4.SeriesName))
                      WHEN T4.SeriesName LIKE 'CO-%' THEN 'CJ-' + SUBSTRING(T4.SeriesName, CHARINDEX('-', T4.SeriesName) + 1, LEN(T4.SeriesName))
                      WHEN T4.SeriesName LIKE 'BO-%' THEN 'BJ-' + SUBSTRING(T4.SeriesName, CHARINDEX('-', T4.SeriesName) + 1, LEN(T4.SeriesName))
                      WHEN T4.SeriesName LIKE 'SO-%' THEN 'SJ-' + SUBSTRING(T4.SeriesName, CHARINDEX('-', T4.SeriesName) + 1, LEN(T4.SeriesName))
                      ELSE T4.SeriesName
                  END
              ) + '%'
            AND T5.ObjectCode = '15'
      ) AS SeriesCodeTable
      WHERE T0.DocNum = @doNo
      ORDER BY T1.LineNum
    `;
    
    const request = pool.request();
    const result = await request
      .input('doNo', sql.Int, doNo)
      .query(orderQuery);

    if (!result.recordset || result.recordset.length === 0) {
      throw new Error(`Order ${doNo} not found or no line items found.`);
    }

    const records = result.recordset;
    const firstRecord = records[0];

    const orderUrl = `${SAP_CONFIG.BASE_URL}/Orders(${docEntry})`;
    const sapOrderData = await makeApiRequest(orderUrl, 'GET', sessionCookie);

    if (!sapOrderData || !sapOrderData.DocDueDate || !sapOrderData.CardCode || !sapOrderData.DocumentLines) {
      const errorMessage = 'Incomplete order data received from SAP (missing DocDueDate, CardCode, or DocumentLines).';
      throw new Error(errorMessage);
    }

    docEntryFromSAP = sapOrderData.DocEntry;
    docNumFromSAP = sapOrderData.DocNum;

    const validationResult = await this.validateOrderWithColdspace(doNo, sapOrderData.DocumentLines, pool);
    if (!validationResult.isValid) {
      throw new Error(`Validation failed: ${validationResult.message}`);
    }

    const addressExtensionQuery = `
      SELECT TOP 1 -- Assuming address data is consistent across lines for one order
          T0.U_IDU_Nama_SupirS, T0.U_IDU_Nama_SupirB, T0.U_IDU_NoPlat_MblS, T0.U_IDU_NoPlat_MblB,
          T0.U_IDU_RuteS, T0.U_IDU_RuteB, T0.U_IDU_Rute_NameS, T0.U_IDU_Rute_NameB,
          T0.U_IDU_Status_DO,
          T1.Street AS ShipToStreet, T1.City AS ShipToCity, T1.ZipCode AS ShipToZipCode, T1.Country AS ShipToCountry,
          T2.Street AS BillToStreet, T2.Country AS BillToCountry
      FROM [pksrv-sap].test.dbo.ORDR T0
      LEFT JOIN [pksrv-sap].test.dbo.CRD1 T1 ON T0.CardCode = T1.CardCode AND T1.Address = T0.ShipToCode AND T1.AdresType = 'S'
      LEFT JOIN [pksrv-sap].test.dbo.CRD1 T2 ON T0.CardCode = T2.CardCode AND T2.AdresType = 'B'
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
      // console.error("Error retrieving AddressExtension data:", err.message);
    }

    const deliveryNotePayload = {
      "CardCode": sapOrderData.CardCode,
      "DocDate": formatDateToISO(new Date()), 
      "DocDueDate": formatDateToISO(sapOrderData.DocDueDate),
      "TaxDate": formatDateToISO(new Date()), 
      "Series": firstRecord.Series,
      "Comments": sapOrderData.Comments || "Based On Sales Order " + sapOrderData.DocNum,
      "BPL_IDAssignedToInvoice": sapOrderData.BPL_IDAssignedToInvoice || null,
      "TransportationCode": sapOrderData.TransportationCode || -1,
      "PaymentGroupCode": sapOrderData.PaymentGroupCode || 8,
      "SalesPersonCode": sapOrderData.SalesPersonCode || 12,
      "ShipToCode": sapOrderData.ShipToCode, 
      "U_IDU_Status_DO": addressExtensionData.U_IDU_Status_DO || "Kirim Besok",

      ...Object.keys(addressExtensionData).length > 0 && { "AddressExtension": addressExtensionData },

      "DocumentLines": sapOrderData.DocumentLines.map(line => {
        if (!line.ItemCode || line.Quantity === undefined || line.Quantity === null) {
          throw new Error(`Invalid line item data for line ${line.LineNum}: Missing ItemCode or Quantity.`);
        }

        const documentLine = {
          "ItemCode": line.ItemCode,
          "Quantity": parseFloat(line.Quantity),
          "BaseType": 17,
          "BaseEntry": sapOrderData.DocEntry,
          "BaseLine": line.LineNum,
          "WarehouseCode": line.WarehouseCode || ''
        };

        if (line.BatchNumbers && line.BatchNumbers.length > 0) {
          documentLine.BatchNumbers = line.BatchNumbers.map(batch => {
            if (!batch.BatchNumber || batch.Quantity === undefined || batch.Quantity === null) {
              throw new Error(`Invalid batch data for item ${line.ItemCode}, line ${line.LineNum}: Missing BatchNumber or Quantity.`);
            }
            return {
              "BatchNumber": batch.BatchNumber,
              "Quantity": parseFloat(batch.Quantity),
              "BaseLineNumber": line.LineNum
            };
          });
        }
        return documentLine;
      })
    };

    // console.log(JSON.stringify(deliveryNotePayload, null, 2));

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

    const notificationResult = await notificationService.sendWhatsAppNotification(
      doNo,
      response.DocNum,
      response.DocEntry,
      'Proses DO Berhasil',
      true,
      pool
    );

    if (notificationResult.success) {
      await pool.request()
        .input('doNo', sql.Int, doNo)
        .query('UPDATE r_dn_coldspace SET iswa = 1 WHERE DO_NO = @doNo');
    }

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

    return {
        status: 'error',
        message: errorMessageToLog,
        sapError: errorDetails.sapError
    };
  }
};


// exports.postDeliveryNoteToSAP = async (doNo, pool) => {
//   let sessionCookie;
//   let docEntry, docNum;

//   try {
//     sessionCookie = await this.loginToB1ServiceLayer();

//     const orderQuery = `
//       SELECT
//           T0.DocEntry,
//           T0.DocNum,
//           T0.DocDueDate,
//           T0.CardCode,
//           T1.ItemCode,
//           T1.Quantity,
//           T1.LineNum,
//           T1.WhsCode AS WarehouseCode,
//           T2.BatchNum,
//           T2.Quantity AS BatchQty,
//           T3.ExpDate AS ExpiryDate,
//           T3.MnfDate AS ManufacturingDate,
//           SeriesCodeTable.sercode as Series
//       FROM [pksrv-sap].test.dbo.ORDR T0
//       JOIN [pksrv-sap].test.dbo.RDR1 T1 ON T0.DocEntry = T1.DocEntry
//       LEFT JOIN [pksrv-sap].test.dbo.IBT1 T2 ON T1.DocEntry = T2.BaseEntry AND T1.LineNum = T2.BaseLinNum AND T2.BaseType = 17
//       LEFT JOIN [pksrv-sap].test.dbo.OBTN T3 ON T2.ItemCode = T3.ItemCode AND T2.BatchNum = T3.DistNumber
//       LEFT JOIN [pksrv-sap].test.dbo.NNM1 T4 ON T4.Series = T0.Series AND T4.Indicator = YEAR(GETDATE()) AND T4.ObjectCode = '17'
//       CROSS APPLY (
//           SELECT TOP 1 series AS sercode
//           FROM [pksrv-sap].test.dbo.NNM1 AS T5
//           WHERE T5.SeriesName LIKE '%' + 
//               (
//                   CASE
//                       WHEN T4.SeriesName LIKE 'DO-%' THEN 'DJ-' + SUBSTRING(T4.SeriesName, CHARINDEX('-', T4.SeriesName) + 1, LEN(T4.SeriesName))
//                       WHEN T4.SeriesName LIKE 'CO-%' THEN 'CJ-' + SUBSTRING(T4.SeriesName, CHARINDEX('-', T4.SeriesName) + 1, LEN(T4.SeriesName))
//                       WHEN T4.SeriesName LIKE 'BO-%' THEN 'BJ-' + SUBSTRING(T4.SeriesName, CHARINDEX('-', T4.SeriesName) + 1, LEN(T4.SeriesName))
//                       WHEN T4.SeriesName LIKE 'SO-%' THEN 'SJ-' + SUBSTRING(T4.SeriesName, CHARINDEX('-', T4.SeriesName) + 1, LEN(T4.SeriesName))
//                       ELSE T4.SeriesName
//                   END
//               ) + '%'
//             AND T5.ObjectCode = '15'
//       ) AS SeriesCodeTable
//       WHERE T0.DocNum = @doNo
//       order by t1.Linenum
//     `;

//     const orderResult = await pool.request()
//       .input('doNo', sql.Int, doNo)
//       .query(orderQuery);

//     if (!orderResult.recordset.length) {
//       throw new Error(`Order ${doNo} not found in SAP`);
//     }

//     const orderData = orderResult.recordset[0];
//     docEntry = orderData.DocEntry;
//     docNum = orderData.DocNum;

//     const validationResult = await this.validateOrderWithColdspace(doNo, orderResult.recordset, pool);
//     if (!validationResult.isValid) {
//       throw new Error(`Validation failed: ${validationResult.message}`);
//     }

//     const linesMap = new Map();
//     orderResult.recordset.forEach(row => {
//       if (!linesMap.has(row.LineNum)) {
//         linesMap.set(row.LineNum, {
//           ItemCode: row.ItemCode,
//           Quantity: row.Quantity,
//           LineNum: row.LineNum,
//           WarehouseCode: row.WarehouseCode || '',
//           BatchNumbers: []
//         });
//       }

//       if (row.BatchNum) {
//         linesMap.get(row.LineNum).BatchNumbers.push({
//           BatchNumber: row.BatchNum,
//           Quantity: row.BatchQty,
//           ExpiryDate: row.ExpiryDate,
//           ManufacturingDate: row.ManufacturingDate
//         });
//       }
//     });

//     const orderLines = Array.from(linesMap.values());

//     const deliveryNotePayload = {
//       CardCode: orderData.CardCode,
//       DocDueDate: orderData.DocDueDate,
//       Series: orderData.Series,
//       DocumentLines: orderLines.map(line => {
//         const docLine = {
//           ItemCode: line.ItemCode,
//           Quantity: line.Quantity,
//           BaseType: 17,
//           BaseEntry: orderData.DocEntry,
//           BaseLine: line.LineNum,
//           WarehouseCode: line.WarehouseCode
//         };

//         if (line.BatchNumbers && line.BatchNumbers.length > 0) {
//           docLine.BatchNumbers = line.BatchNumbers.map(batch => ({
//             BatchNumber: batch.BatchNumber,
//             Quantity: batch.Quantity,
//             BaseLineNumber: line.LineNum,
//             ExpiryDate: batch.ExpiryDate || null,
//             ManufacturingDate: batch.ManufacturingDate || null
//           }));
//         }

//         return docLine;
//       })
//     };

//     console.log(JSON.stringify(deliveryNotePayload,2));

//     const response = await this.makeApiRequest(
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
//         SET doc_entry = @docEntry, doc_num = @docNum, jo_status = 3
//         WHERE DO_NO = @doNo
//       `);

//     console.log('------------------------------------------------------------------------------------');
//     console.log('Process : ' + doNo + ' | Status : Success');

//     const notificationResult = await notificationService.sendWhatsAppNotification(
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
//     let errorMessageToLog = "Unknown error occurred.";

//     if (typeof error.message === 'string') {
//       try {
//         const errorMessageObject = JSON.parse(error.message);
//         if (errorMessageObject?.sapError?.message?.value) {
//           errorMessageToLog = errorMessageObject.sapError.message.value;
//         } else {
//           errorMessageToLog = error.message;
//         }
//       } catch (parseError) {
//         errorMessageToLog = error.message;
//       }
//     } else if (error instanceof Error) {
//       errorMessageToLog = error.message;
//     } else {
//       errorMessageToLog = JSON.stringify(error);
//     }

//     console.log('------------------------------------------------------------------------------------');
//     console.log('Process : ' + doNo + ' | Error :' + errorMessageToLog);

//     let statusx = (errorMessageToLog.includes('matching')) ? 0 : 2;

//     await notificationService.sendWhatsAppNotification(
//       doNo,
//       docNum || null,
//       docEntry || null,
//       errorMessageToLog,
//       false,
//       pool
//     );

//     await pool.request()
//       .input('doNo', sql.Int, doNo)
//       .input('status', sql.Int, statusx)
//       .input('error', sql.NVarChar, errorMessageToLog)
//       .query(`
//         UPDATE r_dn_coldspace
//         SET note = @error, jo_status = @status
//         WHERE DO_NO = @doNo
//       `);

//     return {
//       status: 'error',
//       message: errorMessageToLog,
//       sapError: error.response?.data
//     };
//   }
// };


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
    console.error('Validation error:', error);
    return { isValid: false, message: 'Validation error: ' + error.message };
  }
};

// exports.postDeliveryNoteToSAP = async (doNo, pool) => {
//   let sessionCookie;
  
//   try {
//     // 1. Dapatkan session
//     sessionCookie = await this.loginToB1ServiceLayer();
    
//     // 2. Dapatkan data order dari database SQL
//     const orderQuery = `
//       SELECT 
//         T0.DocEntry, T0.DocNum, T0.DocDueDate, T0.CardCode,
//         T1.ItemCode, T1.Quantity, T1.LineNum, 
//         T1.WhsCode AS WarehouseCode,
//         T2.BatchNum, T2.Quantity AS BatchQty
//       FROM [pksrv-sap].test.dbo.ORDR T0
//       JOIN [pksrv-sap].test.dbo.RDR1 T1 ON T0.DocEntry = T1.DocEntry
//       LEFT JOIN [pksrv-sap].test.dbo.IBT1 T2 ON T1.DocEntry = T2.BaseEntry AND T1.LineNum = T2.BaseLinNum AND T2.BaseType = 17
//       WHERE T0.DocNum = @doNo
//     `;

//     const orderResult = await pool.request()
//       .input('doNo', sql.Int, doNo)
//       .query(orderQuery);

//     if (!orderResult.recordset.length) {
//       throw new Error(`Order ${doNo} not found in SAP`);
//     }

//     const orderData = orderResult.recordset[0];
    
//     // Group lines by LineNum to handle batch numbers
//     const linesMap = new Map();
//     orderResult.recordset.forEach(row => {
//       if (!linesMap.has(row.LineNum)) {
//         linesMap.set(row.LineNum, {
//           ItemCode: row.ItemCode,
//           Quantity: row.Quantity,
//           LineNum: row.LineNum,
//           WarehouseCode: row.WarehouseCode || '',
//           BatchNumbers: []
//         });
//       }
      
//       // Add batch number if exists
//       if (row.BatchNum) {
//         linesMap.get(row.LineNum).BatchNumbers.push({
//           BatchNumber: row.BatchNum,
//           Quantity: row.BatchQty
//         });
//       }
//     });

//     const orderLines = Array.from(linesMap.values());

//     // 3. Siapkan payload untuk Delivery Note
//     const deliveryNotePayload = {
//       CardCode: orderData.CardCode,
//       DocDueDate: orderData.DocDueDate,
//       DocumentLines: orderLines.map(line => {
//         const docLine = {
//           ItemCode: line.ItemCode,
//           Quantity: line.Quantity,
//           BaseType: 17, // Order
//           BaseEntry: orderData.DocEntry,
//           BaseLine: line.LineNum,
//           WarehouseCode: line.WarehouseCode
//         };
        
//         // Tambahkan batch numbers jika ada
//         if (line.BatchNumbers && line.BatchNumbers.length > 0) {
//           docLine.BatchNumbers = line.BatchNumbers.map(batch => ({
//             BatchNumber: batch.BatchNumber,
//             Quantity: batch.Quantity,
//             BaseLineNumber: line.LineNum
//           }));
//         }
        
//         return docLine;
//       })
//     };

//     // 4. Post ke SAP
//     const response = await this.makeApiRequest(
//       `${SAP_CONFIG.BASE_URL}/DeliveryNotes`,
//       'POST',
//       sessionCookie,
//       deliveryNotePayload
//     );

//     // 5. Simpan hasil ke database
//     await pool.request()
//       .input('doNo', sql.Int, doNo)
//       .input('docEntry', sql.Int, response.DocEntry)
//       .input('docNum', sql.Int, response.DocNum)
//       .query(`
//         UPDATE r_dn_coldspace 
//         SET doc_entry = @docEntry, doc_num = @docNum ,
//         iswa = CASE WHEN @status IN (1,3) THEN 1 ELSE iswa END
//         WHERE DO_NO = @doNo
//       `);

//     console.log('------------------------------------------------------------------------------------');
//     console.log('Process : '+doNo+' | Status : Success');

//     await notificationService.sendWhatsAppNotification(
//       doNo,
//       errorDetails?.DocNum,
//       errorDetails?.DocEntry,
//       'Proses DO Berhasil',
//       3,pool
//     );
    
//     return {
//       status: 'success',
//       docEntry: response.DocEntry,
//       docNum: response.DocNum
//     };
//   } catch (error) {
    
//     let errorMessageToLog = "Unknown error occurred.";

//     if (typeof error.message === 'string') {
//       try {
//         const errorMessage
// ject = JSON.parse(error.message);
//         if (errorMessageObject && errorMessageObject.sapError && errorMessageObject.sapError.message && typeof errorMessageObject.sapError.message.value === 'string') {
//           errorMessageToLog = errorMessageObject.sapError.message.value;
//         } else {
//           errorMessageToLog = error.message;
//         }
//       } catch (parseError) {
//         errorMessageToLog = error.message;
//       }
//     } else if (error instanceof Error) {
//       errorMessageToLog = error.message;
//     } else {
//       errorMessageToLog = JSON.stringify(error);
//     }

//     console.log('------------------------------------------------------------------------------------');
//     console.log('Process : '+doNo+' | Error :'+errorMessageToLog);

//     let statusx = (errorMessageToLog.includes('matching')) ? 0 : 2;

//     await notificationService.sendWhatsAppNotification(
//       doNo,null,null,
//       errorMessageToLog,
//       null,
//       2
//     );

//     await pool.request()
//       .input('doNo', sql.Int, doNo)
//       .input('status', sql.Int, statusx)
//       .input('error', sql.NVarChar, errorMessageToLog)
//       .query(`
//         UPDATE r_dn_coldspace
//         SET note = @error , jo_status = @status,
//         iswa = CASE WHEN @status IN (1,2,3) THEN 1 ELSE iswa END
//         WHERE DO_NO = @doNo
//       `);

//     return {
//       status: 'error',
//       message: errorMessageToLog,
//       sapError: error.response?.data
//     };
//   }
// };


// exports.postDeliveryNoteToSAP = async (doNo, pool) => {
//   let sessionCookie;
  
//   try {
//     // 1. Dapatkan session
//     sessionCookie = await this.loginToB1ServiceLayer();
    
//     // 2. Dapatkan data order dari database SQL
//     const orderQuery = `
//       SELECT 
//         T0.DocEntry, T0.DocNum, T0.DocDueDate, T0.CardCode,
//         T1.ItemCode, T1.Quantity, T1.LineNum, 
//         T1.WhsCode AS WarehouseCode
//       FROM [pksrv-sap].test.dbo.ORDR T0
//       JOIN [pksrv-sap].test.dbo.RDR1 T1 ON T0.DocEntry = T1.DocEntry
//       WHERE T0.DocNum = @doNo
//     `;

//     const orderResult = await pool.request()
//       .input('doNo', sql.Int, doNo)
//       .query(orderQuery);

//     if (!orderResult.recordset.length) {
//       throw new Error(`Order ${doNo} not found in SAP`);
//     }

//     const orderData = orderResult.recordset[0];
//     const orderLines = orderResult.recordset;

//     // 3. Siapkan payload untuk Delivery Note
//     const deliveryNotePayload = {
//       CardCode: orderData.CardCode,
//       DocDueDate: orderData.DocDueDate,
//       DocumentLines: orderLines.map(line => ({
//         ItemCode: line.ItemCode,
//         Quantity: line.Quantity,
//         BaseType: 17, // Order
//         BaseEntry: orderData.DocEntry,
//         BaseLine: line.LineNum,
//         WarehouseCode: line.WarehouseCode || ''
//       }))
//     };

//     // 4. Post ke SAP
//     const response = await this.makeApiRequest(
//       `${SAP_CONFIG.BASE_URL}/DeliveryNotes`,
//       'POST',
//       sessionCookie,
//       deliveryNotePayload
//     );

    

//     // 5. Simpan hasil ke database
//     await pool.request()
//       .input('doNo', sql.Int, doNo)
//       .input('docEntry', sql.Int, response.DocEntry)
//       .input('docNum', sql.Int, response.DocNum)
//       .query(`
//         UPDATE r_dn_coldspace 
//         SET doc_entry = @docEntry, doc_num = @docNum 
//         WHERE DO_NO = @doNo
//       `);

//       // console.log(JSON.stringify(payload, null, 2));
//     console.log('------------------------------------------------------------------------------------');
//     console.log('Process : '+doNo+' | Status : Cek Dulu');
            
//     return {
//       status: 'success',
//       docEntry: response.DocEntry,
//       docNum: response.DocNum
//     };
//   } catch (error) {
//     // console.error(`Failed to post DO ${doNo}:`, error.message);
    
//     const errorMessageObject = JSON.parse(error.message);
//     console.log('------------------------------------------------------------------------------------');
//     console.log('Process : '+doNo+' | Error :'+errorMessageObject.sapError.message.value);
//     // Log error ke database
//     await pool.request()
//       .input('doNo', sql.Int, doNo)
//       .input('error', sql.NVarChar, error.message)
//       .query(`
//         UPDATE r_dn_coldspace 
//         SET note = @error 
//         WHERE DO_NO = @doNo
//       `);

//     return {
//       status: 'error',
//       message: error.message,
//       sapError: error.response?.data
//     };
//   }
// };

exports.checkDeliveryNoteStatus = async (docEntry) => {
  try {
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
    console.error(`Error checking DN ${docEntry}:`, error.message);
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

  // console.log(JSON.stringify(data, null, 2));
//   console.log(data);

  try {
    const response = await axios(config);
    return response.data;
  } catch (error) {
    // console.log(error);
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
        .query('SELECT DISTINCT DocEntry FROM [pksrv-sap].test.dbo.ORDR WITH (NOLOCK) WHERE DocNum = @doNo');

    if (!docEntryResult.recordset || docEntryResult.recordset.length === 0) {
        sapDocEntry = docNum;
    } else {
        sapDocEntry = docEntryResult.recordset[0].DocEntry;
    }

    const sessionCookie = await this.loginToB1ServiceLayer();
    const url = `${SAP_CONFIG.BASE_URL}/Orders(${sapDocEntry})`;

    try {
        const response = await this.makeApiRequest(url, 'GET', sessionCookie);
        if (response && Object.keys(response).length > 0) {
            return response;
        } else {
            console.log('------------------------------------------------------------------------------------');
            console.log('Process : '+docNum+' | Error : No order data or empty response found from SAP for DocEntry:'+sapDocEntry);
            // console.warn(`No order data or empty response found from SAP for DocEntry: ${sapDocEntry}`);
            return null;
        }
    } catch (error) {
        
      const errorMessageObject = JSON.parse(error.message);
      console.log('------------------------------------------------------------------------------------');
      console.log('Process : '+docNum+' | Error :'+errorMessageObject.sapError.message.value);
    }
};