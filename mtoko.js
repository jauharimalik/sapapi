const express = require('express');
const sql = require('mssql');
const fs = require('fs');
const path = require('path');
const Client = require('ssh2-sftp-client');
const axios = require('axios'); // Added for WhatsApp notifications
const FormData = require('form-data'); // Added for WhatsApp notifications

const app = express();
const PORT = 31013;

let isInsertRunning = false;
let isUpdateRunning = false;

let globalPool = null;
let connectionPromise = null; // To ensure only one connection attempt is in progress

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

const SFTP_CONFIG = {
    host: '43.218.157.171',
    port: 22,
    username: 'sftp_pandurasa',
    password: '6ULKZm62;/x{'
};

const WHATSAPP_CONFIG = {
    apiUrl: 'http://103.169.73.3:4040/send-group-message',
    successGroup: '120363420162985105@g.us', // Grup WhatsApp untuk notifikasi sukses
    failureGroup: '120363421138507049@g.us' // Grup WhatsApp untuk notifikasi gagal
};

const REMOTE_FOLDER = '/STG/INBOX/OUTLET'; // Changed for OUTLET
const LOCAL_FOLDER = 'D:/cs/';

// Full SQL query for customer data, derived from the sp_outlet_cs_inbox logic
const CUSTOMER_DATA_BASE_SQL = `
SELECT
        '1100' AS Company_Code,
        '1100' AS Carrier_Code,
        'SAP' AS Subgroup, 
        BP.CARDCODE AS Ship_Point_ID, 
        BP.CARDNAME AS Ship_Point_Description, 
        REPLACE(AD.Street, '"', '') AS [ADDRESS], 
        REPLACE(AD.City, '"', '') AS [ADDRESS2],
        REPLACE('', '"', '') AS [ADDRESS3], 
        ISNULL(AD.ZIPCODE, '0000') AS Postal_Code,
        '' AS Phone_Number,
        '' AS fax,
        '' AS Contact_Person,
        'FEFO' AS Method_pick,
        1 AS [Min_Exp_day], 
        '' AS Type_tax,
        ISNULL(AD.U_IDU_LONGITUDE, '0.0.0.0') AS Long, 
        ISNULL(AD.U_IDU_LATITUDE, '0.0.0.0') AS Lat, 
        '' AS Dist,
        AD.address AS Outlet_ID,

        CASE 
            WHEN M.Ship_Point_ID IS NULL THEN 0
            WHEN 
                M.[ADDRESS] = AD.Street COLLATE SQL_Latin1_General_CP850_CI_AS AND 
                ISNULL(M.Postal_Code, '') = ISNULL(AD.ZipCode, '') COLLATE SQL_Latin1_General_CP850_CI_AS AND 
                ISNULL(M.Lat, '') = ISNULL(AD.U_IDU_LATITUDE, '') COLLATE SQL_Latin1_General_CP850_CI_AS AND 
                ISNULL(M.Long, '') = ISNULL(AD.U_IDU_LONGITUDE, '') COLLATE SQL_Latin1_General_CP850_CI_AS
            THEN 2 
            ELSE 1 
        END AS is_update

    FROM [PKSRV-SAP].[PANDURASA_LIVE].[dbo].OCRD BP
    INNER JOIN [PKSRV-SAP].[PANDURASA_LIVE].[dbo].OCRG OG WITH (NOLOCK) 
        ON BP.GroupCode = OG.GroupCode AND BP.CardType = 'C'
    INNER JOIN [PKSRV-SAP].[PANDURASA_LIVE].[dbo].CRD1 AD WITH (NOLOCK) 
        ON BP.CardCode = AD.CardCode AND AD.AdresType = 'S'
    
    LEFT JOIN [dbo].[ms_customer_cs] M 
        ON M.Ship_Point_ID = BP.CARDCODE COLLATE SQL_Latin1_General_CP850_CI_AS
        AND M.Ship_Point_Description = BP.CARDNAME COLLATE SQL_Latin1_General_CP850_CI_AS
        AND M.[ADDRESS2] = AD.City COLLATE SQL_Latin1_General_CP850_CI_AS
    WHERE BP.CardType = 'C'
`;

async function ensureDatabaseConnection() {
    if (globalPool && globalPool.connected) {
        return globalPool;
    }

    if (connectionPromise) {
        console.log('------------------------------------------------------------------------------------');
        console.log('Koneksi sedang dalam proses, menunggu...');
        return await connectionPromise;
    }

    console.log('------------------------------------------------------------------------------------');
    console.log('Mencoba menghubungkan atau menyambung kembali ke database...');
    
    const thisPromise = (async () => {
        if (globalPool) {
            try {
                await globalPool.close();
                console.log('------------------------------------------------------------------------------------');
                console.log('Pool sebelumnya berhasil ditutup.');
            } catch (closeErr) {
                console.log('------------------------------------------------------------------------------------');
                console.error(`Gagal menutup pool sebelumnya: ${closeErr.message}`);
            }
        }

        try {
            globalPool = new sql.ConnectionPool(DB_CONFIG);
            globalPool.on('error', err => {
                console.log('------------------------------------------------------------------------------------');
                console.error(`Kesalahan pada globalPool: ${err.message}`);
                if (globalPool) {
                    globalPool.connected = false; 
                }
            });
            globalPool.on('end', () => {
                console.log('------------------------------------------------------------------------------------');
                console.log('Koneksi globalPool diakhiri.');
                if (globalPool) {
                    globalPool.connected = false;
                }
            });
            globalPool.on('close', () => {
                console.log('------------------------------------------------------------------------------------');
                console.log('Koneksi globalPool ditutup.');
                if (globalPool) {
                    globalPool.connected = false;
                }
            });
            
            await globalPool.connect();
            console.log('------------------------------------------------------------------------------------');
            console.log('Koneksi database berhasil dibuat/disambungkan kembali.');
            return globalPool;
        } catch (err) {
            console.log('------------------------------------------------------------------------------------');
            console.error(`Gagal menghubungkan ke database: ${err.message}`);
            console.log('------------------------------------------------------------------------------------');
            console.log('Mencoba kembali dalam 5 detik...');
            await new Promise(resolve => setTimeout(resolve, 5000));
            connectionPromise = null; 
            throw err; 
        }
    })();
    connectionPromise = thisPromise; 

    try {
        return await thisPromise;
    } catch (err) {
        connectionPromise = null; 
        throw err;
    }
}

async function executeSqlWithRetry(sqlQuery, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const pool = await ensureDatabaseConnection();
            const request = new sql.Request(pool);
            const result = await request.query(sqlQuery);
            return result;
        } catch (err) {
            console.log('------------------------------------------------------------------------------------');
            console.error(`Error executing SQL query (retry ${i + 1}/${retries}): ${err.message}`);
            if (err.message.includes('Connection lost') || err.message.includes('Unexpected close') || err.message.includes('Failed to connect')) {
                if (globalPool) {
                    globalPool.connected = false; 
                }
                connectionPromise = null; 
                console.log('------------------------------------------------------------------------------------');
                console.log('Mendeteksi masalah koneksi, akan mencoba menyambung kembali...');
            }
            if (i < retries - 1) {
                await new Promise(resolve => setTimeout(resolve, (i + 1) * 1000));
            } else {
                throw err;
            }
        }
    }
}

// Function to send WhatsApp notifications for upload status
const sendUploadNotification = async (fileType, fileName, status, errorMessage = null) => {
    const groupId = (status === 'SUCCESS') ? WHATSAPP_CONFIG.successGroup : WHATSAPP_CONFIG.failureGroup;
    
    const messageHeader = `*SFTP UPLOAD - CUSTOMER DATA - ${status}*`;
    let messageBody = `*File Type:* ${fileType}\n*File Name:* ${fileName}`;

    if (errorMessage) {
        messageBody += `\n\n*Error Details:*\n${errorMessage}`;
    }

    const message = `${messageHeader}\n\n${messageBody}`;

    const form = new FormData();
    form.append('id_group', groupId);
    form.append('message', message);

    try {
        const response = await axios.post(WHATSAPP_CONFIG.apiUrl, form, {
            headers: {
                ...form.getHeaders(),
                'Accept': 'application/json'
            },
            timeout: 10000 // Timeout for WhatsApp API call
        });

        console.log('------------------------------------------------------------------------------------');
        console.log('Notifikasi WhatsApp terkirim:', {
            fileType,
            fileName,
            status,
            messageId: response.data?.id || null
        });
        return { success: true, messageId: response.data?.id || null };
    } catch (error) {
        console.log('------------------------------------------------------------------------------------');
        console.error('Gagal mengirim notifikasi WhatsApp:', error.message);
        return { success: false, error: error.message };
    }
};

function getMillisecondsUntilNextDailyRun() {
    const now = new Date();
    const nextRun = new Date();
    nextRun.setHours(2, 0, 0, 0); // Set to 2:00:00 AM

    if (now.getTime() > nextRun.getTime()) {
        nextRun.setDate(nextRun.getDate() + 1);
    }

    return nextRun.getTime() - now.getTime();
}

async function generateAndUploadInsert() {
    if (isInsertRunning) return;
    isInsertRunning = true;

    const currentSftpClient = new Client(); 

    const date = new Date();
    const year = date.getFullYear();
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');

    const fileName = `CStrg_MCustRDA_Ins_${year}${month}${day}_${hours}${minutes}.txt`; 
    const localFilePath = path.join(LOCAL_FOLDER, fileName);
    const remoteFilePath = `${REMOTE_FOLDER}/${fileName}`;

    try {
        console.log('------------------------------------------------------------------------------------');
        console.log(`[${date.toISOString()}] Mulai proses upload INSERT (is_update = 0)...`);
        
        const getFilteredDataSQL = `
            SELECT *
            FROM (${CUSTOMER_DATA_BASE_SQL}) AS CustomerDataFiltered
            WHERE CustomerDataFiltered.is_update = 0;
        `;

        const result = await executeSqlWithRetry(getFilteredDataSQL);

        if (result.recordset.length === 0) {
            console.log('------------------------------------------------------------------------------------');
            console.log(`[${date.toISOString()}] Tidak ada data INSERT untuk di-upload.`);
            await sendUploadNotification('INSERT', fileName, 'SKIPPED', 'Tidak ada data untuk di-upload.');
            return; 
        }

        const rows = result.recordset.map(row => {
            return [
                row.Company_Code || '',
                row.Carrier_Code || '',
                row.Subgroup || '',
                row.Ship_Point_ID || '',
                (row.Ship_Point_Description || '').substring(0, 48), 
                (row.ADDRESS || '').substring(0, 50), // Added truncation for ADDRESS
                row.ADDRESS2 || '',
                row.ADDRESS3 || '',
                row.Postal_Code || '',
                row.Phone_Number || '',
                row.fax || '',
                row.Contact_Person || '',
                row.Method_pick || '',
                row.Min_Exp_day || '',
                row.Type_tax || '',
                row.Long || '',
                row.Lat || '',
                row.Dist || '',
                row.Outlet_ID || ''
            ].join('|');
        });

        const fileContent = rows.join('\n');

        if (!fs.existsSync(LOCAL_FOLDER)) {
            fs.mkdirSync(LOCAL_FOLDER, { recursive: true });
        }

        fs.writeFileSync(localFilePath, fileContent, 'utf8');
        console.log('------------------------------------------------------------------------------------');
        console.log(`File INSERT dibuat: ${localFilePath}`);

        await currentSftpClient.connect(SFTP_CONFIG); 
        await currentSftpClient.put(localFilePath, remoteFilePath);
        console.log('------------------------------------------------------------------------------------');
        console.log(`File INSERT di-upload ke SFTP: ${remoteFilePath}`);

        fs.unlinkSync(localFilePath);
        console.log('------------------------------------------------------------------------------------');
        console.log(`File lokal INSERT dihapus: ${localFilePath}`);

        await sendUploadNotification('INSERT', fileName, 'SUCCESS'); // Send success notification

    } catch (err) {
        console.log('------------------------------------------------------------------------------------');
        console.error(`Error pada proses INSERT: ${err.message}`);
        await sendUploadNotification('INSERT', fileName, 'FAILED', err.message); // Send failure notification
    } finally {
        if (currentSftpClient) {
            try {
                await currentSftpClient.end();
            } catch (sftpEndErr) {
                console.log('------------------------------------------------------------------------------------');
                console.error(`Error saat menutup SFTP client INSERT: ${sftpEndErr.message}`);
            }
        }
        isInsertRunning = false;
    }
}

async function generateAndUploadUpdate() {
    if (isUpdateRunning) return;
    isUpdateRunning = true;

    const currentSftpClient = new Client(); 
    const date = new Date();
    const year = date.getFullYear();
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');

    const fileName = `CStrg_MCustRDA_Upd_${year}${month}${day}_${hours}${minutes}.txt`; 
    const localFilePath = path.join(LOCAL_FOLDER, fileName);
    const remoteFilePath = `${REMOTE_FOLDER}/${fileName}`;

    try {
        console.log('------------------------------------------------------------------------------------');
        console.log(`[${date.toISOString()}] Mulai proses upload UPDATE (is_update = 1)...`);
        
        const getFilteredDataSQL = `
            SELECT *
            FROM (${CUSTOMER_DATA_BASE_SQL}) AS CustomerDataFiltered
            WHERE CustomerDataFiltered.is_update = 1;
        `;

        const result = await executeSqlWithRetry(getFilteredDataSQL);

        if (result.recordset.length === 0) {
            console.log('------------------------------------------------------------------------------------');
            console.log(`[${date.toISOString()}] Tidak ada data UPDATE untuk di-upload.`);
            await sendUploadNotification('UPDATE', fileName, 'SKIPPED', 'Tidak ada data untuk di-upload.');
            return; 
        }

        const rows = result.recordset.map(row => {
            return [
                row.Company_Code || '',
                row.Carrier_Code || '',
                row.Subgroup || '',
                row.Ship_Point_ID || '',
                (row.Ship_Point_Description || '').substring(0, 48), 
                (row.ADDRESS || '').substring(0, 50), // Added truncation for ADDRESS
                row.ADDRESS2 || '',
                row.ADDRESS3 || '',
                row.Postal_Code || '',
                row.Phone_Number || '',
                row.fax || '',
                row.Contact_Person || '',
                row.Method_pick || '',
                row.Min_Exp_day || '',
                row.Type_tax || '',
                row.Long || '',
                row.Lat || '',
                row.Dist || '',
                row.Outlet_ID || ''
            ].join('|');
        });

        const fileContent = rows.join('\n');

        if (!fs.existsSync(LOCAL_FOLDER)) {
            fs.mkdirSync(LOCAL_FOLDER, { recursive: true });
        }

        fs.writeFileSync(localFilePath, fileContent, 'utf8');
        console.log('------------------------------------------------------------------------------------');
        console.log(`File UPDATE dibuat: ${localFilePath}`);

        await currentSftpClient.connect(SFTP_CONFIG); 
        await currentSftpClient.put(localFilePath, remoteFilePath);
        console.log('------------------------------------------------------------------------------------');
        console.log(`File UPDATE di-upload ke SFTP: ${remoteFilePath}`);

        fs.unlinkSync(localFilePath);
        console.log('------------------------------------------------------------------------------------');
        console.log(`File lokal UPDATE dihapus: ${localFilePath}`);

        await sendUploadNotification('UPDATE', fileName, 'SUCCESS'); // Send success notification

    } catch (err) {
        console.log('------------------------------------------------------------------------------------');
        console.error(`Error pada proses UPDATE: ${err.message}`);
        await sendUploadNotification('UPDATE', fileName, 'FAILED', err.message); // Send failure notification
    } finally {
        if (currentSftpClient) {
            try {
                await currentSftpClient.end();
            } catch (sftpEndErr) {
                console.log('------------------------------------------------------------------------------------');
                console.error(`Error saat menutup SFTP client UPDATE: ${sftpEndErr.message}`);
            }
        }
        isUpdateRunning = false;
    }
}

async function dailyScheduler() {
    console.log('------------------------------------------------------------------------------------');
    console.log(`Menjalankan proses upload harian...`);
    
    try {
        await ensureDatabaseConnection(); 
    } catch (err) {
        console.error(`Gagal menghubungkan ke database untuk proses harian: ${err.message}. Proses upload dibatalkan.`);
        const delay = getMillisecondsUntilNextDailyRun();
        setTimeout(dailyScheduler, delay);
        return; 
    }

    try {
        await generateAndUploadInsert();
    } catch (err) {
        console.error(`Gagal menjalankan proses INSERT: ${err.message}`);
    }

    await new Promise(resolve => setTimeout(resolve, 1000)); 
    try {
        await generateAndUploadUpdate();
    } catch (err) {
        console.error(`Gagal menjalankan proses UPDATE: ${err.message}`);
    }

    console.log('------------------------------------------------------------------------------------');
    console.log(`Proses upload harian selesai. Menjadwalkan lari berikutnya.`);
    
    const delay = getMillisecondsUntilNextDailyRun();
    console.log(`Next run in ${Math.round(delay / (1000 * 60 * 60))} hours and ${Math.round((delay % (1000 * 60 * 60)) / (1000 * 60))} minutes.`);
    setTimeout(dailyScheduler, delay);
}


(async () => {
    await ensureDatabaseConnection();
    
    console.log('------------------------------------------------------------------------------------');
    console.log(`Menjalankan proses upload secara langsung saat startup...`);
    
    await Promise.allSettled([
        generateAndUploadInsert(),
        new Promise(resolve => setTimeout(() => generateAndUploadUpdate().then(resolve).catch(resolve), 500)) 
    ]);

    const delay = getMillisecondsUntilNextDailyRun();
    console.log('------------------------------------------------------------------------------------');
    console.log(`Penjadwalan upload harian berikutnya pada pukul 02:00 pagi.`);
    console.log(`Next daily run in ${Math.round(delay / (1000 * 60 * 60))} hours and ${Math.round((delay % (1000 * 60 * 60)) / (1000 * 60))} minutes.`);
    console.log('------------------------------------------------------------------------------------');
    setTimeout(dailyScheduler, delay);
})();

app.get('/', (req, res) => {
    res.send(`
        <h3>Auto SFTP Uploader Berjalan untuk Customer Data</h3>
        <p>Status INSERT (is_update = 0): ${isInsertRunning ? 'Sedang jalan' : 'Idle'}</p>
        <p>Status UPDATE (is_update = 1): ${isUpdateRunning ? 'Sedang jalan' : 'Idle'}</p>
        <p>Proses upload dijalankan saat startup dan dijadwalkan setiap hari pada pukul 02:00 pagi waktu lokal.</p>
    `);
});

app.listen(PORT, () => {
    console.log('------------------------------------------------------------------------------------');
    console.log(`Web monitor: http://localhost:${PORT}`);
    console.log('------------------------------------------------------------------------------------');
    console.log('Aplikasi SFTP Uploader Customer Telah Berjalan.');
    console.log('------------------------------------------------------------------------------------');
});
