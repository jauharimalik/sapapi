const app = require('./app');
const axios = require('axios');
const sql = require('mssql');
const FormData = require('form-data');
const https = require('https');

const SAP_CONFIG = {
    BASE_URL: 'https://192.168.101.254:50000/b1s/v1',
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

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// Helper function to convert date format yymmdd to yyyy-mm-dd
function convertVfdatToExpiryDate(vfdat) {
    if (!vfdat || vfdat.length !== 6) {
        return null;
    }
    const year = parseInt(vfdat.substring(0, 2), 10) + 2000;
    const month = vfdat.substring(2, 4);
    const day = vfdat.substring(4, 6);
    return `${year}-${month}-${day}`;
}

async function loginToSAP() {
    try {
        const response = await axios.post(
            `${SAP_CONFIG.BASE_URL}/Login`,
            {
                CompanyDB: SAP_CONFIG.COMPANY_DB,
                UserName: SAP_CONFIG.CREDENTIALS.username,
                Password: SAP_CONFIG.CREDENTIALS.password
            },
            { httpsAgent: httpsAgent }
        );
        return response.headers['set-cookie'].join('; ');
    } catch (error) {
        throw new Error(`Gagal login ke SAP: ${error.response?.data?.error?.message?.value || error.message}`);
    }
}

async function getProductionOrderData(poNumber, sessionCookie, pool) {
    try {
        let query = `SELECT DocEntry, DocNum FROM [pksrv-sap].test.dbo.OWOR WHERE DocNum = '${poNumber}'`;
        const result = await pool.request().query(query);

        if (result.recordset.length === 0) {
            return { error: `Production Order ${poNumber} tidak ditemukan di database SAP` };
        }

        const docEntry = result.recordset[0].DocEntry;
        const response = await axios.get(
            `${SAP_CONFIG.BASE_URL}/ProductionOrders(${docEntry})`,
            {
                headers: { 'Cookie': sessionCookie },
                httpsAgent: httpsAgent
            }
        );
        return { data: response.data };
    } catch (error) {
        return { error: `Gagal mendapatkan data Production Order dari SAP API: ${error.response?.data?.error?.message?.value || error.message}` };
    }
}

async function closeProductionOrder(poNumber, sessionCookie, pool) {
    try {
        const poDataResult = await getProductionOrderData(poNumber, sessionCookie, pool);

        if (poDataResult.error) {
            return { error: poDataResult.error };
        }

        const docEntry = poDataResult.data.AbsoluteEntry;

        if (poDataResult.data.ProductionOrderStatus === 'boposClosed') {
            return { message: `Production Order ${poNumber} is already closed.` };
        }

        const payload = {
            "ProductionOrderStatus": "boposClosed"
        };

        const response = await axios.patch(
            `${SAP_CONFIG.BASE_URL}/ProductionOrders(${docEntry})`,
            payload,
            {
                headers: {
                    'Cookie': sessionCookie,
                    'Content-Type': 'application/json'
                },
                httpsAgent: httpsAgent
            }
        );
        
        console.log(`Successfully closed Production Order ${poNumber}.`);
        return { message: `Production Order ${poNumber} (DocEntry: ${docEntry}) has been closed.` };

    } catch (error) {
        const errorMessage = error.response?.data?.error?.message?.value || error.message;
        console.error(`Failed to close Production Order ${poNumber}:`, errorMessage);
        return { error: `Failed to close Production Order ${poNumber}: ${errorMessage}` };
    }
}

const getBatchDataFromOIBT = async (itemCode, whsCode, ExpDate, pool) => {
    try {
        const query = `
            SELECT TOP 1
                ISNULL(T1.BatchNum,'${ExpDate}') AS BatchNumber,
                T1.Quantity AS AvailableQuantity,
                ISNULL(T1.ExpDate,'${convertVfdatToExpiryDate(ExpDate)}') AS ExpirationDate
            FROM [pksrv-sap].test.dbo.OIBT T1
            INNER JOIN [pksrv-sap].test.dbo.oitm T2 ON T1.ItemCode = T2.ItemCode
            WHERE T1.ItemCode = '${itemCode}'
            AND (T1.WhsCode = '${whsCode}')
            AND T1.Quantity > 0
            AND T1.BatchNum LIKE '${ExpDate}%'
            ORDER BY T1.ExpDate ASC
        `;
        const result = await pool.request().query(query);

        if (result.recordset.length === 0) return null;
        const batch = result.recordset[0];

        return {
            BatchNumber: batch.BatchNumber,
            ExpiryDate: batch.ExpirationDate?.toISOString().split('T')[0] ?? convertVfdatToExpiryDate(ExpDate),
            Quantity: batch.AvailableQuantity
        };
    } catch (error) {
        throw new Error(`Gagal mendapatkan batch data dari OIBT: ${error.message}`);
    }
};

async function createGoodsIssue(issueData, sessionCookie) {
    try {
        // const response = await axios.post(
        //     `${SAP_CONFIG.BASE_URL}/ProductionOrders/IssueForProduction`,
        
        let risip = `${SAP_CONFIG.BASE_URL}/InventoryGenExits`
        const response = await axios.post(
            risip,
            issueData,
            { headers: { 'Cookie': sessionCookie }, httpsAgent: httpsAgent }
        );
        return response.data;
    } catch (error) {
        // throw new Error(`Gagal membuat Goods Issue: ${error.response?.data?.error?.message?.value || error.message}`);
    }
}

async function createGoodsReceipt(receiptData, sessionCookie) {
    try {
        // `${SAP_CONFIG.BASE_URL}/ProductionOrders/ReceiptFromProduction`,
        let risip = `${SAP_CONFIG.BASE_URL}/InventoryGenEntries`
        const response = await axios.post(
            risip,
            receiptData,
            { headers: { 'Cookie': sessionCookie }, httpsAgent: httpsAgent }
        );
        return response.data;
    } catch (error) {
        throw new Error(`Gagal membuat Goods Receipt: ${error.response?.data?.error?.message?.value || error.message}`);
    }
}

async function updateRecordStatus(id, poNo, joStatus, note, docNum, docEntry, pool) {
    try {
        await pool.request()
            .input('id', sql.Int, id)
            .input('poNo', sql.Int, poNo)
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
                    iswa = 1
                WHERE id = @id;
            `);
    } catch (error) {
        console.error(`Gagal update status record PO ${poNo}: ${error.message}`);
    }
}

async function sendWhatsAppNotification(poNo, docNum, docEntry, note, isSuccess) {
    const groupId = isSuccess ? WHATSAPP_CONFIG.successGroup : WHATSAPP_CONFIG.failureGroup;
    const statusText = isSuccess ? 'SUCCESS' : 'FAILED';
    const message = formatWhatsAppMessage(poNo, docNum, docEntry, note, statusText);

    const form = new FormData();
    form.append('id_group', groupId);
    form.append('message', message);

    try {
        await axios.post(WHATSAPP_CONFIG.apiUrl, form, {
            headers: form.getHeaders(),
            timeout: 10000
        });
        console.log(`Notifikasi WhatsApp berhasil dikirim untuk PO ${poNo}`);
        return { success: true };
    } catch (error) {
        console.error(`Gagal mengirim notifikasi WhatsApp untuk PO ${poNo}:`, error.message);
        return { success: false, error: error.message };
    }
}

function formatWhatsAppMessage(poNo, docNum, docEntry, note, statusText) {
    const header = `*Production Order Processing - ${statusText}*`;
    let docInfo = `*Production Order Number:* ${poNo}`;
    if (docNum) docInfo += `\n*SAP DocNum:* ${docNum}`;
    if (docEntry) docInfo += `\n*SAP DocEntry:* ${docEntry}`;

    return `${header}\n\n${docInfo}\n\n*Details:*\n${note}`;
}

async function processProductionOrders() {
    let pool;
    try {
        pool = await sql.connect(DB_CONFIG);
        console.log('Memulai proses Production Orders...');

        const result = await pool.request()
            .query(`SELECT * FROM r_grpo_coldspace WHERE TRK_TYPE = 'prod' AND (iswa IS NULL OR jo_status IS NULL)`);

        if (result.recordset.length === 0) {
            console.log('Tidak ada data produksi yang perlu diproses.');
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
                    await updateRecordStatus(record.id, record.PO_NO, 0, note, null, null, pool);
                    await sendWhatsAppNotification(record.PO_NO, null, null, note, false);
                    continue;
                }

                let woDataResult = await getProductionOrderData(record.PO_NO, sessionCookie, pool);
                
                if (woDataResult.error) {
                    await updateRecordStatus(record.id, record.PO_NO, 0, woDataResult.error, null, null, pool);
                    await sendWhatsAppNotification(record.PO_NO, null, null, woDataResult.error, false);
                    continue;
                }
                let woData = woDataResult.data;
                if (woData.ProductionOrderType === 'bopotDisassembly') {}
                else{
                       
                    if (woData.ProductionOrderStatus === 'boposClosed') {
                        const note = 'Dokumen Production Order sudah selesai (closed).';
                        await updateRecordStatus(record.id, record.PO_NO, 3, note, woData.DocumentNumber, woData.AbsoluteEntry, pool);
                        await sendWhatsAppNotification(record.PO_NO, woData.DocumentNumber, woData.AbsoluteEntry, note, true);
                        continue;
                    }

                    
                    const docDate = new Date().toISOString().split('T')[0];
                    const today = new Date(docDate);
                    const nextDay = new Date(today);
                    nextDay.setDate(today.getDate() + 1);
                    const nextDocDate = nextDay.toISOString().split('T')[0];

                    const now = new Date();
                    const hhmmss = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
                    const expiryDate = convertVfdatToExpiryDate(record.VFDAT);

                    // --- BAGIAN GOODS ISSUE ---
                    const issueLines = [];
                    for (const line of woData.ProductionOrderLines) {
                        // Cek apakah kuantitas yang dibutuhkan lebih besar dari 0
                        if (line.PlannedQuantity > 0) {
                            const batchInfo = await getBatchDataFromOIBT(line.ItemNo, line.Warehouse, record.VFDAT, pool);
                            if (!batchInfo) {
                                throw new Error(`Batch number untuk item ${line.ItemNo} dengan Expiry Date ${expiryDate} tidak ditemukan.`);
                            }
                            
                            issueLines.push({
                                "Quantity": line.PlannedQuantity,
                                "WarehouseCode": line.Warehouse,
                                "ProductionOrderEntry": woData.AbsoluteEntry,
                                "ProductionOrderLineNumber": line.LineNumber,
                                "BaseEntry": woData.AbsoluteEntry,
                                "BaseType": 202,
                                "BaseLine": line.LineNumber,
                                "AccountCode": "101120101",
                                "UseBaseUnits": "tYES",
                                "BatchNumbers": [{
                                    "BatchNumber": batchInfo.BatchNumber,
                                    "Quantity": line.PlannedQuantity,
                                    "InternalSerialNumber": batchInfo.BatchNumber,
                                    "ExpiryDate": batchInfo.ExpiryDate,
                                    "BaseLineNumber": line.LineNumber
                                }]
                            });
                        }
                    }
                    
                    const goodsIssuePayload = {
                        "DocDate": docDate,
                        "DocDueDate": docDate,
                        "Series": 644,
                        "FromWarehouse": woData.Warehouse,
                        "JournalMemo": `Production Order - ${woData.ItemNo}`,
                        "DocumentLines": issueLines
                    };

                    // Log payload Goods Issue sebelum dikirim
                    // console.log(`Payload Goods Issue untuk PO ${record.PO_NO}:`);
                    // console.log(JSON.stringify(goodsIssuePayload, null, 2));
                    const totalIssuedQuantity = woData.ProductionOrderLines.reduce((sum, line) => sum + line.IssuedQuantity, 0);
                    
                    if (totalIssuedQuantity >= woData.PlannedQuantity) {
                        const note = 'Tidak dapat melakukan Goods Issue. Semua bahan baku yang dibutuhkan sudah dikeluarkan.';
                        console.error(note);
                        await updateRecordStatus(record.id, record.PO_NO, 0, note, null, null, pool);
                        await sendWhatsAppNotification(record.PO_NO, null, null, note, false);
                    } else {
                        const goodsIssueResult = await createGoodsIssue(goodsIssuePayload, sessionCookie);
                        console.log(`Goods Issue berhasil dibuat untuk PO ${record.PO_NO} `);
                    }

                    // --- BAGIAN GOODS RECEIPT ---
                    const goodsReceiptPayload = {
                        "Series": 643,
                        "FromWarehouse": woData.Warehouse,
                        "JournalMemo": woData.JournalRemarks,
                        "DocumentLines": [
                            {
                                "Quantity": record.QTYPO, 
                                "WarehouseCode": woData.Warehouse,
                                "BaseEntry": woData.AbsoluteEntry,
                                "BaseType": 202,
                                "UseBaseUnits": "tYES",
                                "ProductionOrderEntry": woData.AbsoluteEntry,
                                "ProductionOrderLineNumber": -1,
                                "BatchNumbers": [
                                    {
                                        "BatchNumber": `${record.VFDAT}#${hhmmss}`,
                                        "Quantity": record.QTYPO, 
                                        "InternalSerialNumber": `${record.VFDAT}#${hhmmss}`,
                                        "ExpiryDate": expiryDate,
                                        "BaseLineNumber": 0
                                    }
                                ]
                            }
                        ]
                    };

                    // // Log payload Goods Receipt sebelum dikirim
                    // console.log(`Payload Goods Receipt untuk PO ${record.PO_NO}:`);
                    // console.log(JSON.stringify(goodsReceiptPayload, null, 2));

                    if (woData.CompletedQuantity >= woData.PlannedQuantity) {
                        const note = 'Tidak dapat melakukan Goods Receipt. Kuantitas selesai sudah memenuhi kuantitas yang direncanakan.';
                        console.error(note);
                        await updateRecordStatus(record.id, record.PO_NO, 0, note, null, null, pool);
                        await sendWhatsAppNotification(record.PO_NO, null, null, note, false);
                        continue;
                    }else{
                        const goodsReceiptResult = await createGoodsReceipt(goodsReceiptPayload, sessionCookie);
                        console.log(`Goods Receipt berhasil dibuat untuk PO ${record.PO_NO}`);
                        const successNote = `Berhasil memproses Production Order  ${record.PO_NO} `;
                        await updateRecordStatus(record.id, record.PO_NO, 3, successNote, null, null, pool);
                        await sendWhatsAppNotification(record.PO_NO, null, null, successNote, true);    
                    }

                    // closeProductionOrder(record.PO_NO, sessionCookie, pool);

                }
            } catch (error) {
                const note = `Gagal memproses Production Order ${record.PO_NO}: ${error.message}`;
                const status = error.message.includes('already exists') ? 4 : 0;
                console.error(`Error processing record ${record.PO_NO}:`, note);
                await updateRecordStatus(record.id, record.PO_NO, status, note, null, null, pool);
                await sendWhatsAppNotification(record.PO_NO, null, null, note, false);
            }
        }
    } catch (error) {
        console.error('Error dalam proses utama Production Orders:', error.message);
    } finally {
        if (pool) await pool.close();
    }
}

const initialize = async () => {
    try {
        processProductionOrders().catch(error => {
            console.error('Error in initial Production Order process:', error);
        });
        
        setInterval(() => processProductionOrders(), 20000);

        app.listen(31516, () => {
            console.log('Server ready on port 31516');
        });
    } catch (error) {
        console.error('Startup failed:', error);
        process.exit(1);
    }
};

initialize();