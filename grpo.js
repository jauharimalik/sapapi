const express = require('express');
const axios = require('axios');
const sql = require('mssql');
const FormData = require('form-data');
const https = require('https');
const notificationService = require('./services/notificationService');
const app = express();
app.use(express.json());

// Konfigurasi
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

const WHATSAPP_CONFIG = {
    apiUrl: 'http://103.169.73.3:4040/send-group-message',
    successGroup: '120363420162985105@g.us',
    failureGroup: '120363421138507049@g.us'
};

// Logger utility
const logger = {
    info: (message, data = null) => {
        console.log(`[INFO] ${new Date().toISOString()}: ${message}`);
        if (data) console.log('Data:', JSON.stringify(data, null, 2));
    },
    
    error: (message, error = null) => {
        console.error(`[ERROR] ${new Date().toISOString()}: ${message}`);
        if (error) {
            console.error('Error details:', error.response?.data || error.message);
        }
    },
    
    warn: (message) => {
        console.warn(`[WARN] ${new Date().toISOString()}: ${message}`);
    },
    
    separator: () => {
        console.log('─'.repeat(80));
    },
    
    section: (title) => {
        logger.separator();
        console.log(`📋 ${title.toUpperCase()}`);
        logger.separator();
    },
    
    poProcessing: (poNumber, action) => {
        console.log(`📦 PO ${poNumber}: ${action}`);
    }
};


async function loginToSAP() {
    try {
        logger.info('Attempting SAP login...');
        const response = await axios.post(
            `${SAP_CONFIG.BASE_URL}/Login`,
            {
                CompanyDB: SAP_CONFIG.COMPANY_DB,
                UserName: SAP_CONFIG.CREDENTIALS.username,
                Password: SAP_CONFIG.CREDENTIALS.password
            },
            {
                httpsAgent: new https.Agent({ rejectUnauthorized: false })
            }
        );
        
        logger.info('SAP login successful');
        return response.headers['set-cookie'].join('; ');
    } catch (error) {
        const errorMessage = error.response?.data?.error?.message?.value || error.message;
        const note = `Gagal login ke SAP: ${errorMessage}`;
        
        logger.error('SAP login failed', error);
        await notificationService.sendTelegramNotification(note, false);
        throw new Error(note);
    }
}

async function getPODataFromSAP(poNumber, sessionCookie) {
    const pool = await sql.connect(DB_CONFIG);
    let query = `SELECT DocEntry FROM [pksrv-sap].pandurasa_live.dbo.OPOR WHERE DocNum = '${poNumber}'`;
    
    logger.info(`Querying SAP for PO: ${poNumber}`);
    const result = await pool.request().query(query);

    if (result.recordset.length === 0) {
        const note = `PO ${poNumber} Tidak Ditemukan di SAP`;
        
        logger.warn(note);
        logger.separator();
        
        await pool.request()
            .input('PO_NO', sql.Int, poNumber)
            .input('note', sql.NVarChar, note)
            .query(`
                UPDATE r_grpo_coldspace
                SET jo_status = 0, note = @note, iswa = 1
                WHERE PO_NO = @PO_NO;
            `);
        
        await sendWhatsAppNotification(poNumber, null, null, note, false, pool);
        await notificationService.sendTelegramNotification(note, false);
        return null;
    } else {
        const docEntry = result.recordset[0].DocEntry;
        logger.info(`Found PO ${poNumber} with DocEntry: ${docEntry}`);
        
        const response = await axios.get(
            `${SAP_CONFIG.BASE_URL}/PurchaseOrders(${docEntry})`,
            {
                headers: { 'Cookie': sessionCookie },
                httpsAgent: new https.Agent({ rejectUnauthorized: false })
            }
        );
        
        logger.info(`Successfully retrieved PO data for ${poNumber}`);
        return response.data;
    }
}

// Fungsi untuk update status per ID, bukan per PO
async function updateRecordStatusById(id, joStatus, note, docNum, docEntry, pool) {
    try {
        logger.info(`Updating status for ID ${id} to ${joStatus}`);
        
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
            
        logger.info(`Status updated successfully for ID ${id}`);
    } catch (error) {
        const updateNote = `Gagal update record status: ${error.message}`;
        logger.error(updateNote, error);
        await notificationService.sendTelegramNotification(updateNote, false);
        throw new Error(updateNote);
    }
}

async function getDistinctPOItems() {
    const pool = await sql.connect(DB_CONFIG);
    
    const query = `
        SELECT DISTINCT 
            t0.PO_NO, t0.LINE_NO, t0.SKU,
            (SELECT TOP 1 id FROM r_grpo_coldspace t1 
             WHERE t1.PO_NO = t0.PO_NO 
             AND t1.SKU = t0.SKU 
             AND t0.LINE_NO = t1.LINE_NO 
             AND (t1.jo_status IS NULL OR t1.iswa IS NULL)) as id
        FROM r_grpo_coldspace t0 
        WHERE t0.TRK_TYPE = 'ITEM' 
        AND (t0.jo_status IS NULL OR t0.iswa IS NULL)
        ORDER BY t0.PO_NO, t0.LINE_NO
    `;
    
    logger.info('Querying distinct PO items for processing');
    const result = await pool.request().query(query);
    
    logger.info(`Found ${result.recordset.length} distinct PO items to process`);
    return result.recordset;
}

async function getPOItemsByID(id) {
    const pool = await sql.connect(DB_CONFIG);
    
    const query = `
        SELECT * FROM r_grpo_coldspace 
        WHERE id = @id AND TRK_TYPE = 'ITEM'
        ORDER BY Whscode, VFDAT
    `;
    
    const result = await pool.request()
        .input('id', sql.Int, id)
        .query(query);
    
    return result.recordset;
}

function groupItemsByPO(items) {
    const grouped = {};
    
    items.forEach(item => {
        if (!grouped[item.PO_NO]) {
            grouped[item.PO_NO] = [];
        }
        grouped[item.PO_NO].push(item);
    });
    
    return grouped;
}

// Tambahkan fungsi untuk mendapatkan conversion factor dari database
async function getConversionFactor(itemCode, pool) {
    try {
        const query = `
            SELECT top 1 conversion_to 
            FROM view_converter_item 
            WHERE ItemCode = @itemCode
        `;
        
        const result = await pool.request()
            .input('itemCode', sql.NVarChar, itemCode)
            .query(query);
        
        if (result.recordset.length > 0) {
            return result.recordset[0].conversion_to || 1;
        }
        
        logger.warn(`Conversion factor not found for item ${itemCode}, using default 1`);
        return 1;
    } catch (error) {
        logger.error(`Error getting conversion factor for item ${itemCode}`, error);
        return 1;
    }
}

async function createGRPODraft(grpoData, sessionCookie, poNumber, pool) {
    try {
        logger.poProcessing(poNumber, 'Creating GRPO draft...');
        
        // Bersihkan data dari field-field yang tidak perlu
        const cleanGrpoData = {
            DocObjectCode: "oPurchaseDeliveryNotes",
            CardCode: grpoData.CardCode,
            DocDate: grpoData.DocDate,
            DocDueDate: grpoData.DocDueDate,
            TaxDate: grpoData.TaxDate,
            Comments: grpoData.Comments,
            JournalMemo: grpoData.JournalMemo,
            DocumentLines: grpoData.DocumentLines.map((line) => {
                const documentLine = {
                    ItemCode: line.ItemCode,
                    Quantity: line.Quantity,
                    WarehouseCode: line.WarehouseCode,
                    BaseType: line.BaseType,
                    BaseEntry: line.BaseEntry,
                    BaseLine: line.BaseLine,
                    BatchNumbers: []
                };

                // Tambahkan batch numbers jika ada
                if (line.BatchNumbers && line.BatchNumbers.length > 0) {
                    documentLine.BatchNumbers = line.BatchNumbers.map(batch => ({
                        BatchNumber: batch.BatchNumber || "",
                        Quantity: batch.Quantity,
                        InternalSerialNumber: batch.InternalSerialNumber || batch.BatchNumber || "",
                        AddmisionDate: batch.AddmisionDate || new Date().toISOString().split('T')[0],
                        ExpiryDate: batch.ExpiryDate || "",
                        BaseLineNumber: line.BaseLine
                    }));
                }

                return documentLine;
            }),
            AddressExtension: {
                DeliveryStreet: grpoData.AddressExtension?.DeliveryStreet || "Partial GRPO Delivery"
            }
        };

        const response = await axios.post(
            `${SAP_CONFIG.BASE_URL}/Drafts`,
            cleanGrpoData,
            {
                headers: {
                    'Cookie': sessionCookie,
                    'Content-Type': 'application/json'
                },
                httpsAgent: new https.Agent({ rejectUnauthorized: false }),
                timeout: 30000
            }
        );
        
        if (!response.data || !response.data.DocEntry) {
            throw new Error("Gagal membuat draft GRPO - tidak mendapatkan DocEntry dari response");
        }
        
        logger.poProcessing(poNumber, `GRPO draft created successfully - Draft DocEntry: ${response.data.DocEntry}`);
        return response.data;
    } catch (error) {
        const errorMessage = error.response?.data?.error?.message?.value || error.message;
        
        logger.error(`Error creating draft for PO ${poNumber}`, error);
        logger.error('Error details:', error.response?.data);

        if (errorMessage.includes('closed')) {
            const successNote = 'Berhasil memproses GRPO. Dokumen dasar sudah ditutup.';
            logger.poProcessing(poNumber, successNote);
            
            await updateMultipleRecordsStatus(poNumber, 3, successNote, null, null, pool);
            await sendWhatsAppNotification(poNumber, null, null, successNote, true, pool);
            await notificationService.sendTelegramNotification(successNote, true);
        } else if (errorMessage.includes('batch/serial numbers')) {
            // Coba approach alternatif tanpa batch numbers terlebih dahulu
            const alternativeNote = 'Mencoba membuat GRPO tanpa batch numbers terlebih dahulu';
            logger.poProcessing(poNumber, alternativeNote);
            
            try {
                // Buat payload tanpa batch numbers
                const alternativeData = {
                    ...grpoData,
                    DocumentLines: grpoData.DocumentLines.map(line => ({
                        ...line,
                        BatchNumbers: undefined // Hapus batch numbers
                    }))
                };
                
                const draftResponse = await axios.post(
                    `${SAP_CONFIG.BASE_URL}/Drafts`,
                    alternativeData,
                    {
                        headers: {
                            'Cookie': sessionCookie,
                            'Content-Type': 'application/json'
                        },
                        httpsAgent: new https.Agent({ rejectUnauthorized: false })
                    }
                );
                
                logger.poProcessing(poNumber, `Draft created without batch numbers: ${draftResponse.data.DocEntry}`);
                return draftResponse.data;
                
            } catch (altError) {
                const errorNote = `Error batch numbers: ${errorMessage}`;
                logger.poProcessing(poNumber, errorNote);
                
                await updateMultipleRecordsStatus(poNumber, 4, errorNote, null, null, pool);
                await sendWhatsAppNotification(poNumber, null, null, errorNote, false, pool);
                await notificationService.sendTelegramNotification(errorNote, false);
                throw altError;
            }
        } else {
            const errorNote = `Error saat membuat GRPO draft: ${errorMessage}`;
            logger.poProcessing(poNumber, errorNote);
            
            await updateMultipleRecordsStatus(poNumber, 4, errorNote, null, null, pool);
            await sendWhatsAppNotification(poNumber, null, null, errorNote, false, pool);
            await notificationService.sendTelegramNotification(errorNote, false);
        }
        throw error;
    }
}

async function createGRPOFromDraft(draftData, sessionCookie, poNumber) {
    try {
        logger.poProcessing(poNumber, 'Creating final GRPO from draft...');
        
        // Bersihkan data draft sebelum membuat GRPO final
        const cleanDraftData = {
            DocObjectCode: draftData.DocObjectCode,
            CardCode: draftData.CardCode,
            DocDate: draftData.DocDate,
            DocDueDate: draftData.DocDueDate,
            TaxDate: draftData.TaxDate,
            Comments: draftData.Comments,
            JournalMemo: draftData.JournalMemo,
            DocumentLines: draftData.DocumentLines.map(line => ({
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
            })),
            AddressExtension: {
                DeliveryStreet: draftData.AddressExtension?.DeliveryStreet || "Partial GRPO Delivery"
            }
        };

        const response = await axios.post(
            `${SAP_CONFIG.BASE_URL}/PurchaseDeliveryNotes`,
            cleanDraftData,
            {
                headers: {
                    'Cookie': sessionCookie,
                    'Content-Type': 'application/json'
                },
                httpsAgent: new https.Agent({ rejectUnauthorized: false })
            }
        );

        if (!response.data || !response.data.DocEntry) {
            throw new Error("Gagal membuat GRPO - tidak mendapatkan DocEntry dari response");
        }

        logger.poProcessing(poNumber, `GRPO created successfully - DocEntry: ${response.data.DocEntry}, DocNum: ${response.data.DocNum}`);
        return response.data;
    } catch (error) {
        const errorMessage = error.response?.data?.error?.message?.value || error.message;
        logger.error(`Error creating final GRPO for PO ${poNumber}`, error);
        throw new Error(`Error saat membuat GRPO: ${errorMessage}`);
    }
}

async function updateMultipleRecordsStatus(poNumber, joStatus, note, docNum, docEntry, pool) {
    try {
        logger.info(`Updating status for PO ${poNumber} to ${joStatus}`);
        
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
            
        logger.info(`Status updated successfully for PO ${poNumber}`);
    } catch (error) {
        const updateNote = `Gagal update multiple records status: ${error.message}`;
        logger.error(updateNote, error);
        await notificationService.sendTelegramNotification(updateNote, false);
        throw new Error(updateNote);
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
        logger.info(`Sending WhatsApp notification for PO ${poNo} - Status: ${statusText}`);
        await axios.post(WHATSAPP_CONFIG.apiUrl, form, {
            headers: form.getHeaders(),
            timeout: 10000
        });
        
        logger.info(`WhatsApp notification sent successfully for PO ${poNo}`);
        return { success: true };
    } catch (error) {
        logger.error(`Failed to send WhatsApp notification for PO ${poNo}`, error);
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

const formatDate = (daPANDURASA_LIVEring) => {
    if (!daPANDURASA_LIVEring) return new Date().toISOString().split('T')[0];
    
    try {
        const year = '20' + daPANDURASA_LIVEring.substring(0, 2);
        const month = daPANDURASA_LIVEring.substring(2, 4);
        const day = daPANDURASA_LIVEring.substring(4, 6);
        return `${year}-${month}-${day}`;
    } catch (error) {
        return new Date().toISOString().split('T')[0];
    }
};

async function processGRPO() {
    let pool;
    try {
        pool = await sql.connect(DB_CONFIG);
        logger.section('Starting GRPO Processing - Partial Mode');
        
        // Ambil data distinct berdasarkan PO_NO dan LINE_NO
        const distinctItems = await getDistinctPOItems();
        
        if (distinctItems.length === 0) {
            logger.info('No GRPO data needs processing');
            return;
        }
        
        // Kelompokkan items berdasarkan PO
        const poGroups = groupItemsByPO(distinctItems);
        logger.info(`Found ${Object.keys(poGroups).length} PO(s) to process`);
        
        const sessionCookie = await loginToSAP();
        if (!sessionCookie) {
            logger.error('Failed to login to SAP - aborting process');
            return;
        }
        
        // Proses setiap PO
        for (const [poNumber, poItems] of Object.entries(poGroups)) {
            logger.section(`Processing PO ${poNumber} with ${poItems.length} items`);
            
            try {
                const poData = await getPODataFromSAP(poNumber, sessionCookie);
                if (!poData) continue;

                logger.info(`Processing ${poItems.length} distinct items for PO ${poNumber}`);
                
                // Siapkan document lines untuk GRPO parsial
                const documentLines = [];
                
                // Proses setiap distinct item
                for (const distinctItem of poItems) {
                    const itemDetails = await getPOItemsByID(distinctItem.id);
                    
                    if (itemDetails.length === 0) {
                        logger.warn(`No details found for ID ${distinctItem.id}`);
                        continue;
                    }
                    
                    const sapPoLine = poData.DocumentLines.find(line => 
                        line.ItemCode === distinctItem.SKU && line.LineNum === distinctItem.LINE_NO
                    );
                    
                    if (!sapPoLine) {
                        logger.warn(`SKU ${distinctItem.SKU} atau Line No ${distinctItem.LINE_NO} tidak ditemukan di PO SAP.`);
                        continue;
                    }
                    
                    // Kelompokkan details berdasarkan Whscode
                    const itemsByWhscode = {};
                    
                    for (const detail of itemDetails) {
                        if (!itemsByWhscode[detail.Whscode]) {
                            itemsByWhscode[detail.Whscode] = {
                                batches: [],
                                totalQty: 0
                            };
                        }
                        
                        itemsByWhscode[detail.Whscode].batches.push({
                            VFDAT: detail.VFDAT,
                            QTYGR: detail.QTYGR
                        });
                        
                        itemsByWhscode[detail.Whscode].totalQty += detail.QTYGR;
                    }
                    
                    // Konversi quantity ke unit SAP
                    // const conversionFactor = sapPoLine.NumPerMsr || 1;
                    
                    
                    // Buat document line untuk setiap Whscode
                    for (const [whscode, whsData] of Object.entries(itemsByWhscode)) {
                        let conversionFactor = await getConversionFactor(distinctItem.SKU, pool);
                        console.log(`Conversion factor for ${distinctItem.SKU}: ${conversionFactor}`);

                        // Hitung total quantity yang sudah dikonversi ke unit SAP
                        let totalSapQuantity = 0;
                        
                        const batchNumbers = whsData.batches.map(batch => {
                            
                            const sapQuantity = batch.QTYGR / conversionFactor;
                            totalSapQuantity += sapQuantity;

                            return {
                                "BatchNumber": batch.VFDAT || "",
                                "Quantity": batch.QTYGR, // Quantity batch sudah dikonversi
                                "InternalSerialNumber": batch.VFDAT || "",
                                "AddmisionDate": new Date().toISOString().split('T')[0],
                                "ExpiryDate": formatDate(batch.VFDAT),
                                "BaseLineNumber": parseInt(distinctItem.LINE_NO)
                            };
                        });

                        console.log(`Total SAP Quantity for whscode ${whscode}: ${totalSapQuantity}`);
                        
                        documentLines.push({
                            "ItemCode": distinctItem.SKU,
                            "Quantity": totalSapQuantity, // Gunakan total quantity yang sudah dikonversi
                            "WarehouseCode": whscode,
                            "BaseType": 22,
                            "BaseEntry": poData.DocEntry,
                            "BaseLine": parseInt(distinctItem.LINE_NO),
                            "BatchNumbers": batchNumbers
                        });
                    }

                }

                if (documentLines.length === 0) {
                    logger.warn(`Semua item untuk PO ${poNumber} tidak valid. Melewati.`);
                    continue;
                }
                
                // Pastikan BaseLine adalah integer
                documentLines.forEach(line => {
                    line.BaseLine = parseInt(line.BaseLine);
                    if (line.BatchNumbers && line.BatchNumbers.length > 0) {
                        line.BatchNumbers.forEach(batch => {
                            batch.BaseLineNumber = parseInt(batch.BaseLineNumber);
                        });
                    }
                });

                // Buat payload GRPO
                const grpoPayload = {
                    "DocObjectCode": "oPurchaseDeliveryNotes",
                    "CardCode": poData.CardCode,
                    "DocDate": new Date().toISOString().split('T')[0],
                    "DocDueDate": new Date().toISOString().split('T')[0],
                    "TaxDate": new Date().toISOString().split('T')[0],
                    "Comments": `Partial GRPO for PO ${poNumber}`,
                    "JournalMemo": `Partial GRPO for PO ${poNumber}`,
                    "DocumentLines": documentLines,
                    "AddressExtension": {
                        "DeliveryStreet": `Driver: ${poItems[0]?.driver || ''}, Kendaraan: ${poItems[0]?.nopolisi || ''}`
                    }
                };

                logger.info(`Creating partial GRPO for PO ${poNumber} with ${documentLines.length} consolidated items`);
                console.log(JSON.stringify(grpoPayload,null,2));
                const draftResult = await createGRPODraft(grpoPayload, sessionCookie, poNumber, pool);
                console.log(JSON.stringify(grpoPayload,null,2));
                const grpoResult = await createGRPOFromDraft(draftResult, sessionCookie, poNumber);
                
                // const successNote = 'Berhasil memproses GRPO Parsial';
                // const docNum = grpoResult?.DocNum || null;
                // const docEntry = grpoResult?.DocEntry || null;           
                // Dalam proses GRPO, modifikasi bagian update status:

                const successNote = `Berhasil memproses GRPO Parsial. DocNum: ${docNum}, DocEntry: ${docEntry}, PONumber: ${poNumber}`;

                const docNum = grpoResult?.DocNum || null;
                const docEntry = grpoResult?.DocEntry || null;

                // Update semua records untuk setiap ID yang diproses
                for (const distinctItem of poItems) {
                    const itemDetails = await getPOItemsByID(distinctItem.id);
                    for (const detail of itemDetails) {
                        await updateRecordStatusById(detail.id, 3, successNote, docNum, docEntry, pool);
                    }
                }

                await sendWhatsAppNotification(poNumber, docNum, docEntry, successNote, true, pool);
                await notificationService.sendTelegramNotification(successNote, true);


                // // Update semua records untuk PO ini
                // await updateMultipleRecordsStatus(poNumber, 3, successNote, docNum, docEntry, pool);
                // await sendWhatsAppNotification(poNumber, docNum, docEntry, successNote, true, pool);
                // await notificationService.sendTelegramNotification(successNote, true);

                logger.poProcessing(poNumber, `Successfully processed partial GRPO with ${documentLines.length} consolidated lines`);
                
            } catch (error) {
                const note = error.message.includes('already exists') 
                    ? 'Dokumen sudah ada di SAP' 
                    : error.message;
                
                const status = note.includes('already exists') ? 4 : 0;
                logger.error(`Error processing PO ${poNumber}`, error);
                
                await updateMultipleRecordsStatus(poNumber, status, note, null, null, pool);
                await sendWhatsAppNotification(poNumber, null, null, `Gagal: ${note}`, false, pool);
                await notificationService.sendTelegramNotification(`Gagal: ${note}`, false);
            } finally {
                logger.separator();
            }
        }
        
        logger.section('GRPO Partial Processing Completed');
    } catch (error) {
        logger.error('Error in main GRPO process', error);
        await notificationService.sendTelegramNotification(`Error utama GRPO: ${error.message}`, false);
    } finally {
        if (pool) await pool.close();
        logger.info('Database connection closed');
    }
}

// Endpoint untuk debugging
app.get('/api/debug/partial-po/:poNumber', async (req, res) => {
    try {
        const { poNumber } = req.params;
        const pool = await sql.connect(DB_CONFIG);
        
        // Data dari database
        const dbQuery = `
            SELECT DISTINCT 
                t0.PO_NO, t0.LINE_NO, t0.sku,
                (SELECT TOP 1 id FROM r_grpo_coldspace t1 
                 WHERE t1.PO_NO = t0.PO_NO 
                 AND t1.SKU = t0.SKU 
                 AND t0.LINE_NO = t1.LINE_NO 
                 AND (t1.jo_status IS NULL OR t1.iswa IS NULL)) as id
            FROM r_grpo_coldspace t0 
            WHERE t0.TRK_TYPE = 'ITEM' 
            AND t0.PO_NO = '${poNumber}'
            ORDER BY t0.LINE_NO
        `;
        
        const dbResult = await pool.request().query(dbQuery);
        
        // Data dari SAP
        let sapData = null;
        try {
            const sessionCookie = await loginToSAP();
            sapData = await getPODataFromSAP(poNumber, sessionCookie);
        } catch (sapError) {
            logger.error('Error getting SAP data for debug', sapError);
        }
        
        res.json({
            success: true,
            poNumber,
            distinctItems: dbResult.recordset,
            sapData: sapData ? {
                docEntry: sapData.DocEntry,
                cardCode: sapData.CardCode,
                documentLines: sapData.DocumentLines.map(line => ({
                    lineNum: line.LineNum,
                    itemCode: line.ItemCode,
                    quantity: line.Quantity,
                    warehouseCode: line.WarehouseCode,
                    numPerMsr: line.NumPerMsr
                }))
            } : null
        });
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        service: 'GRPO Processor'
    });
});

// Inisialisasi dan penjadwalan
const initialize = async () => {
    try {
        logger.section('Application Startup');
        
        // PANDURASA_LIVE database connection
        const pool = await sql.connect(DB_CONFIG);
        await pool.close();
        logger.info('Database connection PANDURASA_LIVE successful');
        
        // Jalankan proses pertama kali
        await processGRPO();
        
        // Jadwalkan proses setiap 20 detik
        setInterval(processGRPO, 20000);
        logger.info('GRPO processor scheduled to run every 20 seconds');
        
        app.listen(32100, () => {
            logger.info('Server ready on port 32100');
            logger.info('Debug endpoint available at: /api/debug/partial-po/:poNumber');
            logger.info('Health check available at: /health');
        });
    } catch (error) {
        logger.error('Startup failed', error);
        await notificationService.sendTelegramNotification(`Startup GRPO failed: ${error.message}`, false);
        process.exit(1);
    }
};

// Handle graceful shutdown
process.on('SIGINT', async () => {
    logger.info('Shutting down gracefully...');
    await sql.close();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    logger.info('Received SIGTERM, shutting down...');
    await sql.close();
    process.exit(0);
});

initialize();