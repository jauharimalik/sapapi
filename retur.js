// jo ganteng 1z

const app = require('./app');
const axios = require('axios');
const sql = require('mssql');
const FormData = require('form-data');

// --- Konfigurasi SAP ---
const SAP_CONFIG = {
    BASE_URL: 'https://192.168.101.254:50000/b1s/v2',
    COMPANY_DB: 'TEST',
    CREDENTIALS: {
        username: 'manager',
        password: 'Password#1'
    }
};

// --- Konfigurasi Database ---
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

// --- Konfigurasi WhatsApp ---
const WHATSAPP_CONFIG = {
    apiUrl: 'http://103.169.73.3:4040/send-group-message',
    successGroup: '120363420162985105@g.us',
    failureGroup: '120363421138507049@g.us'
};

// --- Konfigurasi Telegram ---
const TELEGRAM_CONFIG = {
    successUrl: 'http://192.168.100.202:40200/group-cs-success',
    failureUrl: 'http://192.168.100.202:40200/group-cs-error'
};

// --- Fungsi Utama Proses GRPO Coldspace ---
const processGrpoColdspace = async () => {
    let pool;
    try {
        pool = await sql.connect(DB_CONFIG);

        const result = await pool.request()
            .query(`SELECT *,
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
                [pksrv-sap].test.dbo.oitm t2 ON t0x.sku collate database_default = t2.itemcode collate database_default 
            WHERE 
                (t0x.iswa IS NULL OR t0x.jo_status IS NULL) 
            AND t0x.TRK_TYPE = 'N-TY'`);

        if (result.recordset.length === 0) {
            console.log('------------------------------------------------------------------------------------');
            console.log('Tidak ada data yang perlu diproses.');
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
                    await sendNotification(record.PO_NO, null, null, `Gagal: ${note}`, false, pool);
                    continue;
                }

                const docEntry = await getDocEntryFromORRR(record.PO_NO, pool);
                console.log('------------------------------------------------------------------------------------');
                console.log(`Process: ${record.PO_NO} | Doc Entry: ${docEntry}`);

                if (!docEntry) {
                    const note = 'Docentry tidak ditemukan';
                    console.log('------------------------------------------------------------------------------------');
                    console.log(`Error-2: Not Found Docnum: ${record.PO_NO}`);
                    await updateRecordStatus(record.id, 0, note, null, null, pool);
                    await sendNotification(record.PO_NO, null, null, `Gagal: ${note}`, false, pool);
                    continue;
                }

                const returnRequest = await getReturnRequestFromSAP(docEntry, sessionCookie);
                let validationResult = validateVfdatWithExpDate(record, returnRequest);

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
                    const batchDataFromOBTN = await getBatchDataFromOBTN(record.SKU, vendor, record.VFDAT,pool);
                    if (!batchDataFromOBTN) {
                        const note = 'Batch data tidak ditemukan untuk SKU';
                        console.log('------------------------------------------------------------------------------------');
                        console.log(`SKU: ${record.SKU} | WHS: ${vendor} | Error-4: ${note}`);
                        await updateRecordStatus(record.id, 0, note, null, null, pool);
                        await sendNotification(record.PO_NO, null, null, `Gagal: ${note}`, false, pool);
                        continue;
                    }
                    validationResult = { isValid: true, batchData: batchDataFromOBTN };
                }

                const creditNotePayload = await createCreditNotePayload(record, validationResult.batchData, returnRequest);
                const pcc = await postCreditNoteToSAP(creditNotePayload, sessionCookie);
                
                if (pcc?.error) {
                    const status = pcc.message.includes('closed') ? 3 : 0;
                    const note = status === 3 ? `Berhasil diproses sebagai Returns` : `Gagal: ${pcc.message}`;
                    await updateRecordStatus(record.id, status, note, null, null, pool);
                    await sendNotification(record.PO_NO, null, null, note, true, pool);
                    continue;
                }

                const finalData = await getFinalCreditNoteData(docEntry, pool);

                if (finalData) {
                    const { CreditNoteDocEntry, CreditNoteDocNum } = finalData;
                    const successNote = 'Berhasil diproses dengan batch alternatif';
                    console.log('------------------------------------------------------------------------------------');
                    console.log(`DocEntry: ${CreditNoteDocEntry} | DocNum: ${CreditNoteDocNum}`);
                    await updateRecordStatus(record.id, 3, successNote, CreditNoteDocNum, CreditNoteDocEntry, pool);
                    await sendNotification(record.PO_NO, CreditNoteDocNum, CreditNoteDocEntry, successNote, true, pool);
                } else {
                    const note = 'Gagal: Credit Note tidak ditemukan setelah posting';
                    await updateRecordStatus(record.id, 0, note, null, null, pool);
                    await sendNotification(record.PO_NO, null, null, `Gagal: ${note}`, false, pool);
                }

            } catch (error) {
                const note = error.message.includes('already exists') || error.message.includes('already closed')
                    ? 'Data sudah ada/closed di SAP'
                    : error.message;
                const status = note.includes('already closed') ? 4 : 0;
                await updateRecordStatus(record.id, status, note, null, null, pool);
                await sendNotification(record.PO_NO, null, null, `Gagal: ${note}`, false, pool);
            }
        }

    } catch (error) {
        console.error('Error dalam proses utama:', error);
    } finally {
        if (pool) await pool.close();
    }
};

// --- Fungsi Bantu ---
async function getDfltwhForSKU(sku) {
    if (sku === 'G502') return 'BS03';
    if (sku === 'K102') return 'BS04';
    if (sku === 'F001') return 'BS02';
    return null;
}

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

const getDocEntryFromORRR = async (poNo, pool) => {
    try {
        const result = await pool.request()
            .input('poNo', sql.Int, poNo)
            .query('SELECT TOP 1 docentry FROM [pksrv-sap].test.dbo.orrr WHERE docnum = @poNo');
        return result.recordset[0]?.docentry || null;
    } catch (error) {
        console.log('------------------------------------------------------------------------------------');
        console.log(`Process: ${poNo} | Error-1: ${error.message}`);
        await updateRecordStatus(null, 0, error.message, null, null, pool, poNo);
        await sendNotification(poNo, null, null, `Gagal: ${error.message}`, false, pool);
        return null;
    }
};

const getReturnRequestFromSAP = async (docEntry, sessionCookie) => {
    try {
        const response = await axios.get(
            `${SAP_CONFIG.BASE_URL}/ReturnRequest(${docEntry})`,
            {
                headers: { 'Cookie': sessionCookie },
                httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
            }
        );
        return response.data;
    } catch (error) {
        throw new Error(`Gagal mendapatkan ReturnRequest dari SAP: ${error.response?.data?.error?.message || error.message}`);
    }
};

const validateVfdatWithExpDate = (record, returnRequest) => {
    const lineItem = returnRequest.DocumentLines.find(line =>
        line.ItemCode === record.SKU && line.LineNum.toString() === record.LINE_NO.toString()
    );

    if (!lineItem?.BatchNumbers || lineItem.BatchNumbers.length === 0) {
        return { isValid: false, batchData: null };
    }

    const rawVfdat = record.VFDAT; 

    let vfdatIso = null;
    if (rawVfdat && rawVfdat.length === 6) {
        const year = `20${rawVfdat.substring(0, 2)}`;
        const month = rawVfdat.substring(2, 4);
        const day = rawVfdat.substring(4, 6);
        vfdatIso = `${year}-${month}-${day}`;
    } else {
        console.warn("record.VFDAT is not in YYMMDD format or is missing:", rawVfdat);
        return { isValid: false, batchData: null };
    }

    console.log("Converted VFDAT (YYYY-MM-DD):", vfdatIso);

    const matchingBatch = lineItem.BatchNumbers.find(batch => {
        const expDate = batch.ExpiryDate ? new Date(batch.ExpiryDate).toISOString().split('T')[0] : null;
        return expDate === vfdatIso;
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

const getBatchDataFromOBTN = async (itemCode, whsCode, ExpDate, pool) => {
    try {
        let query = `
            SELECT TOP 1
                isnull(T1.BatchNum,'${ExpDate}') AS BatchNumber,
                T1.Quantity AS AvailableQuantity,
                isnull(T1.ExpDate,'${ExpDate}') AS ExpirationDate,
                isnull(T1.ExpDate,'${ExpDate}') AS ExpDate
            FROM [pksrv-sap].test.dbo.OIBT T1
            inner join [pksrv-sap].test.dbo.oitm t2 on t1.itemcode = t2.itemcode
            WHERE T1.ItemCode = '${itemCode}' AND 
            (T1.WhsCode = '${whsCode}' or t1.whscode = t2.dfltwh) AND T1.Quantity > 0
            AND t1.batchnum like '${ExpDate}%'
            ORDER BY T1.ExpDate ASC`;

        const result = await pool.request().query(query);

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

const createCreditNotePayload = async (record, batchData, returan) => {
    const lineItem = returan.DocumentLines.find(line =>
        line.ItemCode === record.SKU && line.LineNum.toString() === record.LINE_NO.toString()
    );

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

    const documentLines = [{
        ItemCode: record.SKU,
        Quantity: record.QTYPO,
        WarehouseCode: warehouseCode,
        BaseEntry: returan.DocEntry,
        BaseType: 234000031,
        VatGroup: lineItem.VatGroup,
        BaseLine: lineItem.LineNum
    }];

    if (batchData?.BatchNumber) {
        documentLines[0].BatchNumbers = [{
            BatchNumber: batchData.BatchNumber,
            Quantity: record.QTYPO,
            AddmisionDate: new Date().toISOString().split('T')[0]
        }];
    }

    return {
        CardCode: returan.CardCode,
        DocDate: new Date().toISOString().split('T')[0],
        DocDueDate: new Date().toISOString().split('T')[0],
        TaxDate: new Date().toISOString().split('T')[0],
        Comments: `Retur untuk PO: ${record.PO_NO}, ASN: ${record.WMS_ASN_NO}`,
        DocumentLines: documentLines
    };
};

const postCreditNoteToSAP = async (payload, sessionCookie) => {
    try {
        const response = await axios.post(
            `${SAP_CONFIG.BASE_URL}/CreditNotes`,
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

const getFinalCreditNoteData = async (goodsReturnDocEntry, pool) => {
    const query = `
        SELECT
            T2.DocEntry AS CreditNoteDocEntry,
            T2.DocNum AS CreditNoteDocNum
        FROM
            [pksrv-sap].test.dbo.ORRR T0
        LEFT JOIN
            [pksrv-sap].test.dbo.RIN1 T1 ON T0.DocEntry = T1.BaseEntry
        LEFT JOIN
            [pksrv-sap].test.dbo.ORIN T2 ON T1.DocEntry = T2.DocEntry
        WHERE
            T0.DocEntry = @GoodsReturnDocEntry
    `;
    const result = await pool.request()
        .input('GoodsReturnDocEntry', sql.Int, goodsReturnDocEntry)
        .query(query);
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

// --- FUNGSI NOTIFIKASI YANG DIGABUNGKAN ---
const sendNotification = async (poNo, existingDocNum, existingDocEntry, note, isSuccess, pool) => {
    let finalDocNum = existingDocNum;
    let finalDocEntry = existingDocEntry;
    const finalNote = note;

    if (isSuccess && (!finalDocNum || !finalDocEntry) && poNo) {
        try {
            const docEntryFromOrrr = await getDocEntryFromORRR(poNo, pool);
            if (docEntryFromOrrr) {
                const finalData = await getFinalCreditNoteData(docEntryFromOrrr, pool);
                if (finalData) {
                    finalDocEntry = finalData.CreditNoteDocEntry;
                    finalDocNum = finalData.CreditNoteDocNum;
                }
            }
        } catch (queryError) {
            console.error(`Gagal mencari DocNum/DocEntry di dalam sendNotification: ${queryError.message}`);
        }
    }

    const whatsAppStatusText = isSuccess ? 'SUCCESS' : 'FAILED';
    const whatsAppMessage = formatWhatsAppMessage(poNo, finalDocNum, finalDocEntry, finalNote, isSuccess, whatsAppStatusText);

    // Kirim notifikasi WhatsApp
    const whatsAppResult = await sendWhatsApp(poNo, whatsAppMessage, isSuccess);

    // Kirim notifikasi Telegram
    const telegramResult = await sendTelegram(whatsAppMessage, isSuccess);

    // Log hasil pengiriman
    console.log(`Notifikasi untuk PO ${poNo} - WhatsApp: ${whatsAppResult.success ? 'Berhasil' : 'Gagal'} | Telegram: ${telegramResult.success ? 'Berhasil' : 'Gagal'}`);
    
    // Perbarui status database jika pengiriman WhatsApp gagal
    if (!whatsAppResult.success) {
        await resetNotificationStatus(poNo, pool);
    }
};

// Fungsi internal untuk mengirim ke WhatsApp
async function sendWhatsApp(poNo, message, isSuccess) {
    const groupId = isSuccess ? WHATSAPP_CONFIG.successGroup : WHATSAPP_CONFIG.failureGroup;
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
        return { success: true, messageId: response.data?.id || null };
    } catch (error) {
        console.error(`Gagal mengirim notifikasi WhatsApp untuk PO ${poNo}:`, error.message);
        return { success: false, error: error.message };
    }
}

// Fungsi internal untuk mengirim ke Telegram
async function sendTelegram(message, isSuccess) {
    const url = isSuccess ? TELEGRAM_CONFIG.successUrl : TELEGRAM_CONFIG.failureUrl;
    // Bersihkan format WhatsApp untuk Telegram jika perlu
    const telegramMessage = message.replace(/\*/g, '').replace(/\n/g, ' '); 
    
    try {
        await axios.post(url, { message: telegramMessage }, { timeout: 10000 });
        return { success: true };
    } catch (error) {
        console.error(`Gagal mengirim notifikasi Telegram ke endpoint ${url}:`, error.message);
        return { success: false, error: error.message };
    }
}

const formatWhatsAppMessage = (poNo, docNum, docEntry, note, isSuccess, statusText) => {
    const header = `*GR Return COLDSPACE PROCESSING - ${statusText}*`;
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
        processGrpoColdspace().catch(error => {
            console.log('------------------------------------------------------------------------------------');
            console.log(`Error: ${error}`);
            console.log('------------------------------------------------------------------------------------');
        });

        console.log('------------------------------------------------------------------------------------');
        setInterval(() => processGrpoColdspace(), 20000);
        app.listen(31738, () => {
            console.log('Server ready on port 31738');
        });
    } catch (error) {
        console.error('Startup failed:', error);
        process.exit(1);
    }
};

initialize();