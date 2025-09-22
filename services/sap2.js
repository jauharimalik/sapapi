const axios = require('axios');
const https = require('https');
const sql = require('mssql');
const dbConfig = require('../config/dbConfig');

const notificationService = require('./notificationService');

// Konfigurasi SAP B1
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

// Helper function untuk delay
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

let getDfltwhForSKU = async (sku)=>{
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


// exports.loginToB1ServiceLayer = async () => {

//   if (sapSessionCache.cookie && sapSessionCache.expires > new Date()) {
//     return sapSessionCache.cookie;
//   }

//   try {
//     const response = await axios.post(
//       `${SAP_CONFIG.BASE_URL}/Login`,
//       {
//         CompanyDB: SAP_CONFIG.COMPANY_DB,
//         UserName: SAP_CONFIG.CREDENTIALS.username,
//         Password: SAP_CONFIG.CREDENTIALS.password
//       },
//       {
//         httpsAgent: new https.Agent({ rejectUnauthorized: false }),
//         timeout: 10000
//       }
//     );

//     const cookies = response.headers['set-cookie'];
//     if (!cookies) throw new Error('No session cookie received');

//     const sessionCookie = cookies
//       .filter(c => c.includes('B1SESSION=') || c.includes('ROUTEID='))
//       .map(c => c.split(';')[0])
//       .join('; ');

//     sapSessionCache = {
//       cookie: sessionCookie,
//       expires: new Date(Date.now() + 30 * 60 * 1000)
//     };

//     return sessionCookie;
//   } catch (error) {
//     console.error('SAP Login Error:', error.response?.data || error.message);
//     throw new Error(`Login failed: ${error.message}`);
//   }
// };


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


// const updateDOStatusWithNote = async (doNo, docNum, joStatus, errorDetails, pool) => {
//   let errorMessageToLog = "Unknown error occurred.";
//   if (errorDetails.message) {
//       errorMessageToLog = errorDetails.message;
//   } else if (errorDetails.sapError?.message?.value) {
//       errorMessageToLog = errorDetails.sapError.message.value;
//   }

//   console.log('------------------------------------------------------------------------------------');
//   console.log(`Process : ${doNo} | Error Update : ${errorMessageToLog}`);

//   // Cek jika error disebabkan oleh dokumen yang sudah closed
//   const isClosedError = errorMessageToLog.toLowerCase().includes('closed');
  
//   let statusx = joStatus;
//   let note = errorMessageToLog;
  
//   if (isClosedError) {
//     // Jika error karena dokumen closed, langsung update sebagai sukses
//     statusx = 3;
//     note = 'Successfully posted to SAP';
    
//     console.log(`Process : ${doNo} | Treating as success: ${note}`);
    
//     // Update database langsung
//     await pool.request()
//         .input('doNo', sql.Int, doNo)
//         .input('status', sql.Int, statusx)
//         .input('error', sql.NVarChar, note)
//         .query(`
//             UPDATE r_dn_coldspace
//             SET note = @error, jo_status = @status, iswa = 1
//             WHERE DO_NO = @doNo
//         `);

//     // Kirim notifikasi sukses
//     await delay(30000);
//     await notificationService.sendWhatsApp(
//         doNo,
//         docNum || null,
//         errorDetails.docEntry || null,
//         'Proses DO Berhasil (dokumen sudah closed)',
//         true,
//         pool
//     );
    
//     return; // Langsung return, tidak perlu proses lebih lanjut

//   } else {
//     // Untuk error lainnya, gunakan logika yang sudah ada
//     statusx = (errorMessageToLog.toLowerCase().includes('matching') || errorMessageToLog.toLowerCase().includes('match')) ? 0 : joStatus;
//   }

//   // Update database untuk error non-closed
//   await pool.request()
//       .input('doNo', sql.Int, doNo)
//       .input('status', sql.Int, statusx)
//       .input('error', sql.NVarChar, note)
//       .query(`
//           UPDATE r_dn_coldspace
//           SET note = @error, jo_status = @status, iswa = 1
//           WHERE DO_NO = @doNo
//       `);

//   // Kirim notifikasi untuk error non-closed
//   if(statusx == 3){
//     await delay(30000);
//     await notificationService.sendWhatsApp(
//         doNo,
//         docNum || null,
//         errorDetails.docEntry || null,
//         errorMessageToLog,
//         1,
//         pool
//     );
//   } else {  
//     await delay(30000);
//     await notificationService.sendWhatsApp(
//         doNo,
//         docNum || null,
//         errorDetails.docEntry || null,
//         errorMessageToLog,
//         false,
//         pool
//     );
//   }
// };

async function checkInventoryBeforePosting(doNo, documentLines, sessionCookie) {
  try {
    for (const line of documentLines) {
      const inventoryUrl = `${SAP_CONFIG.BASE_URL}/Items('${line.ItemCode}')/Warehouses?$filter=WarehouseCode eq '${line.WarehouseCode}'`;
      const inventoryData = await makeApiRequest(inventoryUrl, 'GET', sessionCookie);
      
      if (inventoryData.value && inventoryData.value.length > 0) {
        const availableQty = parseFloat(inventoryData.value[0].InStock);
        const requiredQty = parseFloat(line.Quantity);
        
        if (availableQty < requiredQty) {
          throw new Error(`Negative inventory prevented for item ${line.ItemCode} in warehouse ${line.WarehouseCode}. Available: ${availableQty}, Required: ${requiredQty}`);
        }
      }
    }
    return true;
  } catch (error) {
    console.error(`Inventory check failed for DO ${doNo}:`, error.message);
    throw error;
  }
}

const updateDOStatusWithNote = async (doNo, docNum, joStatus, errorDetails, pool) => {
  let errorMessageToLog = "Unknown error occurred.";
  if (errorDetails.message) {
      errorMessageToLog = errorDetails.message;
  } else if (errorDetails.sapError?.message?.value) {
      errorMessageToLog = errorDetails.sapError.message.value;
  }

  console.log('------------------------------------------------------------------------------------');
  console.log(`Process : ${doNo} | Error Update : ${errorMessageToLog}`);

  // Cek jenis error
  const isClosedError = errorMessageToLog.toLowerCase().includes('closed');
  const isNegativeInventory = errorMessageToLog.toLowerCase().includes('negative inventory');
  
  let statusx = joStatus;
  let note = errorMessageToLog;
  
  if (isClosedError) {
    // Jika error karena dokumen closed, langsung update sebagai sukses
    statusx = 3;
    note = 'Successfully posted to SAP (document was already closed)';
  } else if (isNegativeInventory) {
    // Jika error negative inventory, set status khusus (misalnya 4) untuk penanganan manual
    statusx = 4;
    note = `Negative inventory error: ${errorMessageToLog}. Requires manual intervention.`;
  } else {
    // Untuk error lainnya, gunakan logika yang sudah ada
    statusx = (errorMessageToLog.toLowerCase().includes('matching') || errorMessageToLog.toLowerCase().includes('match')) ? 0 : joStatus;
  }

  // Update database
  await pool.request()
      .input('doNo', sql.Int, doNo)
      .input('status', sql.Int, statusx)
      .input('error', sql.NVarChar, note)
      .query(`
          UPDATE r_dn_coldspace
          SET note = @error, jo_status = @status, iswa = 1
          WHERE DO_NO = @doNo
      `);

  // Kirim notifikasi berdasarkan status
  if (statusx === 3) {
    await delay(300);
    await notificationService.sendWhatsApp(
        doNo,
        docNum || null,
        errorDetails.docEntry || null,
        'Proses DO Berhasil',
        true,
        pool
    );
  } else if (statusx === 4) {
    // Notifikasi khusus untuk negative inventory
    await delay(300);
    await notificationService.sendWhatsApp(
        doNo,
        docNum || null,
        errorDetails.docEntry || null,
        `⚠️ PERHATIAN: Negative Inventory Error - DO ${doNo} memerlukan penanganan manual`,
        false,
        pool
    );
  } else {
    await delay(300);
    await notificationService.sendWhatsApp(
        doNo,
        docNum || null,
        errorDetails.docEntry || null,
        errorMessageToLog,
        false,
        pool
    );
  }
};
const formatDateToISO = (date) => {
    if (!date) return null;
    const d = new Date(date);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};

// async function createDocumentLines(sapOrderData, doNo, pool, sessionCookie) {
//   const documentLines = [];
  
//   // Validasi data awal
//   if (!sapOrderData.DocumentLines || sapOrderData.DocumentLines.length === 0) {
//     throw new Error('No document lines found in SAP order data');
//   }

//   for (const line of sapOrderData.DocumentLines) {
//     try {
//       // Validasi line item
//       if (!line.ItemCode || line.Quantity === undefined || line.Quantity === null) {
//         console.warn(`Skipping invalid line item: ${JSON.stringify(line)}`);
//         continue;
//       }

//       // Dapatkan data warehouse
//       const warehouseData = await getWarehouseData(doNo, line.ItemCode, pool);
      
//       // Buat document line
//       const documentLine = {
//         "ItemCode": line.ItemCode,
//         "Quantity": parseFloat(line.Quantity),
//         "BaseType": 17,
//         "BaseEntry": sapOrderData.DocEntry,
//         "BaseLine": line.LineNum,
//         "WarehouseCode": sapOrderData.WarehouseCode || 'CS-03' // Default warehouse
//       };

//       // Tambahkan batch numbers jika ada
//       if (line.BatchNumbers && line.BatchNumbers.length > 0) {
//         documentLine.BatchNumbers = await getBatchNumbers(doNo, line, pool);
//       }

//       documentLines.push(documentLine);
//     } catch (lineError) {
//       console.error(`Error processing line ${line.LineNum}:`, lineError);
//     }
//   }

//   return documentLines;
// }

async function createDocumentLines(sapOrderData, doNo, pool, sessionCookie) {
  const documentLines = [];
  
  // Validasi data awal
  if (!sapOrderData.DocumentLines || sapOrderData.DocumentLines.length === 0) {
    throw new Error('No document lines found in SAP order data');
  }

  for (const line of sapOrderData.DocumentLines) {
    try {
      // Validasi line item
      if (!line.ItemCode || line.Quantity === undefined || line.Quantity === null) {
        console.warn(`Skipping invalid line item: ${JSON.stringify(line)}`);
        continue;
      }
      
      const warehouseData = await getWarehouseData(doNo, line.ItemCode, pool);
      let warehouseCode = 'CS-03'; // default
      if (typeof warehouseData === 'string') {
        warehouseCode = warehouseData;
      } else if (warehouseData && typeof warehouseData === 'object') {
        // Jika ternyata object, coba extract string-nya
        warehouseCode = warehouseData.site || warehouseData.whsCode || 'CS-03';
      }
      
      // Pastikan warehouseCode adalah string yang valid
      warehouseCode = String(warehouseCode).trim();

      const documentLine = {
        "ItemCode": line.ItemCode,
        "Quantity": parseFloat(line.Quantity),
        "BaseType": 17,
        "BaseEntry": sapOrderData.DocEntry,
        "BaseLine": line.LineNum,
        "WarehouseCode": warehouseCode  || null // Default warehouse
      };

      // Tambahkan batch numbers jika ada - PASS sessionCookie parameter
      if (line.BatchNumbers && line.BatchNumbers.length > 0) {
        documentLine.BatchNumbers = await getBatchNumbers(doNo, line, pool, sessionCookie);
      }

      documentLines.push(documentLine);
    } catch (lineError) {
      console.error(`Error processing line ${line.LineNum}:`, lineError);
    }
  }

  return documentLines;
}

async function getWarehouseData(doNo, itemCode, pool) {
  const query = `
    SELECT TOP 1 
      t1.sup_site as site
    FROM r_dn_coldspace t0
    INNER JOIN r_do_coldspace_dev t1 on t0.do_no = t1.do_no
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

    if (!result.recordset || result.recordset.length === 0) {
      // Fallback logic for specific SKUs
      const defaultWh = await getDfltwhForSKU(itemCode);
      return defaultWh || 'CS-03';
    }

    const record = result.recordset[0];
    return record.site || 'CS-03';

  } catch (error) {
    console.error(`Error getting warehouse for DO ${doNo}, Item ${itemCode}:`, error);
    const defaultWh = await getDfltwhForSKU(itemCode);
    return defaultWh || 'CS-03';
  }
}


// async function getBatchNumbers(doNo, line, pool) {
//   const batchNumbers = [];
  
//   for (const batch of line.BatchNumbers) {
//     if (!batch.BatchNumber || batch.Quantity === undefined) {
//       // console.warn(`Invalid batch data for item ${line.ItemCode}`);
//       continue;
//     }

//     try {
//       const result = await pool.request()
//         .input('doNo', sql.Int, doNo)
//         .input('sku', sql.VarChar, line.ItemCode)
//         .query(`SELECT TOP 1 oibt.batchnum 
//                 FROM [db_pandurasa].dbo.r_dn_coldspace t0
//                 INNER JOIN [PKSRV-SAP].[PANDURASA_LIVE].dbo.OIBT 
//                   ON OIBT.ItemCode COLLATE SQL_Latin1_General_CP1_CI_AS = t0.SKU COLLATE SQL_Latin1_General_CP1_CI_AS
//                   AND OIBT.Quantity > t0.QTY 
//                   AND OIBT.Batchnum COLLATE SQL_Latin1_General_CP1_CI_AS like '%' + t0.expired_date + '%' COLLATE SQL_Latin1_General_CP1_CI_AS
//                 WHERE t0.ORDER_TYPE != 'N-STO' 
//                   AND t0.ORDER_TYPE != 'PROD' 
//                   AND t0.ismatch = 1 
//                   AND (t0.jo_status IS NULL OR t0.iswa IS NULL) 
//                   AND t0.DO_NO = @doNo 
//                   AND t0.SKU = @sku`);


//       const batchnumber = result.recordset.length > 0 ? result.recordset[0].batchnum : batch.BatchNumber;
      
//       batchNumbers.push({
//         "BatchNumber": batchnumber,
//         "Quantity": parseFloat(batch.Quantity),
//         "BaseLineNumber": line.LineNum
//       });
//     } catch (error) {
//       console.error(`Error fetching batch for ${line.ItemCode}:`, error);
//       batchNumbers.push({
//         "BatchNumber": batch.BatchNumber,
//         "Quantity": parseFloat(batch.Quantity),
//         "BaseLineNumber": line.LineNum
//       });
//     }
//   }

//   return batchNumbers;
// }

// async function getBatchNumbersFromServiceLayer(doNo, line, sessionCookie) {
//   const batchNumbers = [];
  
//   try {
//     // Cek jika session masih valid
//     if (!sessionCookie || !sapSessionCache.cookie || sapSessionCache.expires <= new Date()) {
//       throw new Error('Session expired, cannot fetch batch numbers');
//     }

//     // Ambil DocEntry dari order berdasarkan DO_NO
//     const docEntryUrl = `${SAP_CONFIG.BASE_URL}/Orders?$filter=DocNum eq ${doNo}&$select=DocEntry`;
//     const orderResponse = await makeApiRequest(docEntryUrl, 'GET', sessionCookie);
    
//     if (!orderResponse.value || orderResponse.value.length === 0) {
//       throw new Error(`Order ${doNo} not found in Service Layer`);
//     }
    
//     const docEntry = orderResponse.value[0].DocEntry;
    
//     // Ambil batch numbers untuk line item tertentu
//     const batchUrl = `${SAP_CONFIG.BASE_URL}/Orders(${docEntry})/DocumentLines(${line.LineNum})/BatchNumbers`;
//     const batchResponse = await makeApiRequest(batchUrl, 'GET', sessionCookie);
    
//     // Jika batch numbers ditemukan di Service Layer
//     if (batchResponse.value && batchResponse.value.length > 0) {
//       for (const batch of batchResponse.value) {
//         batchNumbers.push({
//           "BatchNumber": batch.BatchNumber,
//           "Quantity": parseFloat(batch.Quantity),
//           "BaseLineNumber": line.LineNum
//         });
//       }
//       return batchNumbers;
//     }
    
//     return []; // Return empty array jika tidak ada batch numbers

//   } catch (error) {
//     console.error(`Error fetching batch numbers from Service Layer for DO ${doNo}:`, error.message);
//     throw error; // Re-throw error untuk ditangani di level atas
//   }
// }

// async function getBatchNumbersFromServiceLayer(doNo, line, sessionCookie) {
//   const batchNumbers = [];
  
//   try {
//     // Cek jika session masih valid dengan cara yang lebih robust
//     if (!sessionCookie || !sessionCookie.includes('B1SESSION=')) {
//       // Coba login ulang jika session tidak valid
//       sessionCookie = await exports.loginToB1ServiceLayer();
//     }

//     // Ambil DocEntry dari order berdasarkan DO_NO
//     const docEntryUrl = `${SAP_CONFIG.BASE_URL}/Orders?$filter=DocNum eq ${doNo}&$select=DocEntry`;
//     const orderResponse = await makeApiRequest(docEntryUrl, 'GET', sessionCookie);
    
//     if (!orderResponse.value || orderResponse.value.length === 0) {
//       throw new Error(`Order ${doNo} not found in Service Layer`);
//     }
    
//     const docEntry = orderResponse.value[0].DocEntry;
    
//     // Ambil batch numbers untuk line item tertentu
//     const batchUrl = `${SAP_CONFIG.BASE_URL}/Orders(${docEntry})/DocumentLines(${line.LineNum})/BatchNumbers`;
//     const batchResponse = await makeApiRequest(batchUrl, 'GET', sessionCookie);
    
//     // Jika batch numbers ditemukan di Service Layer
//     if (batchResponse.value && batchResponse.value.length > 0) {
//       for (const batch of batchResponse.value) {
//         batchNumbers.push({
//           "BatchNumber": batch.BatchNumber,
//           "Quantity": parseFloat(batch.Quantity),
//           "BaseLineNumber": line.LineNum
//         });
//       }
//       return batchNumbers;
//     }
    
//     return []; // Return empty array jika tidak ada batch numbers

//   } catch (error) {
//     console.error(`Error fetching batch numbers from Service Layer for DO ${doNo}:`, error.message);
    
//     // Jika error session expired, coba refresh session dan retry sekali
//     if (error.message.includes('Session expired') || error.message.includes('session')) {
//       try {
//         console.log(`Attempting to refresh session for DO ${doNo}...`);
//         sessionCookie = await exports.loginToB1ServiceLayer();
//         return await getBatchNumbersFromServiceLayer(doNo, line, sessionCookie);
//       } catch (retryError) {
//         console.error(`Retry failed for DO ${doNo}:`, retryError.message);
//       }
//     }
    
//     throw error; // Re-throw error untuk ditangani di level atas
//   }
// }

// async function getBatchNumbersFromServiceLayer(doNo, line, sessionCookie) {
//   const batchNumbers = [];
  
//   try {
//     // Cek jika session masih valid
//     if (!sessionCookie || !sessionCookie.includes('B1SESSION=')) {
//       sessionCookie = await exports.loginToB1ServiceLayer();
//     }

//     // Ambil DocEntry dari order berdasarkan DO_NO
//     const docEntryUrl = `${SAP_CONFIG.BASE_URL}/Orders?$filter=DocNum eq ${doNo}&$select=DocEntry`;
//     const orderResponse = await makeApiRequest(docEntryUrl, 'GET', sessionCookie);
    
//     if (!orderResponse.value || orderResponse.value.length === 0) {
//       throw new Error(`Order ${doNo} not found in Service Layer`);
//     }
    
//     const docEntry = orderResponse.value[0].DocEntry;
    
//     // FIXED: Gunakan endpoint yang benar untuk batch numbers
//     // Format: /Orders({DocEntry})/DocumentLines({LineNum})/BatchNumbers
//     const batchUrl = `${SAP_CONFIG.BASE_URL}/Orders(${docEntry})/DocumentLines(${line.LineNum})/BatchNumbers`;
    
//     const batchResponse = await makeApiRequest(batchUrl, 'GET', sessionCookie);
    
//     // Jika batch numbers ditemukan di Service Layer
//     if (batchResponse.value && batchResponse.value.length > 0) {
//       for (const batch of batchResponse.value) {
//         batchNumbers.push({
//           "BatchNumber": batch.BatchNumber,
//           "Quantity": parseFloat(batch.Quantity),
//           "BaseLineNumber": line.LineNum
//         });
//       }
//       return batchNumbers;
//     }
    
//     return []; // Return empty array jika tidak ada batch numbers

//   } catch (error) {
//     console.error(`Error fetching batch numbers from Service Layer for DO ${doNo}:`, error.message);
    
//     // Jika error session expired, coba refresh session dan retry sekali
//     if (error.message.includes('Session expired') || error.message.includes('session') || error.message.includes('401')) {
//       try {
//         console.log(`Attempting to refresh session for DO ${doNo}...`);
//         sessionCookie = await exports.loginToB1ServiceLayer();
//         return await getBatchNumbersFromServiceLayer(doNo, line, sessionCookie);
//       } catch (retryError) {
//         console.error(`Retry failed for DO ${doNo}:`, retryError.message);
//       }
//     }
    
//     throw error;
//   }
// }
async function getBatchNumbersFromOrder(orderData, lineNum, itemCode) {
  try {
      // Cari line yang sesuai
      const documentLine = orderData.DocumentLines.find(line => 
          line.LineNum === lineNum && line.ItemCode === itemCode
      );
      
      if (documentLine && documentLine.BatchNumbers) {
          return documentLine.BatchNumbers.map(batch => ({
              BatchNumber: batch.BatchNumber,
              Quantity: batch.Quantity,
              ExpiryDate: batch.ExpiryDate,
              ManufacturingDate: batch.ManufacturingDate,
              AddmisionDate: batch.AddmisionDate,
              InternalSerialNumber: batch.InternalSerialNumber
          }));
      }
      
      return [];
  } catch (error) {
      console.error(`Error extracting batch numbers from order data for Line ${lineNum}:`, error);
      return [];
  }
}

async function getBatchNumbersFromServiceLayer(doNo, line, sessionCookie) {
  const batchNumbers = [];
  
  try {
    // Cek jika session masih valid
    if (!sessionCookie || !sessionCookie.includes('B1SESSION=')) {
      sessionCookie = await exports.loginToB1ServiceLayer();
    }

    // Ambil DocEntry dari order berdasarkan DO_NO
    const docEntryUrl = `${SAP_CONFIG.BASE_URL}/Orders?$filter=DocNum eq ${doNo}&$select=DocEntry`;
    const orderResponse = await makeApiRequest(docEntryUrl, 'GET', sessionCookie);
    
    if (!orderResponse.value || orderResponse.value.length === 0) {
      throw new Error(`Order ${doNo} not found in Service Layer`);
    }
    
    const docEntry = orderResponse.value[0].DocEntry;
    
    // PERBAIKAN: Gunakan endpoint yang benar untuk batch numbers
    // Format yang benar: /Orders({DocEntry})/DocumentLines({LineNum})/BatchNumbers
    const batchUrl = `${SAP_CONFIG.BASE_URL}/Orders(${docEntry})/DocumentLines(${line.LineNum})/BatchNumbers`;
    
    const batchResponse = await makeApiRequest(batchUrl, 'GET', sessionCookie);
    
    // Jika batch numbers ditemukan di Service Layer
    if (batchResponse.value && batchResponse.value.length > 0) {
      for (const batch of batchResponse.value) {
        batchNumbers.push({
          "BatchNumber": batch.BatchNumber,
          "Quantity": parseFloat(batch.Quantity),
          "BaseLineNumber": line.LineNum
        });
      }
      return batchNumbers;
    }
    
    return []; // Return empty array jika tidak ada batch numbers

  } catch (error) {
    console.error(`Error fetching batch numbers from Service Layer for DO ${doNo}:`, error.message);
    
    // Jika error session expired, coba refresh session dan retry sekali
    if (error.message.includes('Session expired') || error.message.includes('session') || error.message.includes('401')) {
      try {
        console.log(`Attempting to refresh session for DO ${doNo}...`);
        sessionCookie = await exports.loginToB1ServiceLayer();
        return await getBatchNumbersFromServiceLayer(doNo, line, sessionCookie);
      } catch (retryError) {
        console.error(`Retry failed for DO ${doNo}:`, retryError.message);
      }
    }
    
    throw error;
  }
}

// async function getBatchNumbers(doNo, line, pool, sessionCookie) {
//   const batchNumbers = [];
  
//   try {
//     // Coba ambil batch numbers dari dokumen orders asli di SAP
//     const orderBatchQuery = `
//       SELECT T2.BatchNum, T2.Quantity
//       FROM [pksrv-sap].pandurasa_live.dbo.RDR1 T1
//       INNER JOIN [pksrv-sap].pandurasa_live.dbo.IBT1 T2 
//         ON T1.DocEntry = T2.BaseEntry 
//         AND T1.LineNum = T2.BaseLineNum 
//         AND T2.BaseType = 17
//       WHERE T1.DocEntry = (
//         SELECT DISTINCT DocEntry 
//         FROM [pksrv-sap].pandurasa_live.dbo.ORDR 
//         WHERE DocNum = @doNo
//       )
//       AND T1.ItemCode = @itemCode
//       AND T1.LineNum = @lineNum
//     `;

//     const batchResult = await pool.request()
//       .input('doNo', sql.Int, doNo)
//       .input('itemCode', sql.VarChar, line.ItemCode)
//       .input('lineNum', sql.Int, line.LineNum)
//       .query(orderBatchQuery);

//     // Jika batch number ditemukan di orders, gunakan itu
//     if (batchResult.recordset && batchResult.recordset.length > 0) {
//       for (const batch of batchResult.recordset) {
//         batchNumbers.push({
//           "BatchNumber": batch.BatchNum,
//           "Quantity": parseFloat(batch.Quantity),
//           "BaseLineNumber": line.LineNum
//         });
//       }
//       return batchNumbers;
//     }

//     // Jika tidak ada di orders, coba cari di OBTN
//     for (const batch of line.BatchNumbers) {
//       if (!batch.BatchNumber || batch.Quantity === undefined) {
//         continue;
//       }

//       try {
//         const obtnResult = await pool.request()
//           .input('doNo', sql.Int, doNo)
//           .input('sku', sql.VarChar, line.ItemCode)
//           .input('expiredDate', sql.VarChar, batch.BatchNumber) // Asumsi batchNumber mengandung expired date
//           .query(`SELECT TOP 1 oibt.batchnum 
//                   FROM [db_pandurasa].dbo.r_dn_coldspace t0
//                   INNER JOIN [PKSRV-SAP].[PANDURASA_LIVE].dbo.OIBT 
//                     ON OIBT.ItemCode COLLATE SQL_Latin1_General_CP1_CI_AS = t0.SKU COLLATE SQL_Latin1_General_CP1_CI_AS
//                     AND OIBT.Quantity > t0.QTY 
//                     AND OIBT.Batchnum COLLATE SQL_Latin1_General_CP1_CI_AS LIKE '%' + @expiredDate + '%' COLLATE SQL_Latin1_General_CP1_CI_AS
//                   WHERE t0.ORDER_TYPE != 'N-STO' 
//                     AND t0.ORDER_TYPE != 'PROD' 
//                     AND t0.ismatch = 1 
//                     AND (t0.jo_status IS NULL OR t0.iswa IS NULL) 
//                     AND t0.DO_NO = @doNo 
//                     AND t0.SKU = @sku`);

//         const batchnumber = obtnResult.recordset.length > 0 
//           ? obtnResult.recordset[0].batchnum 
//           : batch.BatchNumber;
        
//         batchNumbers.push({
//           "BatchNumber": batchnumber,
//           "Quantity": parseFloat(batch.Quantity),
//           "BaseLineNumber": line.LineNum
//         });
//       } catch (error) {
//         console.error(`Error fetching batch for ${line.ItemCode}:`, error);
//         batchNumbers.push({
//           "BatchNumber": batch.BatchNumber,
//           "Quantity": parseFloat(batch.Quantity),
//           "BaseLineNumber": line.LineNum
//         });
//       }
//     }

//     return batchNumbers;

//   } catch (error) {
//     console.error(`Error in getBatchNumbers for DO ${doNo}:`, error);
    
//     // Fallback: gunakan batch numbers dari line data
//     for (const batch of line.BatchNumbers) {
//       if (batch.BatchNumber && batch.Quantity !== undefined) {
//         batchNumbers.push({
//           "BatchNumber": batch.BatchNumber,
//           "Quantity": parseFloat(batch.Quantity),
//           "BaseLineNumber": line.LineNum
//         });
//       }
//     }
    
//     return batchNumbers;
//   }
// }

// async function getBatchNumbers(doNo, line, pool, sessionCookie) {
//   try {
//     // Prioritaskan ambil dari Service Layer
//     const serviceLayerBatches = await getBatchNumbersFromServiceLayer(doNo, line, sessionCookie);
    
//     if (serviceLayerBatches.length > 0) {
//       return serviceLayerBatches;
//     }
    
//     // Fallback: jika tidak ada di Service Layer, cari di database lokal
//     console.log(`No batch numbers from Service Layer, checking local database for DO ${doNo}, Item ${line.ItemCode}`);
    
//     const batchNumbers = [];
//     for (const batch of line.BatchNumbers) {
//       if (!batch.BatchNumber || batch.Quantity === undefined) {
//         continue;
//       }

//       try {
//         const obtnResult = await pool.request()
//           .input('doNo', sql.Int, doNo)
//           .input('sku', sql.VarChar, line.ItemCode)
//           .input('expiredDate', sql.VarChar, batch.BatchNumber)
//           .query(`SELECT TOP 1 oibt.batchnum 
//                   FROM [db_pandurasa].dbo.r_dn_coldspace t0
//                   INNER JOIN [PKSRV-SAP].[PANDURASA_LIVE].dbo.OIBT 
//                     ON OIBT.ItemCode COLLATE SQL_Latin1_General_CP1_CI_AS = t0.SKU COLLATE SQL_Latin1_General_CP1_CI_AS
//                     AND OIBT.Quantity > t0.QTY 
//                     AND OIBT.Batchnum COLLATE SQL_Latin1_General_CP1_CI_AS LIKE '%' + @expiredDate + '%' COLLATE SQL_Latin1_General_CP1_CI_AS
//                   WHERE t0.ORDER_TYPE != 'N-STO' 
//                     AND t0.ORDER_TYPE != 'PROD' 
//                     AND t0.ismatch = 1 
//                     AND (t0.jo_status IS NULL OR t0.iswa IS NULL) 
//                     AND t0.DO_NO = @doNo 
//                     AND t0.SKU = @sku`);

//         const batchnumber = obtnResult.recordset.length > 0 
//           ? obtnResult.recordset[0].batchnum 
//           : batch.BatchNumber;
        
//         batchNumbers.push({
//           "BatchNumber": batchnumber,
//           "Quantity": parseFloat(batch.Quantity),
//           "BaseLineNumber": line.LineNum
//         });
//       } catch (error) {
//         console.error(`Error fetching batch from local DB for ${line.ItemCode}:`, error);
//         batchNumbers.push({
//           "BatchNumber": batch.BatchNumber,
//           "Quantity": parseFloat(batch.Quantity),
//           "BaseLineNumber": line.LineNum
//         });
//       }
//     }

//     return batchNumbers;

//   } catch (error) {
//     console.error(`Error in getBatchNumbers for DO ${doNo}:`, error);
    
//     // Ultimate fallback: gunakan batch numbers dari line data
//     const fallbackBatches = [];
//     if (line.BatchNumbers && line.BatchNumbers.length > 0) {
//       for (const batch of line.BatchNumbers) {
//         if (batch.BatchNumber && batch.Quantity !== undefined) {
//           fallbackBatches.push({
//             "BatchNumber": batch.BatchNumber,
//             "Quantity": parseFloat(batch.Quantity),
//             "BaseLineNumber": line.LineNum
//           });
//         }
//       }
//     }
    
//     return fallbackBatches;
//   }
// }

async function getBatchNumbers(doNo, line, pool, sessionCookie) {
  try {
    // Prioritaskan ambil dari Service Layer
    // const serviceLayerBatches = await getBatchNumbersFromServiceLayer(doNo, line, sessionCookie);
    
    // if (serviceLayerBatches.length > 0) {
    //   return serviceLayerBatches;
    // }
    
    // Fallback: jika tidak ada di Service Layer, cari di database lokal
    console.log(`No batch numbers from Service Layer, checking local database for DO ${doNo}, Item ${line.ItemCode}`);
    
    const batchNumbers = [];
    for (const batch of line.BatchNumbers) {
      if (!batch.BatchNumber || batch.Quantity === undefined) {
        continue;
      }

      try {
        const obtnResult = await pool.request()
          .input('doNo', sql.Int, doNo)
          .input('sku', sql.VarChar, line.ItemCode)
          .input('expiredDate', sql.VarChar, batch.BatchNumber)
          .query(`SELECT TOP 1 oibt.batchnum 
                  FROM [db_pandurasa].dbo.r_dn_coldspace t0
                  INNER JOIN [PKSRV-SAP].[PANDURASA_LIVE].dbo.OIBT 
                    ON OIBT.ItemCode COLLATE SQL_Latin1_General_CP1_CI_AS = t0.SKU COLLATE SQL_Latin1_General_CP1_CI_AS
                    AND OIBT.Quantity > t0.QTY 
                    AND OIBT.Batchnum COLLATE SQL_Latin1_General_CP1_CI_AS LIKE '%' + @expiredDate + '%' COLLATE SQL_Latin1_General_CP1_CI_AS
                  WHERE t0.ORDER_TYPE != 'N-STO' 
                    AND t0.ORDER_TYPE != 'PROD' 
                    AND t0.ismatch = 1 
                    AND (t0.jo_status IS NULL OR t0.iswa IS NULL) 
                    AND t0.DO_NO = @doNo 
                    AND t0.SKU = @sku`);

        const batchnumber = obtnResult.recordset.length > 0 
          ? obtnResult.recordset[0].batchnum 
          : batch.BatchNumber;
        
        batchNumbers.push({
          "BatchNumber": batchnumber,
          "Quantity": parseFloat(batch.Quantity),
          "BaseLineNumber": line.LineNum
        });
      } catch (error) {
        console.error(`Error fetching batch from local DB for ${line.ItemCode}:`, error);
        batchNumbers.push({
          "BatchNumber": batch.BatchNumber,
          "Quantity": parseFloat(batch.Quantity),
          "BaseLineNumber": line.LineNum
        });
      }
    }

    return batchNumbers;

  } catch (error) {
    console.error(`Error in getBatchNumbers for DO ${doNo}:`, error);
    
    // Ultimate fallback: gunakan batch numbers dari line data
    const fallbackBatches = [];
    if (line.BatchNumbers && line.BatchNumbers.length > 0) {
      for (const batch of line.BatchNumbers) {
        if (batch.BatchNumber && batch.Quantity !== undefined) {
          fallbackBatches.push({
            "BatchNumber": batch.BatchNumber,
            "Quantity": parseFloat(batch.Quantity),
            "BaseLineNumber": line.LineNum
          });
        }
      }
    }
    
    return fallbackBatches;
  }
}

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
    
    // Jika sudah sukses, skip proses
    if (existingData.jo_status === 3 && existingData.note?.includes('Successfully posted to SAP')) {
      console.log(`Process : ${doNo} | Already processed successfully, skipping...`);
      return {
        status: 'success',
        docEntry: existingData.doc_entry,
        docNum: existingData.doc_num,
        message: 'Already processed successfully'
      };
    }
    
    // Jika sudah closed di note tapi status belum 3, update saja
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

  try {
    await delay(300); // Jeda 1 menit sebelum memproses dokumen

    sessionCookie = await exports.loginToB1ServiceLayer();
    const docEntryRequest = pool.request();
    const docEntryResult = await docEntryRequest
      .input('doNo', sql.Int, doNo)
      .query('SELECT DISTINCT DocEntry FROM [pksrv-sap].pandurasa_live.dbo.ORDR WITH (NOLOCK) WHERE DocNum = @doNo');

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
      FROM [pksrv-sap].pandurasa_live.dbo.ORDR T0
      JOIN [pksrv-sap].pandurasa_live.dbo.RDR1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN [pksrv-sap].pandurasa_live.dbo.IBT1 T2 ON T1.DocEntry = T2.BaseEntry AND T1.LineNum = T2.BaseLinNum AND T2.BaseType = 17
      LEFT JOIN [pksrv-sap].pandurasa_live.dbo.OBTN T3 ON T2.ItemCode = T3.ItemCode AND T2.BatchNum = T3.DistNumber
      LEFT JOIN [pksrv-sap].pandurasa_live.dbo.NNM1 T4 ON T4.Series = T0.Series AND T4.Indicator = YEAR(GETDATE()) AND T4.ObjectCode = '17'
      LEFT JOIN [pksrv-sap].pandurasa_live.dbo.CRD1 CRD1_S ON T0.CardCode = CRD1_S.CardCode AND T0.ShipToCode = CRD1_S.Address AND CRD1_S.AdresType = 'S'
      LEFT JOIN [pksrv-sap].pandurasa_live.dbo.CRD1 CRD1_B ON T0.CardCode = CRD1_B.CardCode AND T0.PayToCode = CRD1_B.Address AND CRD1_B.AdresType = 'B'
      CROSS APPLY (
          SELECT TOP 1 series AS sercode
          FROM [pksrv-sap].pandurasa_live.dbo.NNM1 AS T5
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
    const result = await request.input('doNo', sql.Int, doNo).query(orderQuery);
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
      // console.error("Error retrieving AddressExtension data:", err.message);
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
      "Series": firstRecord.Series,
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

    console.log(JSON.stringify(deliveryNotePayload, null, 2));

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

    await delay(300); // Jeda 30 detik sebelum notifikasi
    const notificationResult = await notificationService.sendWhatsApp(
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

exports.checkDeliveryNoPANDURASA_LIVEatus = async (docEntry) => {
  try {
    await delay(300); // Jeda 1 menit sebelum pengecekan status
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

    await delay(300); // Jeda 1 menit sebelum request ke SAP
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

// sapservice.js - tambahkan di bagian akhir
exports.SAP_CONFIG = SAP_CONFIG;