const app = require('./app');
const axios = require('axios');
const sql = require('mssql');
const notificationService = require('./services/notificationService');
// Helper delay
const sleep = (ms = 1000) => new Promise(resolve => setTimeout(resolve, ms));

const SAP_CONFIG = {
    BASE_URL: 'https://192.168.101.254:50000/b1s/v2',
    COMPANY_DB: 'PANDURASA_LIVE',
    CREDENTIALS: {
        username: 'manager',
        password: 'Password#1'
    }
};

const DB_CONFIG = {
    user: 'PK-SERVE',
    password: 'n0v@0707#',
    server: '192.168.100.202',
    database: 'db_pandurasa',
    options: {
        encrypt: false,
        trustServerCertificate: true,
        connectTimeout: 30000,
        requestTimeout: 30000
    },
    pool: {
        max: 10,
        min: 0,
        idleTimeoutMillis: 30000
    }
};

exports.getDfltwhForSKU = async (sku) => {
    if (sku === 'G502') return 'BS03';
    if (sku === 'K102') return 'BS04';
    if (sku === 'F001') return 'BS02';
    return null;
};

async function getDfltwhForSKU(sku) {
    if (sku === 'G502') return 'BS03';
    if (sku === 'K102') return 'BS04';
    if (sku === 'F001') return 'BS02';
    return null;
}

function convertDate(daPANDURASA_LIVEring) {
    if (typeof daPANDURASA_LIVEring !== 'string' || daPANDURASA_LIVEring.length !== 6) {
        return 'Invalid date format. Please use "yymmdd".';
    }
    const year = "20" + daPANDURASA_LIVEring.substring(0, 2);
    const month = daPANDURASA_LIVEring.substring(2, 4);
    const day = daPANDURASA_LIVEring.substring(4, 6);
    return `${day}-${month}-${year}`;
}

const processStockTransferOrders = async () => {
    let pool;
    try {
        pool = await sql.connect(DB_CONFIG);
        console.log('------------------------------------------------------------------------------------');
        console.log('Memulai proses Stock Transfer Order (STO)...');

        const result = await pool.request().query(`
            SELECT 
                t0x.*,
                t2.*,
                CASE 
                    WHEN t0x.SKU_qUALITY = 'n' THEN t2.dfltwh 
                    ELSE t0x.vendor collate database_default
                END AS vendor,
                
                CASE 
                    WHEN t0x.SKU_qUALITY = 'n' THEN t2.dfltwh 
                    ELSE t0x.vendor collate database_default
                END AS sub_vendor 
            FROM 
                r_grpo_coldspace t0x
            INNER JOIN 
                [pksrv-sap].pandurasa_live.dbo.oitm t2 ON t0x.sku collate database_default = t2.itemcode collate database_default 
            WHERE 
                (t0x.iswa IS NULL OR t0x.jo_status IS NULL) 
                AND t0x.TRK_TYPE = 'N-STO'
        `);

        if (result.recordset.length === 0) {
            console.log('Tidak ada data STO yang perlu diproses.');
            return;
        }

        const sessionCookie = await loginToSAP();
        if (!sessionCookie) {
            console.error('Gagal login ke SAP.');
            await pool.close();
            return;
        }

        for (const record of result.recordset) {
            try {
                // Tambahkan jeda antar record
                await sleep(100);

                if (record.QTYPO <= 0) {
                    const note = 'Kuantitas nol atau tidak valid';
                    await updateRecordStatus(record.id, 0, note, null, null, pool);
                    // await notificationService.sendNotification(record.PO_NO, null, null, `Gagal: ${note}`, false, pool);
                    continue;
                }

                const docEntry = await getDocEntryFromOWTQ(record.PO_NO, pool);
                console.log('------------------------------------------------------------------------------------');
                console.log(`Processing STO for DocNum: ${record.PO_NO} | Doc Entry: ${docEntry}`);
                
                if (!docEntry) {
                    const note = 'DocEntry STO tidak ditemukan di OWTQ';
                    await updateRecordStatus(record.id, 0, note, null, null, pool);
                    // await notificationService.sendNotification(record.PO_NO, null, null, `Gagal: ${note}`, false, pool);
                    continue;
                }

                const inventoryTransferRequest = await getInventoryTransferRequestFromSAP(docEntry, sessionCookie);

                // --- START: TAMBAHAN ALUR VALIDASI STATUS DOKUMEN ---
                if (inventoryTransferRequest.DocumentStatus === 'bost_Close') {
                    console.log(`Dokumen Inventory Transfer Request ${docEntry} sudah tertutup.`);
                    const stockTransferDoc = await getStockTransferFromSQL(docEntry, pool);
                    if (stockTransferDoc) {
                        const note = 'Successfully posted to SAP';
                        console.log(`Dokumen Stock Transfer sudah ada. DocNum: ${stockTransferDoc.DocNum} | DocEntry: ${stockTransferDoc.DocEntry}`);
                        await updateRecordStatus(record.id, 3, note, stockTransferDoc.DocNum, stockTransferDoc.DocEntry, pool, record.PO_NO);
                        await notificationService.sendNotification(record.PO_NO, stockTransferDoc.DocNum, stockTransferDoc.DocEntry, note, true, pool);
                    } else {
                        const note = 'Dokumen ditutup dan tidak ditemukan Stock Transfer yang cocok.';
                        await updateRecordStatus(record.id, 4, note, null, null, pool, record.PO_NO);
                        await notificationService.sendNotification(record.PO_NO, null, null, `Gagal: ${note}`, false, pool);
                    }
                    continue; // Lanjut ke record berikutnya
                }
                // --- END: TAMBAHAN ALUR VALIDASI STATUS DOKUMEN ---

                // const inventoryTransferRequest = await getInventoryTransferRequestFromSAP(docEntry, sessionCookie);
                const batchDataFromOBTN = await getBatchDataFromOBTN(record.SKU, inventoryTransferRequest.FromWarehouse, record.VFDAT, pool);

                if (!batchDataFromOBTN) {
                    const note = 'Batch data tidak ditemukan untuk SKU';
                    console.log('------------------------------------------------------------------------------------');
                    console.log(`SKU: ${record.SKU} | WHS: ${inventoryTransferRequest.FromWarehouse} | Error: ${note}`);
                    await updateRecordStatus(record.id, 0, note, null, null, pool);
                    // await notificationService.sendNotification(record.PO_NO, null, null, `Gagal: ${note}`, false, pool);
                    continue;
                }

                const validationResult = { isValid: true, batchData: batchDataFromOBTN };
                const stockTransferPayload = createstockTransferPayload(record, inventoryTransferRequest, validationResult.batchData);
                console.log(JSON.stringify(stockTransferPayload,null,2));
                const postResult = await postStockTransferToSAP(stockTransferPayload, sessionCookie);

                if (postResult?.error) {
                    const status = postResult.message.includes('closed') ? 3 : 0;
                    const note = status === 3 ? `Berhasil diproses Tukar Guling` : `Gagal: ${postResult.message}`;
                    await updateRecordStatus(record.id, status, note, null, null, pool);
                    await notificationService.sendNotification(record.PO_NO, null, null, note, status === 3, pool);
                    continue;
                }

                const { DocEntry, DocNum } = postResult;
                const successNote = 'Berhasil memproses STO';
                console.log('------------------------------------------------------------------------------------');
                console.log(`Stock Transfer berhasil dibuat! DocEntry: ${DocEntry} | DocNum: ${DocNum}`);
                await updateRecordStatus(record.id, 3, successNote, DocNum, DocEntry, pool);
                await notificationService.sendNotification(record.PO_NO, DocNum, DocEntry, successNote, true, pool);

            } catch (error) {
                const note = error.message.includes('already exists') || error.message.includes('already closed')
                    ? 'Dokumen sudah ada/closed di SAP'
                    : error.message;
                const status = note.includes('already closed') ? 4 : 0;
                console.error(`Error processing record ${record.PO_NO}:`, error);
                await updateRecordStatus(record.id, status, note, null, null, pool);
                await notificationService.sendNotification(record.PO_NO, null, null, `Gagal: ${note}`, false, pool);
            }
        }
    } catch (error) {
        console.error('Error dalam proses utama:', error);
    } finally {
        if (pool) await pool.close();
    }
};

// ====================== SAP Helper ======================
const loginToSAP = async () => {
    try {
        const response = await axios.post(
            `${SAP_CONFIG.BASE_URL}/Login`,
            {
                CompanyDB: SAP_CONFIG.COMPANY_DB,
                UserName: SAP_CONFIG.CREDENTIALS.username,
                Password: SAP_CONFIG.CREDENTIALS.password
            },
            {
                httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
            }
        );
        return response.headers['set-cookie'].join('; ');
    } catch (error) {
        throw new Error(`Gagal login ke SAP: ${error.response?.data?.error?.message?.value || error.message}`);
    }
};

const getDocEntryFromOWTQ = async (poNo, pool) => {
    try {
        const result = await pool.request()
            .input('poNo', sql.Int, poNo)
            .query('SELECT TOP 1 DocEntry FROM [pksrv-sap].pandurasa_live.dbo.OWTQ WHERE DocNum = @poNo');
        return result.recordset[0]?.DocEntry || null;
    } catch (error) {
        console.log('------------------------------------------------------------------------------------');
        console.log(`Process: ${poNo} | Error-1: ${error.message}`);
        return null;
    }
};

const getInventoryTransferRequestFromSAP = async (docEntry, sessionCookie) => {
    try {
        const response = await axios.get(
            `${SAP_CONFIG.BASE_URL}/InventoryTransferRequests(${docEntry})`, {
                headers: { 'Cookie': sessionCookie },
                httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
            }
        );
        return response.data;
    } catch (error) {
        throw new Error(`Gagal mendapatkan InventoryTransferRequests dari SAP: ${error.response?.data?.error?.message?.value || error.message}`);
    }
};

const getBatchDataFromOBTN = async (itemCode, whsCode, ExpDate, pool) => {
    try {
        const query = `
            SELECT TOP 1
                isnull(T1.BatchNum,'${ExpDate}') AS BatchNumber,
                T1.Quantity AS AvailableQuantity,
                isnull(T1.ExpDate,'${ExpDate}') AS ExpirationDate
            FROM [pksrv-sap].pandurasa_live.dbo.OIBT T1
            inner join [pksrv-sap].pandurasa_live.dbo.oitm t2 on t1.itemcode = t2.itemcode
            WHERE T1.ItemCode = '${itemCode}' AND 
            (T1.WhsCode = '${whsCode}' or t1.whscode = t2.dfltwh) AND T1.Quantity > 0
            AND t1.batchnum like '${ExpDate}%'
            ORDER BY T1.ExpDate ASC
        `;
        const result = await pool.request()
            .input('itemCode', sql.VarChar, itemCode)
            .input('whsCode', sql.VarChar, whsCode)
            .query(query);

        if (result.recordset.length === 0) return null;
        const batch = result.recordset[0];
        return {
            BatchNumber: batch.BatchNumber,
            Quantity: batch.AvailableQuantity,
            ExpiryDate: batch.ExpirationDate
        };
    } catch (error) {
        throw new Error(`Gagal mendapatkan batch data dari OBTN: ${error.message}`);
    }
};

const createstockTransferPayload = (record, invTransferRequest, batchData) => {
    const lineItem = invTransferRequest.StockTransferLines.find(line =>
        line.ItemCode.toLowerCase() === record.SKU.toLowerCase() && line.LineNum.toString() === record.LINE_NO.toString()
    );
    
    if (!lineItem) {
        console.error(`Error: No matching line item found for SKU: ${record.SKU} and LINE_NO: ${record.LINE_NO}`);
        throw new Error('Matching delivery note line item not found.');
    }

    return {
        DocDate: invTransferRequest.DocDate,
        DueDate: invTransferRequest.DueDate,
        Comments: `KIRIM Based On Inventory Transfer Request CS : ${invTransferRequest.DocNum}.`,
        FromWarehouse: invTransferRequest.FromWarehouse,
        ToWarehouse: invTransferRequest.ToWarehouse,
        DocObjectCode: "67",
        U_IDU_RequestType: "GENERAL",
        StockTransferLines: [{
            ItemCode: lineItem.ItemCode,
            Quantity: lineItem.Quantity,
            WarehouseCode: lineItem.WarehouseCode,
            FromWarehouseCode: lineItem.FromWarehouseCode,
            BaseType: "Default",
            BaseLine: lineItem.LineNum,
            BaseEntry: invTransferRequest.DocEntry,
            BatchNumbers: [{
                BatchNumber: batchData.BatchNumber,
                Quantity: record.QTYPO
            }]
        }]
    };
};

const postStockTransferToSAP = async (payload, sessionCookie) => {
    try {
        const response = await axios.post(
            `${SAP_CONFIG.BASE_URL}/StockTransfers`,
            payload, {
                headers: { 'Cookie': sessionCookie },
                httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
            }
        );
        return response.data;
    } catch (error) {
        const errorMessage = error.response?.data?.error?.message?.value ||
            error.response?.statusText ||
            error.message ||
            'Terjadi kesalahan tidak dikenal.';
        console.log('------------------------------------------------------------------------------------');
        console.log('Error saat posting ke StockTransfers:', errorMessage);
        return { error: true, message: errorMessage };
    }
};

const updateRecordStatus = async (id, joStatus, note, docNum, docEntry, pool, pono = null) => {
    try {
        await pool.request()
            .input('id', sql.Int, id)
            .input('PO_NO', sql.Int, pono)
            .input('joStatus', sql.Int, joStatus)
            .input('note', sql.NVarChar, note)
            .input('docNum', sql.Int, docNum)
            .input('docEntry', sql.Int, docEntry)
            .query(`
                UPDATE r_grpo_coldspace
                SET jo_status = @joStatus,
                    note = @note,
                    doc_num = @docNum,
                    doc_entry = @docEntry,
                    iswa = CASE WHEN @joStatus = 3 THEN 1 ELSE 0 END
                WHERE id = @id OR (@PO_NO IS NOT NULL AND PO_NO = @PO_NO);
            `);

        await pool.request()
            .input('DO_NO', sql.Int, pono)
            .input('joStatus', sql.Int, joStatus)
            .input('note', sql.NVarChar, note)
            .input('docNum', sql.Int, docNum)
            .input('docEntry', sql.Int, docEntry)
            .query(`
                UPDATE r_dn_coldspace
                SET jo_status = @joStatus,
                    note = @note,
                    doc_num = @docNum,
                    doc_entry = @docEntry,
                    iswa = CASE WHEN @joStatus = 3 THEN 1 ELSE 0 END
                WHERE DO_NO = @DO_NO;
            `);
    } catch (error) {
        throw new Error(`Gagal update status record: ${error.message}`);
    }
};

// ====================== INIT ======================
const initialize = async () => {
    try {
        processStockTransferOrders().catch(error => {
            console.log('------------------------------------------------------------------------------------');
            console.log(`Error: ${error}`);
            console.log('------------------------------------------------------------------------------------');
        });
        console.log('------------------------------------------------------------------------------------');
        setInterval(() => processStockTransferOrders(), 20000);
        app.listen(31241, () => {
            console.log('Server ready on port 31241');
        });
    } catch (error) {
        console.error('Startup failed:', error);
        process.exit(1);
    }
};

initialize();
