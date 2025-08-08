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



async function getDfltwhForSKU(sku) {
    if (sku === 'G502') return 'BS03';
    if (sku === 'K102') return 'BS04';
    if (sku === 'F001') return 'BS02';
    return null;
}

const processTradeinTradeout = async () => {
    let pool;
    try {
        pool = await sql.connect(DB_CONFIG);

        const result = await pool.request()
            .query(`SELECT * FROM r_grpo_coldspace WHERE (jo_status is null or iswa is null) and TRK_TYPE = 'rplc'`);

        if (result.recordset.length === 0) {
            console.log('------------------------------------------------------------------------------------');
            return;
        }

        const sessionCookie = await loginToSAP();
        if (!sessionCookie) {
            console.error('Gagal login ke SAP.');
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

                const docEntry = await getDocEntryFromOIGE(record.PO_NO, pool);
                console.log('------------------------------------------------------------------------------------');
                console.log(`Process: ${record.PO_NO} | Doc Entry OIGE: ${docEntry}`);

                if (!docEntry) {
                    const note = 'Docentry OIGE tidak ditemukan';
                    console.log('------------------------------------------------------------------------------------');
                    console.log(`Error-2: Not Found Docnum OIGE: ${record.PO_NO}`);
                    await updateRecordStatus(record.id, 0, note, null, null, pool);
                    await sendWhatsAppNotification(record.PO_NO, null, null, `Gagal: ${note}`, false, pool);
                    continue;
                }
                
                const goodsIssueData = await getGoodsIssueFromSAP(docEntry, sessionCookie);

                let validationResult = validateVfdatWithExpDate(record, goodsIssueData);
                // const vendor = record.VENDOR === 'VIRTUAL' ? 'CS-03' : record.VENDOR;
                
                let warehouseCode;
                let dfltwh = await getDfltwhForSKU(record.sub_vendor); 
                if (record.sub_vendor === 'VIRTUAL') {
                    warehouseCode = 'CS-03';
                } else {
                    switch (record.SKU_QUALITY) {
                        case 'Y':
                            if (dfltwh === 'BS03') {
                                warehouseCode = 'BS03';
                            } else if (dfltwh === 'BS04') {
                                warehouseCode = 'BS04';
                            } else if (dfltwh === 'BS02') {
                                warehouseCode = 'BS02';
                            } else {
                                warehouseCode = record.sub_vendor;
                            }
                            break;
                        case 'N':
                            warehouseCode = record.sub_vendor; 
                            break;
                        default:
                            warehouseCode = record.sub_vendor; 
                            break;
                    }
                }

                const vendor = warehouseCode === 'VIRTUAL' ? 'CS-03' : warehouseCode;

                if (!validationResult.isValid || !validationResult.batchData) {
                    const batchDataFromOBTN = await getBatchDataFromOBTN(record.SKU, vendor, pool);
                    if (!batchDataFromOBTN) {
                        const note = 'Batch data tidak ditemukan untuk SKU';
                        console.log('------------------------------------------------------------------------------------');
                        console.log(`SKU: ${record.SKU} | WHS: ${vendor} | Error-4: ${note}`);
                        await updateRecordStatus(record.id, 0, note, null, null, pool);
                        await sendWhatsAppNotification(record.PO_NO, null, null, `Gagal: ${note}`, false, pool);
                        continue;
                    }
                    validationResult = { isValid: true, batchData: batchDataFromOBTN };
                }

                const goodsReceiptPayload = await createGoodsReceiptPayload(record, validationResult.batchData, goodsIssueData, pool);
                const pcc = await postGoodsReceiptToSAP(goodsReceiptPayload, sessionCookie);

                if (pcc?.error) {
                    const status = pcc.message.includes('closed') ? 4 : 0;
                    const note = status === 4 ? `Gagal: ${pcc.message}` : `Gagal: ${pcc.message}`;
                    await updateRecordStatus(record.id, status, pcc.message, null, null, pool);
                    await sendWhatsAppNotification(record.PO_NO, null, null, note, false, pool);
                    continue;
                }

                const finalData = await getFinalGoodsReceiptData(docEntry, pool);

                if (finalData) {
                    const { GoodsReceiptDocEntry, GoodsReceiptDocNum } = finalData;
                    const successNote = 'Berhasil diproses sebagai Goods Receipt';
                    console.log('------------------------------------------------------------------------------------');
                    console.log(`DocEntry: ${GoodsReceiptDocEntry} | DocNum: ${GoodsReceiptDocNum}`);
                    await updateRecordStatus(record.id, 3, successNote, GoodsReceiptDocNum, GoodsReceiptDocEntry, pool);
                    await sendWhatsAppNotification(record.PO_NO, GoodsReceiptDocNum, GoodsReceiptDocEntry, successNote, true, pool);
                } else {
                    const note = 'Gagal: Goods Receipt tidak ditemukan setelah posting';
                    await updateRecordStatus(record.id, 0, note, null, null, pool);
                    await sendWhatsAppNotification(record.PO_NO, null, null, `Gagal: ${note}`, false, pool);
                }

            } catch (error) {
                const note = error.message.includes('already exists') || error.message.includes('already closed')
                    ? 'Data sudah ada/closed di SAP'
                    : error.message;
                const status = note.includes('already closed') ? 4 : 0;
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
        throw new Error(`Gagal login ke SAP: ${error.response?.data?.error?.message || error.message}`);
    }
};

const getDocEntryFromOIGE = async (poNo, pool) => {
    try {
        const query = `
            SELECT TOP 1 T0.DocEntry
            FROM [pksrv-sap].test.dbo.OIGE T0
            WHERE T0.Docnum = @poNo
            ORDER BY T0.DocDate DESC`;
        const result = await pool.request()
            .input('poNo', sql.Int, poNo)
            .query(query);
        return result.recordset[0]?.DocEntry || null;
    } catch (error) {
        console.log('------------------------------------------------------------------------------------');
        console.log(`Process: ${poNo} | Error-1: ${error.message}`);
        await updateRecordStatus(null, 0, error.message, null, null, pool, poNo);
        await sendWhatsAppNotification(poNo, null, null, `Gagal: ${error.message}`, false, pool);
        return null;
    }
};

const getGoodsIssueFromSAP = async (docEntry, sessionCookie) => {
    try {
        const response = await axios.get(
            `${SAP_CONFIG.BASE_URL}/InventoryGenExits(${docEntry})`,
            {
                headers: { 'Cookie': sessionCookie },
                httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
            }
        );
        return response.data;
    } catch (error) {
        throw new Error(`Gagal mendapatkan InventoryGenExits dari SAP: ${error.response?.data?.error?.message || error.message}`);
    }
};

const getBinAbsEntry = async (whsCode, pool) => {
    const query = `
        SELECT TOP 1 T0.AbsEntry 
        FROM [pksrv-sap].test.dbo.OBIN T0
        WHERE T0.WhsCode = @whsCode
        ORDER BY T0.AbsEntry ASC`;
    const result = await pool.request()
        .input('whsCode', sql.NVarChar, whsCode)
        .query(query);
    return result.recordset[0]?.AbsEntry || null;
};

const validateVfdatWithExpDate = (record, goodsIssueData) => {
    const lineItem = goodsIssueData.DocumentLines.find(line =>
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
            ExpiryDate: matchingBatch.ExpiryDate,
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
            ExpiryDate: batch.ExpirationDate?.toISOString().split('T')[0],
            Quantity: batch.AvailableQuantity
        };
    } catch (error) {
        throw new Error(`Gagal mendapatkan batch data dari OBTN: ${error.message}`);
    }
};

const createGoodsReceiptPayload = async (record, batchData, goodsIssue, pool) => {
    const lineItem = goodsIssue.DocumentLines.find(line =>
        line.ItemCode === record.SKU && line.LineNum.toString() === record.LINE_NO.toString()
    );

    // const whsCode = record.VENDOR === 'VIRTUAL' ? 'CS-03' : record.VENDOR;
    
    let warehouseCode;
    let dfltwh = await getDfltwhForSKU(record.sub_vendor); 
    if (record.sub_vendor === 'VIRTUAL') {
        warehouseCode = 'CS-03';
    } else {
        switch (record.SKU_QUALITY) {
            case 'Y':
                if (dfltwh === 'BS03') {
                    warehouseCode = 'BS03';
                } else if (dfltwh === 'BS04') {
                    warehouseCode = 'BS04';
                } else if (dfltwh === 'BS02') {
                    warehouseCode = 'BS02';
                } else {
                    warehouseCode = record.sub_vendor;
                }
                break;
            case 'N':
                warehouseCode = record.sub_vendor; 
                break;
            default:
                warehouseCode = record.sub_vendor; 
                break;
        }
    }

    const whsCode = warehouseCode === 'VIRTUAL' ? 'CS-03' : warehouseCode;

    const binAbsEntry = await getBinAbsEntry(whsCode, pool);

    const documentLines = [{
        ItemCode: record.SKU,
        Quantity: record.QTYPO,
        WarehouseCode: whsCode,
        UoMEntry: lineItem.UoMEntry,
        UoMCode: lineItem.UoMCode,
        InventoryQuantity: record.QTYPO,
        BaseEntry: goodsIssue.DocEntry,
        BaseType: 60,
        BaseLine: lineItem.LineNum
    }];

    if (batchData?.BatchNumber) {
        documentLines[0].BatchNumbers = [{
            BatchNumber: batchData.BatchNumber,
            Quantity: record.QTYPO,
            ExpiryDate: batchData.ExpiryDate,
            AddmisionDate: new Date().toISOString().split('T')[0]
        }];
    }

    if (binAbsEntry) {
        documentLines[0].DocumentLinesBinAllocations = [{
            BinAbsEntry: binAbsEntry,
            Quantity: record.QTYPO,
            SerialAndBatchNumbersBaseLine: 0,
            BaseLineNumber: 0
        }];
    }
    
    return {
        DocType: "dDocument_Items",
        DocDate: new Date().toISOString().split('T')[0],
        DocDueDate: new Date().toISOString().split('T')[0],
        Comments: `Penerimaan Barang berdasarkan Pengeluaran Barang #${goodsIssue.DocNum}`,
        JournalMemo: "Goods Receipt",
        DocTime: new Date().toLocaleTimeString('id-ID', { hour12: false }),
        Series: 686,
        TaxDate: new Date().toISOString().split('T')[0],
        DocObjectCode: "oInventoryGenEntry",
        DocumentLines: documentLines,
        U_IDU_MobBaseRef: goodsIssue.DocNum,
        U_IDU_No_TukarGuling: goodsIssue.DocNum,
        U_IDU_Referensi: goodsIssue.DocNum,
        U_IDU_JenisPajak: "04",
        U_IDU_Pengganti: "0",
        U_IDU_KetTambah: "0",
        U_IDU_Credit: "0",
        U_IDU_StatusInvoice: "No Tagih",
        U_IDU_TukarFaktur: "No TF",
        U_IDU_JDP: "0",
        U_IDU_RatePajak: "12",
        U_PK_VerifTT: 0,
        U_Print: 0,
        U_IDU_Status_DebitNote: "N"
    };
};

const postGoodsReceiptToSAP = async (payload, sessionCookie) => {
    try {
        const response = await axios.post(
            `${SAP_CONFIG.BASE_URL}/InventoryGenEntries`,
            payload, {
            headers: { 'Cookie': sessionCookie },
            httpsAgent: new(require('https').Agent)({ rejectUnauthorized: false })
        });
        return response.data;
    } catch (error) {
        const errorMessage = error.response?.data?.error?.message?.value ||
                             error.response?.statusText ||
                             error.message ||
                             'Terjadi kesalahan tidak dikenal.';
        
        console.log('------------------------------------------------------------------------------------');
        console.log('Error-3:', errorMessage);

        return { error: true, message: errorMessage };
    }
};

const getFinalGoodsReceiptData = async (goodsIssueDocEntry, pool) => {
    const query = `
        SELECT
            T1.DocEntry AS GoodsReceiptDocEntry,
            T1.DocNum AS GoodsReceiptDocNum
        FROM
            [pksrv-sap].test.dbo.OIGE T0
        LEFT JOIN
            [pksrv-sap].test.dbo.IGN1 T2 ON T0.DocEntry = T2.BaseEntry AND T2.BaseType = 60
        LEFT JOIN
            [pksrv-sap].test.dbo.OIGN T1 ON T2.DocEntry = T1.DocEntry
        WHERE
            T0.DocEntry = ${goodsIssueDocEntry}
        GROUP BY
            T1.DocEntry, T1.DocNum;
    `;

    // console.log(query);
    const result = await pool.request().query(query);
    return result.recordset.length > 0 ? result.recordset[0] : null;
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
            const docEntryFromOIGE = await getDocEntryFromOIGE(poNo, pool);
            if (docEntryFromOIGE) {
                const finalData = await getFinalGoodsReceiptData(docEntryFromOIGE, pool);
                if (finalData) {
                    finalDocEntry = finalData.GoodsReceiptDocEntry;
                    finalDocNum = finalData.GoodsReceiptDocNum;
                }
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
        console.log('Gagal mengirim notifikasi WhatsApp:', error);
        if (isSuccess) await resetNotificationStatus(poNo, pool);
        return { success: false, error: error.message };
    }
};

const formatWhatsAppMessage = (poNo, docNum, docEntry, note, isSuccess, statusText) => {
    const header = `*Tukar Guling - ${statusText}*`;
    let docInfo = `*PO No:* ${poNo}`;
    if (docNum) docInfo += `\n*Doc Num:* ${docNum}`;
    if (docEntry) docInfo += `\n*Doc Entry:* ${docEntry}`;
    
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
        processTradeinTradeout().catch(error => {
            console.log('------------------------------------------------------------------------------------');
            console.log(`Error: ${error}`);
            console.log('------------------------------------------------------------------------------------');
        });

        console.log('------------------------------------------------------------------------------------');
        setInterval(() => processTradeinTradeout(), 20000);
        app.listen(31130, () => {
            console.log('Server ready on port 31130');
        });
    } catch (error) {
        console.error('Startup failed:', error);
        process.exit(1);
    }
};

initialize();