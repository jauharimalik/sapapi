const app = require('./app');
const axios = require('axios');
const sql = require('mssql');
const notificationService = require('./services/notificationService');
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

function convertDate(dateString) {
    if (typeof dateString !== 'string' || dateString.length !== 6) {
        return 'Invalid date format. Please use "yymmdd".';
    }
    const year = "20" + dateString.substring(0, 2);
    const month = dateString.substring(2, 4);
    const day = dateString.substring(4, 6);
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
                t0x.id,
                t0x.site AS vendor,
                t0x.do_no as PO_NO
            FROM 
                r_dn_coldspace t0x
            INNER JOIN 
                [pksrv-sap].pandurasa_live.dbo.oitm t2 ON t0x.sku collate database_default = t2.itemcode collate database_default 
            WHERE 
                (t0x.iswa IS NULL OR t0x.jo_status IS NULL) 
                AND t0x.order_type = 'N-STO' and (site like '%wh06.%' or site like '%p012%'  or site like '%p013%' or site like '%p014%')
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
                await sleep(100);

                if (record.QTYPO <= 0) {
                    const note = 'Kuantitas nol atau tidak valid';
                    await updateRecordStatus(record.id, 0, note, null, null, pool, record.PO_NO);
                    continue;
                }

                const docEntry = await getDocEntryFromOWTQ(record.PO_NO, pool);
                console.log('------------------------------------------------------------------------------------');
                console.log(`Processing STO for DocNum: ${record.PO_NO} | Doc Entry: ${docEntry}`);
                
                if (!docEntry) {
                    const note = 'DocEntry STO tidak ditemukan di OWTQ';
                    await updateRecordStatus(record.id, 0, note, null, null, pool, record.PO_NO);
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

                const batchDataFromOBTN = await getBatchDataFromOBTN(record);
                console.log(batchDataFromOBTN);
                
                if (!batchDataFromOBTN) {
                    const note = 'Batch data tidak ditemukan untuk SKU';
                    console.log('------------------------------------------------------------------------------------');
                    console.log(`SKU: ${record.SKU} | WHS: ${inventoryTransferRequest.FromWarehouse} | Error: ${note}`);
                    await updateRecordStatus(record.id, 0, note, null, null, pool, record.PO_NO);
                    continue;
                }

                const stockTransferPayload = createstockTransferPayload(record, inventoryTransferRequest, batchDataFromOBTN);
                const postResult = await postStockTransferToSAP(stockTransferPayload, sessionCookie);

                console.log(JSON.stringify(stockTransferPayload,null,2));

                if (postResult?.error) {
                    const status = postResult.message.includes('closed') ? 3 : 0;
                    const note = status === 3 ? `Berhasil diproses Tukar Guling` : `Gagal: ${postResult.message}`;
                    await updateRecordStatus(record.id, status, note, null, null, pool, record.PO_NO);
                    await notificationService.sendNotification(record.PO_NO, null, null, note, status === 3, pool);
                    continue;
                }

                const { DocEntry, DocNum } = postResult;
                const successNote = 'Berhasil memproses STO';
                console.log('------------------------------------------------------------------------------------');
                console.log(`Stock Transfer berhasil dibuat! DocEntry: ${DocEntry} | DocNum: ${DocNum}`);
                await updateRecordStatus(record.id, 3, successNote, DocNum, DocEntry, pool, record.PO_NO);
                await notificationService.sendNotification(record.PO_NO, DocNum, DocEntry, successNote, true, pool);

            } catch (error) {
                const note = error.message.includes('already exists') || error.message.includes('already closed')
                    ? 'Dokumen sudah ada/closed di SAP'
                    : error.message;
                const status = note.includes('already closed') ? 4 : 0;
                console.error(`Error processing record ${record.PO_NO}:`, error);
                await updateRecordStatus(record.id, status, note, null, null, pool, record.PO_NO);
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

const getBatchDataFromOBTN = async (record) => {
    return {
        BatchNumber: record.batchnum,
        Quantity: record.QTY,
        ExpiryDate: record.expired_date
    };
};

const createstockTransferPayload = (record, invTransferRequest, batchData) => {
    const lineItem = invTransferRequest.StockTransferLines.find(line => {
        const lineNumFromSAP = line.LineNum?.toString();
        const lineNumFromDB = record.LineNum?.toString();

        return line.ItemCode.toLowerCase() === record.SKU.toLowerCase() &&
               lineNumFromSAP === lineNumFromDB;
    });

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
                Quantity: record.QTY
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

const getStockTransferFromSQL = async (baseEntry, pool) => {
    try {
        const result = await pool.request()
            .input('baseEntry', sql.Int, baseEntry)
            .query(`
                SELECT TOP 1 T0.DocEntry, T0.DocNum
                FROM [pksrv-sap].pandurasa_live.dbo.OWTR T0
                INNER JOIN [pksrv-sap].pandurasa_live.dbo.WTR1 T1 ON T0.DocEntry = T1.DocEntry
                WHERE T1.BaseEntry = @baseEntry
            `);
        return result.recordset[0] || null;
    } catch (error) {
        console.log(`Error mencari Stock Transfer di SQL: ${error.message}`);
        return null;
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
        setInterval(() => processStockTransferOrders(), 10000);
        app.listen(31615, () => {
            console.log('Server ready on port 31615');
        });
    } catch (error) {
        console.error('Startup failed:', error);
        process.exit(1);
    }
};

initialize();