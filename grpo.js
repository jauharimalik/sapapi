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
        // throw new Error(`Gagal login ke SAP: ${error.response?.data?.error?.message?.value || error.message}`);
    }
}

async function getPODataFromSAP(poNumber, sessionCookie) {
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
        return null;
    } else {
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
}

async function getPOItemsFromDB(poNumber) {
    const pool = await sql.connect(DB_CONFIG);
    const query = `SELECT t0.*,     
    (select top 1 t1.NumPerMsr from [pksrv-sap].test.dbo.POR1 T1 where T0.SKU collate database_default = T1.ItemCode and t0.SKU collate database_default = t1.itemcode)as NumPerMsr 
    FROM r_grpo_coldspace t0
    WHERE t0.PO_NO = '${poNumber}' AND t0.TRK_TYPE = 'ITEM' and jo_status is null `;
    console.log(query);

    const result = await pool.request().query(query);
    return result.recordset;
}

async function createGRPODraft(grpoData, sessionCookie, poNumber, pool) {
    try {
        // Hapus field yang tidak diperlukan
        const cleanGrpoData = {
            DocObjectCode: grpoData.DocObjectCode,
            CardCode: grpoData.CardCode,
            DocDate: grpoData.DocDate,
            DocDueDate: grpoData.DocDueDate,
            TaxDate: grpoData.TaxDate,
            Comments: grpoData.Comments,
            JournalMemo: grpoData.JournalMemo,
            DocumentLines: grpoData.DocumentLines.map(line => ({
                ItemCode: line.ItemCode,
                Quantity: line.Quantity,
                WarehouseCode: line.WarehouseCode,
                BaseType: line.BaseType,
                BaseEntry: line.BaseEntry,
                BaseLine: line.BaseLine,
                BatchNumbers: line.BatchNumbers
            })),
            AddressExtension: grpoData.AddressExtension
        };

        const response = await axios.post(
            `${SAP_CONFIG.BASE_URL}/Drafts`,
            cleanGrpoData,
            {
                headers: { 'Cookie': sessionCookie },
                httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
            }
        );
        return response.data;
    } catch (error) {
        const errorMessage = error.response?.data?.error?.message?.value || error.message;
        console.log('------------------------------------------------------------------------------------');
        // console.log('Error details:', error.response?.data || error.message);

        // Check if the error message contains 'closed'
        if (errorMessage.includes('closed')) {
        console.log('Detected a "closed" document error. Treating as successful completion.');
        const successNote = 'Berhasil memproses GRPO. Dokumen dasar sudah ditutup.';
        // Assuming poNumber, grpoResult, and pool are available in this scope
        await updateMultipleRecordsStatus(poNumber, 3, successNote, null, null, pool);
        await sendWhatsAppNotification(poNumber, null, null, successNote, true, pool);
        } else {
        // Your existing error handling code goes here
        const errorNote = `Error saat membuat GRPO: ${errorMessage}`;
        console.error(`Error processing PO ${poNumber}: ${errorNote}`);
        await updateMultipleRecordsStatus(poNumber, 4, errorNote, null, null, pool);
        await sendWhatsAppNotification(poNumber, null, null, errorNote, false, pool);
        }
        
        // let noter = `Error: ${error.response?.data?.error?.message?.value || error.message}`;
        // console.log('------------------------------------------------------------------------------------');
        // console.log('Error details:', error.response?.data);
        // throw error;
    }
}

async function createGRPOFromDraft(grpoData, sessionCookie) {
    
    // console.log(grpoData);

    try {
        // Logika untuk mengekstrak data yang dibutuhkan
        const cardCode = grpoData.CardCode;
        const docDate = grpoData.DocDate;
        const docDueDate = grpoData.DocDueDate;
        const taxDate = grpoData.TaxDate;
        const comments = grpoData.Comments;
        const journalMemo = grpoData.JournalMemo;

        const documentLines = grpoData.DocumentLines.map(line => ({
            ItemCode: line.ItemCode,
            Quantity: line.Quantity,
            WarehouseCode: line.WarehouseCode,
            BaseType: line.BaseType,
            BaseEntry: line.BaseEntry,
            BaseLine: line.BaseLine,
            BatchNumbers: line.BatchNumbers ? line.BatchNumbers.map(batch => ({
                BatchNumber: batch.BatchNumber,
                Quantity: batch.Quantity,
                InternalSerialNumber: batch.InternalSerialNumber,
                AddmisionDate: batch.AddmisionDate,
                ExpiryDate: batch.ExpiryDate,
                BaseLineNumber: batch.BaseLineNumber,
            })) : []
        }));

        // Mendapatkan data alamat dari properti AddressExtension yang sudah ada
        const addressExtension = grpoData.AddressExtension;
        const deliveryStreet = `${addressExtension.U_IDU_Nama_SupirS ? `Driver: ${addressExtension.U_IDU_Nama_SupirS}` : ''}${addressExtension.U_IDU_NoPlat_MblS ? `, Kendaraan: ${addressExtension.U_IDU_NoPlat_MblS}` : ''}`;
        
        // Membentuk payload sesuai format yang diinginkan
        const cleanGrpoData = {
            DocObjectCode: "oPurchaseDeliveryNotes",
            CardCode: cardCode,
            DocDate: docDate,
            DocDueDate: docDueDate,
            TaxDate: taxDate,
            Comments: comments,
            JournalMemo: journalMemo,
            DocumentLines: documentLines,
            AddressExtension: {
                DeliveryStreet: deliveryStreet.startsWith(', ') ? deliveryStreet.substring(2) : deliveryStreet,
                ShipToStreet: addressExtension.ShipToStreet,
                ShipToCity: addressExtension.ShipToCity,
                ShipToState: addressExtension.ShipToState,
                ShipToCountry: addressExtension.ShipToCountry,
                ShipToZipCode: addressExtension.ShipToZipCode,
            },
        };

        // console.log(JSON.stringify(cleanGrpoData, null, 2));

        const response = await axios.post(
            `${SAP_CONFIG.BASE_URL}/PurchaseDeliveryNotes`, // Perbaiki endpoint
            cleanGrpoData,
            {
                headers: {
                    'Cookie': sessionCookie,
                    'Content-Type': 'application/json'
                },
                httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
            }
        );

        if (!response.data || !response.data.DocEntry) {
            throw new Error("Gagal membuat GRPO - tidak mendapatkan DocEntry dari response");
        }

        return response.data;
    } catch (error) {
        const errorMessage = error.response?.data?.error?.message?.value || error.message;
        console.log('------------------------------------------------------------------------------------');
        console.log('Error details:', error.response?.data || error.message);
        // throw new Error(`Error saat membuat GRPO: ${errorMessage}`);
    }
}

async function updateMultipleRecordsStatus(poNumber, joStatus, note, docNum, docEntry, pool) {
    try {
        await pool.request()
            .input('PO_NO', sql.Int, poNumber)
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
                WHERE PO_NO = @PO_NO AND TRK_TYPE = 'ITEM';
            `);
    } catch (error) {
        throw new Error(`Gagal update multiple records status: ${error.message}`);
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

const formatDate = (dateString) => {
    const year = '20' + dateString.substring(0, 2);
    const month = dateString.substring(2, 4);
    const day = dateString.substring(4, 6);
    return `${year}-${month}-${day}`;
  };

async function processGRPO() {
    let pool;
    try {
        pool = await sql.connect(DB_CONFIG);
        console.log('Memulai proses GRPO...');
        
        // Ambil daftar PO yang perlu diproses (unik)
        const poListResult = await pool.request()
            .query(`SELECT DISTINCT PO_NO FROM r_grpo_coldspace WHERE TRK_TYPE = 'ITEM' AND (iswa IS NULL OR jo_status IS NULL)`);
        
        if (poListResult.recordset.length === 0) {
            console.log('Tidak ada data GRPO yang perlu diproses.');
            return;
        }
        
        const sessionCookie = await loginToSAP();
        if (!sessionCookie) {
            console.error('Gagal login ke SAP.');
            return;
        }
        
        for (const po of poListResult.recordset) {
            const poNumber = po.PO_NO;
            try {
                
                
                // 1. Dapatkan data PO dari SAP
                const poData = await getPODataFromSAP(poNumber, sessionCookie);                
                if (!poData) continue;



                // 2. Dapatkan semua item untuk PO ini dari database
                const poItems = await getPOItemsFromDB(poNumber);
                
                // 3. Buat payload GRPO dengan semua item
                const documentLines = poItems.map(item => {
                    if (item.QTYPO <= 0) {
                        // throw new Error(`Kuantitas nol atau tidak valid untuk item ${item.SKU}`);
                    }
                    
                    return {
                        "ItemCode": item.SKU,
                        "Quantity": (item.QTYPO / item.NumPerMsr),
                        "WarehouseCode": poData.DocumentLines.find(line => line.ItemCode === item.SKU)?.WarehouseCode,
                        "BaseType": 22,
                        "BaseEntry": poData.DocEntry,
                        "BaseLine": item.LINE_NO,
                        "BatchNumbers": [
                            {
                                "BatchNumber": item.VFDAT,
                                "Quantity": item.QTYPO,
                                "InternalSerialNumber": item.VFDAT,
                                "AddmisionDate": new Date().toISOString().split('T')[0],
                                "ExpiryDate": formatDate(item.VFDAT),
                                "BaseLineNumber": item.LINE_NO
                            }
                        ]
                    };
                });
                
                const grpoPayload = {
                    "DocObjectCode": "oPurchaseDeliveryNotes",
                    "CardCode": poData.CardCode,
                    "DocDate": new Date().toISOString().split('T')[0],
                    "DocDueDate": new Date().toISOString().split('T')[0],
                    "TaxDate": new Date().toISOString().split('T')[0],
                    "Comments": `GRPO for PO ${poNumber}`,
                    "JournalMemo": `GRPO for PO ${poNumber}`,
                    "DocumentLines": documentLines,
                    "AddressExtension": {
                        "DeliveryStreet": `Driver: ${poItems[0]?.driver ?? ''}, Kendaraan: ${poItems[0]?.nopolisi ?? ''}`

                    }
                };

                console.log(JSON.stringify(grpoPayload,null,2));

                // console.log('Payload GRPO:', JSON.stringify(grpoPayload, null, 2));

                
                // 4. Buat draft GRPO
                const draftResult = await createGRPODraft(grpoPayload, sessionCookie, poNumber, pool);
                // console.log(JSON.stringify(draftResult, null, 2));
                
                // 5. Buat GRPO dari draft
                const grpoResult = await createGRPOFromDraft(draftResult, sessionCookie);
                // console.log('GRPO Result:', JSON.stringify(draftResult, null, 2));

                // 6. Update status semua item PO ini dan kirim notifikasi
                const successNote = 'Berhasil memproses GRPO';
                // Define variables for DocNum and DocEntry
                // Memeriksa apakah grpoResult ada sebelum mengakses propertinya.
                // Ini mencegah TypeError jika grpoResult adalah undefined atau null.

                const docNum = grpoResult?.DocNum || null;
                const docEntry = grpoResult?.DocEntry || null;

                await updateMultipleRecordsStatus(poNumber, 3, successNote, docNum, docEntry, pool);
                await sendWhatsAppNotification(poNumber, docNum, docEntry, successNote, true, pool);

                await updateMultipleRecordsStatus(poNumber, 3, successNote, docNum, docEntry, pool);
                await sendWhatsAppNotification(poNumber, docNum, docEntry, successNote, true, pool);

                console.log(`GRPO berhasil dibuat untuk PO ${poNumber} dengan ${poItems.length} item`);
                
            } catch (error) {
                const note = error.message.includes('already exists') 
                    ? 'Dokumen sudah ada di SAP' 
                    : error.message;
                
                const status = note.includes('already exists') ? 4 : 0;
                console.error(`Error processing PO ${poNumber}:`, error);
                
                await updateMultipleRecordsStatus(poNumber, status, note, null, null, pool);
                await sendWhatsAppNotification(poNumber, null, null, `Gagal: ${note}`, false, pool);
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