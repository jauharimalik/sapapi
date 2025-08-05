const app = require('./app');
const axios = require('axios');
const sql = require('mssql');
const FormData = require('form-data');

const SAP_CONFIG = {
    BASE_URL: 'https://192.168.101.254:50000/b1s/v2',
    COMPANY_DB: 'TEST',
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

const WHATSAPP_CONFIG = {
    apiUrl: 'http://103.169.73.3:4040/send-group-message',
    successGroup: '120363420162985105@g.us',
    failureGroup: '120363421138507049@g.us'
};

const processStockTransferOrders = async () => {
    let pool;
    try {
        pool = await sql.connect(DB_CONFIG);
        console.log('------------------------------------------------------------------------------------');
        console.log('Memulai proses Stock Transfer Order (STO)...');
        const result = await pool.request()
            .query(`SELECT * FROM r_grpo_coldspace WHERE (iswa is null or jo_status is null) and TRK_TYPE = 'N-STO'`);
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
                if (record.QTYPO <= 0) {
                    const note = 'Kuantitas nol atau tidak valid';
                    await updateRecordStatus(record.id, 0, note, null, null, pool);
                    await sendWhatsAppNotification(record.PO_NO, null, null, `Gagal: ${note}`, false, pool);
                    continue;
                }
                const docEntry = await getDocEntryFromOWTQ(record.PO_NO, pool);
                console.log('------------------------------------------------------------------------------------');
                console.log(`Processing STO for DocNum: ${record.PO_NO} | Doc Entry: ${docEntry}`);
                if (!docEntry) {
                    const note = 'DocEntry STO tidak ditemukan di OWTQ';
                    await updateRecordStatus(record.id, 0, note, null, null, pool);
                    await sendWhatsAppNotification(record.PO_NO, null, null, `Gagal: ${note}`, false, pool);
                    continue;
                }
                const inventoryTransferRequest = await getInventoryTransferRequestFromSAP(docEntry, sessionCookie);
                let validationResult = validateVfdatWithExpDate(record, inventoryTransferRequest);
                if (!validationResult.isValid || !validationResult.batchData) {
                    const batchDataFromOBTN = await getBatchDataFromOBTN(record.SKU, inventoryTransferRequest.FromWarehouse, pool);
                    if (!batchDataFromOBTN) {
                        const note = 'Batch data tidak ditemukan untuk SKU';
                        console.log('------------------------------------------------------------------------------------');
                        console.log(`SKU: ${record.SKU} | WHS: ${inventoryTransferRequest.FromWarehouse} | Error: ${note}`);
                        await updateRecordStatus(record.id, 0, note, null, null, pool);
                        await sendWhatsAppNotification(record.PO_NO, null, null, `Gagal: ${note}`, false, pool);
                        continue;
                    }
                    validationResult = { isValid: true, batchData: batchDataFromOBTN };
                }
                const stockTransferPayload = createStockTransferPayload(record, inventoryTransferRequest, validationResult.batchData);
                const postResult = await postStockTransferToSAP(stockTransferPayload, sessionCookie);
                if (postResult?.error) {
                    const status = postResult.message.includes('closed') ? 4 : 0;
                    const note = status === 4 ? `Gagal: ${postResult.message}` : `Gagal: ${postResult.message}`;
                    await updateRecordStatus(record.id, status, postResult.message, null, null, pool);
                    await sendWhatsAppNotification(record.PO_NO, null, null, note, false, pool);
                    continue;
                }
                const { DocEntry, DocNum } = postResult;
                const successNote = 'Berhasil memproses STO';
                console.log('------------------------------------------------------------------------------------');
                console.log(`Stock Transfer berhasil dibuat! DocEntry: ${DocEntry} | DocNum: ${DocNum}`);
                await updateRecordStatus(record.id, 3, successNote, DocNum, DocEntry, pool);
                await sendWhatsAppNotification(record.PO_NO, DocNum, DocEntry, successNote, true, pool);
            } catch (error) {
                const note = error.message.includes('already exists') || error.message.includes('already closed')
                    ? 'Dokumen sudah ada/closed di SAP'
                    : error.message;
                const status = note.includes('already closed') ? 4 : 0;
                console.error(`Error processing record ${record.PO_NO}:`, error);
                await updateRecordStatus(record.id, status, note, null, null, pool);
                await sendWhatsAppNotification(record.PO_NO, null, null, `Gagal: ${note}`, false, pool);
            }
        }
    } catch (error) {
        console.error('Error dalam proses utama:', error);
    } finally {
        if (pool) await pool.close();
    }
};

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
            .query('SELECT TOP 1 DocEntry FROM [pksrv-sap].test.dbo.OWTQ WHERE DocNum = @poNo');
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

const validateVfdatWithExpDate = (record, inventoryTransferRequest) => {
    const lineItem = inventoryTransferRequest.StockTransferLines.find(line =>
        line.ItemCode === record.SKU && line.LineNum.toString() === record.LINE_NO.toString()
    );
    if (!lineItem?.BatchNumbers || lineItem.BatchNumbers.length === 0) {
        return { isValid: false, batchData: null };
    }
    const vfdat = new Date(record.VFDAT).toISOString().split('T')[0];
    const matchingBatch = lineItem.BatchNumbers.find(batch => {
        const expDate = batch.ExpiryDate?.split('T')[0];
        return expDate === vfdat;
    });
    return matchingBatch ? {
        isValid: true,
        batchData: {
            BatchNumber: matchingBatch.BatchNumber,
            ManufacturerSerialNumber: matchingBatch.ManufacturerSerialNumber,
            InternalSerialNumber: matchingBatch.InternalSerialNumber,
            ExpiryDate: matchingBatch.ExpiryDate,
            AddmisionDate: matchingBatch.AddmisionDate,
            Quantity: record.QTYPO
        }
    } : { isValid: false, batchData: null };
};

const getBatchDataFromOBTN = async (itemCode, whsCode, pool) => {
    try {
        const query = `
            SELECT TOP 1
                T1.BatchNum AS BatchNumber,
                T1.Quantity AS AvailableQuantity,
                T0.ExpDate AS ExpirationDate
            FROM [pksrv-sap].test.dbo.OBTN T0
            INNER JOIN [pksrv-sap].test.dbo.OIBT T1 ON T0.AbsEntry = T1.BaseEntry
            WHERE T1.ItemCode = @itemCode AND T1.WhsCode = @whsCode AND T1.Quantity > 0
            ORDER BY T0.ExpDate ASC`;
        const result = await pool.request()
            .input('itemCode', sql.VarChar, itemCode)
            .input('whsCode', sql.VarChar, whsCode)
            .query(query);
        if (result.recordset.length === 0) return null;
        const batch = result.recordset[0];
        return {
            BatchNumber: batch.BatchNumber,
            ManufacturerSerialNumber: batch.ManufacturerSerialNumber,
            InternalSerialNumber: batch.InternalSerialNumber,
            ExpiryDate: batch.ExpiryDate?.toISOString().split('T')[0],
            AddmisionDate: batch.AddmisionDate?.toISOString().split('T')[0],
            Quantity: batch.AvailableQuantity
        };
    } catch (error) {
        throw new Error(`Gagal mendapatkan batch data dari OBTN: ${error.message}`);
    }
};
const createStockTransferPayload = (record, invTransferRequest, batchData) => {
    const lineItem = invTransferRequest.StockTransferLines.find(line =>
        line.ItemCode.toLowerCase() === record.SKU.toLowerCase() && line.LineNum.toString() === record.LINE_NO.toString()
    );

    // if (!lineItem) {
    //     throw new Error(`Item ${record.SKU} tidak ditemukan pada line ${record.LINE_NO} di Inventory Transfer Request.`);
    // }

    const batchNumbers = [{
        BatchNumber: batchData.BatchNumber,
        ManufacturerSerialNumber: batchData.ManufacturerSerialNumber,
        InternalSerialNumber: batchData.InternalSerialNumber,
        ExpiryDate: batchData.ExpiryDate,
        AddmisionDate: batchData.AddmisionDate,
        Quantity: record.QTYPO,
        BaseLineNumber: 0
    }];

    return {
        DocDate: invTransferRequest.DocDate,
        DueDate: invTransferRequest.DueDate,
        Comments: `KIRIM Based On Inventory Transfer Request ${invTransferRequest.DocNum}.`,
        FromWarehouse: invTransferRequest.FromWarehouse,
        ToWarehouse: invTransferRequest.ToWarehouse,
        DocObjectCode: "67",
        U_IDU_RequestType: "IT",
        StockTransferLines: [{
            ItemCode: lineItem.ItemCode,
            Quantity: lineItem.Quantity,
            WarehouseCode: lineItem.WarehouseCode,
            FromWarehouseCode: lineItem.FromWarehouseCode,
            BaseType: "1250000001",
            BaseLine: lineItem.LineNum,
            BaseEntry: invTransferRequest.DocEntry,
            BatchNumbers: batchNumbers,
            StockTransferLinesBinAllocations: []
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
    } catch (error) {
        throw new Error(`Gagal update status record: ${error.message}`);
    }
};

const sendWhatsAppNotification = async (poNo, existingDocNum, existingDocEntry, note, isSuccess, pool) => {
    let finalDocNum = existingDocNum;
    let finalDocEntry = existingDocEntry;
    const finalNote = note;
    if (isSuccess && (!finalDocNum || !finalDocEntry) && poNo) {
        try {
            const docEntryFromOwtq = await getDocEntryFromOWTQ(poNo, pool);
            if (docEntryFromOwtq) {
            }
        } catch (queryError) {
            console.error(`Gagal mencari DocNum/DocEntry di dalam sendWhatsAppNotification: ${queryError.message}`);
        }
    }
    const groupId = isSuccess ? WHATSAPP_CONFIG.successGroup : WHATSAPP_CONFIG.failureGroup;
    const statusText = isSuccess ? 'SUCCESS' : 'FAILED';
    const message = formatWhatsAppMessage(poNo, finalDocNum, finalDocEntry, finalNote, isSuccess, statusText);
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
        // console.log('------------------------------------------------------------------------------------');
        // console.log('Notifikasi WhatsApp terkirim:', {
        //     poNo,
        //     docNum: finalDocNum,
        //     status: statusText,
        //     messageId: response.data?.id || null
        // });
        return { success: true, messageId: response.data?.id || null };
    } catch (error) {
        console.log('------------------------------------------------------------------------------------');
        console.log('Gagal mengirim notifikasi WhatsApp:');
        console.error(error.message);
        if (isSuccess) await resetNotificationStatus(poNo, pool);
        return { success: false, error: error.message };
    }
};

const formatWhatsAppMessage = (poNo, docNum, docEntry, note, isSuccess, statusText) => {
    const header = `*STO Processing - ${statusText}*`;
    let docInfo = `*DocNum (OWTQ):* ${poNo}`;
    if (docNum) docInfo += `\n*DocNum (OWTR):* ${docNum}`;
    if (docEntry) docInfo += `\n*DocEntry (OWTR):* ${docEntry}`;
    return isSuccess
        ? `${header}\n\n${docInfo}`
        : `${header}\n\n${docInfo}\n\n*Details:*\n${note}`;
};

const resetNotificationStatus = async (poNo, pool) => {
    try {
        await pool.request()
            .input('poNo', sql.VarChar, poNo)
            .query('UPDATE r_grpo_coldspace SET iswa = NULL WHERE PO_NO = @poNo');
    } catch (error) {
        console.error('Gagal reset status notifikasi:', error.message);
    }
};

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