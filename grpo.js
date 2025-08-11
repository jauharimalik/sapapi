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

async function loginToSAP() {
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
}

async function getPODataFromSAP(poNumber, sessionCookie) {
    // try {
        // Cari DocEntry PO di database
        const pool = await sql.connect(DB_CONFIG);
        let query = `SELECT DocEntry FROM [pksrv-sap].test.dbo.OPOR WHERE DocNum = '${poNumber}'`;
        const result = await pool.request().query(query);


        if (result.recordset.length === 0) {
            let noter = `Error: PO ${poNumber} Tidak Ditemukan`;
            console.log('------------------------------------------------------------------------------------');
            console.log(noter);
            
            await pool.request()
            .input('PO_NO', sql.Int, poNumber)
            .input('note', sql.NVarChar, noter)
            .query(`
                UPDATE r_grpo_coldspace
                SET jo_status = 0, note = @note, iswa = 1
                WHERE PO_NO = @PO_NO;
            `);
            
            await sendWhatsAppNotification(poNumber, null, null, noter, false, pool);
            // throw new Error(`PO dengan nomor ${poNumber} tidak ditemukan`);
        }else{
            const docEntry = result.recordset[0].DocEntry;
            const response = await axios.get(
                `${SAP_CONFIG.BASE_URL}/PurchaseOrders(${docEntry})`,
                {
                    headers: { 'Cookie': sessionCookie },
                    httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
                }
            );
            return response.data;
        }
    // } catch (error) {
    //     throw new Error(`Gagal mendapatkan data PO dari SAP: ${error.response?.data?.error?.message?.value || error.message}`);
    // }
}

async function createGRPODraft(grpoData, sessionCookie) {
    try {
        const response = await axios.post(
            `${SAP_CONFIG.BASE_URL}/Drafts`,
            grpoData,
            {
                headers: { 'Cookie': sessionCookie },
                httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
            }
        );
        return response.data;
    } catch (error) {
        
        let noter = `Error: ${error.response?.data?.error?.message?.value || error.message} `;
        console.log('------------------------------------------------------------------------------------');
        console.log(noter);
        // throw new Error(`Gagal membuat draft GRPO: ${error.response?.data?.error?.message?.value || error.message}`);
    }
}

async function createGRPOFromDraft(draftData, sessionCookie) {
    try {
        const response = await axios.post(
            `${SAP_CONFIG.BASE_URL}/PurchaseDeliveryNotes/CreateFromDraft`,
            draftData,
            {
                headers: { 'Cookie': sessionCookie },
                httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
            }
        );
        return response.data;
    } catch (error) {
        
        
        let noter = `Error: ${error.response?.data?.error?.message?.value || error.message} `;
        console.log('------------------------------------------------------------------------------------');
        console.log(noter);
        // throw new Error(`Gagal membuat GRPO dari draft: ${error.response?.data?.error?.message?.value || error.message}`);
    }
}

async function updateRecordStatus(id, joStatus, note, docNum, docEntry, pool) {
    try {
        
        await pool.request()
            .input('id', sql.Int, id)
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
                WHERE id = @id;
            `);
    } catch (error) {
        throw new Error(`Gagal update status record: ${error.message}`);
    }
}

async function sendWhatsAppNotification(poNo, docNum, docEntry, note, isSuccess, pool) {
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
        return { success: true };
    } catch (error) {
        console.error('Gagal mengirim notifikasi WhatsApp:', error.message);
        return { success: false, error: error.message };
    }
}

function formatWhatsAppMessage(poNo, docNum, docEntry, note, statusText) {
    const header = `*GRPO Processing - ${statusText}*`;
    let docInfo = `*PO Number:* ${poNo}`;
    if (docNum) docInfo += `\n*GRPO DocNum:* ${docNum}`;
    if (docEntry) docInfo += `\n*GRPO DocEntry:* ${docEntry}`;
    
    return `${header}\n\n${docInfo}\n\n*Details:*\n${note}`;
}

async function processGRPO() {
    let pool;
    try {
        pool = await sql.connect(DB_CONFIG);
        console.log('Memulai proses GRPO...');
        
        // Ambil data dari r_grpo_coldspace dengan TRK_TYPE = 'ITEM'
        const result = await pool.request()
            .query(`SELECT * FROM r_grpo_coldspace WHERE TRK_TYPE = 'ITEM' AND (iswa IS NULL OR jo_status IS NULL)`);
        
        if (result.recordset.length === 0) {
            console.log('Tidak ada data GRPO yang perlu diproses.');
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
                    await sendWhatsAppNotification(record.PO_NO, null, null, note, false, pool);
                    continue;
                }
                
                // 1. Dapatkan data PO dari SAP
                const poData = await getPODataFromSAP(record.PO_NO, sessionCookie);
                if(poData){

                    // 2. Buat payload GRPO
                    const grpoPayload = {
                        "DocObjectCode": "oPurchaseDeliveryNotes",
                        "CardCode": poData.CardCode,
                        "DocDate": new Date().toISOString().split('T')[0],
                        "DocDueDate": new Date().toISOString().split('T')[0],
                        "TaxDate": new Date().toISOString().split('T')[0],
                        "Comments": `GRPO for PO ${record.PO_NO}`,
                        "JournalMemo": `GRPO for PO ${record.PO_NO}`,
                        "DocumentLines": [
                            {
                                "ItemCode": record.SKU,
                                "Quantity": record.QTYPO,
                                "WarehouseCode": record.SLOC,
                                "BaseType": 22, // 22 = Purchase Order
                                "BaseEntry": poData.DocEntry,
                                "BaseLine": record.LINE_NO,
                                "BatchNumbers": [
                                    {
                                        "BatchNumber": record.VFDAT,
                                        "Quantity": record.QTYPO,
                                        "InternalSerialNumber": record.VFDAT,
                                        "AddmisionDate": new Date().toISOString().split('T')[0],
                                        "ExpiryDate": record.VFDAT,
                                        "BaseLineNumber": 0
                                    }
                                ]
                            }
                        ],
                        "AddressExtension": {
                            "DeliveryStreet": `Driver: ${record.driver}, Kendaraan: ${record.nopolisi}`,
                            "ShipToStreet": "Grha Unilever, Green Office park Kav.3 Jl. BSD Boulevard barat",
                            "ShipToCity": "BSD City",
                            "ShipToState": "Tangerang",
                            "ShipToCountry": "ID",
                            "ShipToZipCode": "15345"
                        }
                    };
                    
                    console.log(JSON.stringify(grpoPayload,null,2));

                    // 3. Buat draft GRPO
                    const draftResult = await createGRPODraft(grpoPayload, sessionCookie);
                    
                    // 4. Buat GRPO dari draft
                    const grpoResult = await createGRPOFromDraft(draftResult, sessionCookie);
                    
                    // 5. Update status dan kirim notifikasi
                    const successNote = 'Berhasil memproses GRPO';
                    await updateRecordStatus(record.id, 3, successNote, null, grpoResult.DocEntry, pool);
                    await sendWhatsAppNotification(record.PO_NO, grpoResult.DocNum, grpoResult.DocEntry, successNote, true, pool);
                    
                    console.log(`GRPO berhasil dibuat untuk PO ${record.PO_NO}: DocNum ${grpoResult.DocNum}`);
                    
                }
            } catch (error) {
                const note = error.message.includes('already exists') 
                    ? 'Dokumen sudah ada di SAP' 
                    : error.message;
                
                const status = note.includes('already exists') ? 4 : 0;
                console.error(`Error processing record ${record.PO_NO}:`, error);
                
                await updateRecordStatus(record.id, status, note, null, null, pool);
                await sendWhatsAppNotification(record.PO_NO, null, null, `Gagal: ${note}`, false, pool);
            }
        }
    } catch (error) {
        console.error('Error dalam proses utama GRPO:', error);
    } finally {
        if (pool) await pool.close();
    }
}

// Inisialisasi dan penjadwalan
const initialize = async () => {
    try {
        // Jalankan proses GRPO pertama kali
        processGRPO().catch(error => {
            console.error('Error in initial GRPO process:', error);
        });
        
        // Jadwalkan proses GRPO berjalan setiap 20 detik
        setInterval(() => processGRPO(), 20000);
        
        // Start server
        app.listen(32100, () => {
            console.log('Server ready on port 32100');
        });
    } catch (error) {
        console.error('Startup failed:', error);
        process.exit(1);
    }
};

initialize();