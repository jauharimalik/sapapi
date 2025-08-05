const express = require('express');
const sql = require('mssql');
const fs = require('fs');
const path = require('path');
const Client = require('ssh2-sftp-client');
const axios = require('axios');
const FormData = require('form-data');

const app = express();
const PORT = 31440;

let isInsertRunning = false;
let isUpdateRunning = false;

let globalPool = null;
let connectionPromise = null;

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
    successGroup: '120363420162985105@g.us',
    failureGroup: '120363421138507049@g.us'
};

const REMOTE_FOLDER = '/STG/INBOX/PRODUCT';
const LOCAL_FOLDER = 'D:/cs/';
const OUTLET_FOLDER = 'D:/outlet/';

async function isSftpFolderEmpty(sftpClient, remoteFolder) {
    try {
        const fileList = await sftpClient.list(remoteFolder);
        return !fileList.some(file =>
            file.name.toLowerCase().endsWith('.csv') ||
            file.name.toLowerCase().endsWith('.txt')
        );
    } catch (err) {
        return false;
    }
}

async function waitUntilSftpFolderEmpty(sftpClient, remoteFolder, maxWait = 600000) {
    const interval = 120000;
    let waited = 0;
    while (waited < maxWait) {
        const isEmpty = await isSftpFolderEmpty(sftpClient, remoteFolder);
        if (isEmpty) return true;
        await new Promise(resolve => setTimeout(resolve, interval));
        waited += interval;
    }
    return false;
}

async function hasSftpFileWithPattern(sftpClient, remoteFolder, pattern) {
    try {
        const fileList = await sftpClient.list(remoteFolder);
        const regex = new RegExp(pattern, 'i');
        return fileList.some(file =>
            regex.test(file.name) &&
            (file.name.toLowerCase().endsWith('.csv') || file.name.toLowerCase().endsWith('.txt'))
        );
    } catch (err) {
        return false;
    }
}

const PRODUCT_DATA_BASE_SQL = `
    SELECT
        a.Customer_PLU_code,
        a.Long_Description,
        a.ORDER_UNIT,
        a.[C/F],
        a.stock_unit,
        a.Pack_Size,
        a.Ruang,
        a.Category,
        a.Storage_Live,
        a.BARCODE_ID,
        a.[Length],
        a.[Width],
        a.[Height],
        a.[Weight],
        a.[Status],
        a.[Customer],
        a.Movement_Type,
        a.Currency,
        a.Tracking,
        a.Critical_Days,
        a.[Location],
        a.Volume_Unit,
        a.Weight_UOM,
        a.Storage_Temp_From,
        a.Storage_Temp_To,
        a.Shelf_Life,
        a.Critical_Days1,
        a.Volume_UOM,
        CASE
            WHEN b.Customer_PLU_code IS NULL THEN 0
            WHEN
                a.ORDER_UNIT COLLATE SQL_Latin1_General_CP1_CI_AS = b.ORDER_UNIT AND
                a.stock_unit COLLATE SQL_Latin1_General_CP1_CI_AS = b.stock_unit AND
                a.[C/F] = b.[C/F] AND
                a.Ruang = b.Ruang AND
                a.BARCODE_ID COLLATE SQL_Latin1_General_CP1_CI_AS = b.BARCODE_ID AND
                a.[Length] = b.[Length] AND
                a.[Width] = b.[Width] AND
                a.[Height] = b.[Height] AND
                a.[Status] COLLATE SQL_Latin1_General_CP1_CI_AS = b.[Status] AND
                a.[Customer] COLLATE SQL_Latin1_General_CP1_CI_AS = b.[Customer] AND
                a.Movement_Type COLLATE SQL_Latin1_General_CP1_CI_AS = b.Movement_Type AND
                a.Currency COLLATE SQL_Latin1_General_CP1_CI_AS = b.Currency
            THEN 2
            ELSE 1
        END AS is_update
    FROM (
        SELECT
            O.ItemCode AS Customer_PLU_code,
            O.ItemName AS Long_Description,
            CASE
                WHEN O.SALUNITMSR = 'PIECES' THEN 'PC'
                WHEN O.SALUNITMSR = 'CARTON' THEN 'CAR'
                WHEN O.SALUNITMSR = 'GRAM' THEN 'GR'
                ELSE O.SALUNITMSR
            END AS ORDER_UNIT,
            CAST(O.NUMINBUY AS INT) AS [C/F],
            CASE
                WHEN O.SALUNITMSR = 'PIECES' THEN 'PC'
                WHEN O.SALUNITMSR = 'CARTON' THEN 'CAR'
                WHEN O.SALUNITMSR = 'GRAM' THEN 'GR'
                ELSE O.SALUNITMSR
            END AS stock_unit,
            1 AS Pack_Size,
            CASE
                WHEN O.u_idu_typeitem = 'AC TEMP' THEN 'AC ROOM'
                WHEN O.u_idu_typeitem = 'CHILL' THEN 'CHILLER'
                WHEN O.u_idu_typeitem = 'DRY' THEN 'NORMAL'
                WHEN O.u_idu_typeitem = 'FROZEN' THEN 'FROZEN'
                ELSE ''
            END AS Ruang,
            '' AS Category,
            '' AS Storage_Live,
            O.frgnname AS BARCODE_ID,
            CAST(O.blength1 AS INT) AS [Length],
            CAST(O.bwidth1 AS INT) AS [Width],
            CAST(O.bheight1 AS INT) AS [Height],
            CAST(O.bweight1 AS INT) AS [Weight],
            CASE
                WHEN O.frozenFor = 'N' THEN 'Active'
                ELSE 'NonActive'
            END AS [Status],
            'PK' AS [Customer],
            'NORMAL' AS Movement_Type,
            'IDR' AS Currency,
            '' AS Tracking,
            '' AS Critical_Days,
            '' AS [Location],
            '' AS Volume_Unit,
            'gram' AS Weight_UOM,
            '4' AS Storage_Temp_From,
            '2' AS Storage_Temp_To,
            '' AS Shelf_Life,
            '' AS Critical_Days1,
            '' AS Volume_UOM
        FROM [PKSRV-SAP].[PANDURASA_LIVE].[dbo].OITM AS O
        WHERE O.frgnname IS NOT NULL
    ) a
    LEFT JOIN ms_product_cs b ON a.Customer_PLU_code COLLATE SQL_Latin1_General_CP1_CI_AS = b.Customer_PLU_code
`;

async function ensureDatabaseConnection() {
    if (globalPool && globalPool.connected) {
        return globalPool;
    }

    if (connectionPromise) {
        return await connectionPromise;
    }

    const thisPromise = (async () => {
        if (globalPool) {
            try {
                await globalPool.close();
            } catch (closeErr) {}
        }

        try {
            globalPool = new sql.ConnectionPool(DB_CONFIG);
            globalPool.on('error', err => {
                if (globalPool) {
                    globalPool.connected = false;
                }
            });
            globalPool.on('end', () => {
                if (globalPool) {
                    globalPool.connected = false;
                }
            });
            globalPool.on('close', () => {
                if (globalPool) {
                    globalPool.connected = false;
                }
            });
            
            await globalPool.connect();
            return globalPool;
        } catch (err) {
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
            if (err.message.includes('Connection lost') || err.message.includes('Unexpected close') || err.message.includes('Failed to connect')) {
                if (globalPool) {
                    globalPool.connected = false;
                }
                connectionPromise = null;
            }
            if (i < retries - 1) {
                await new Promise(resolve => setTimeout(resolve, (i + 1) * 1000));
            } else {
                throw err;
            }
        }
    }
}

const sendUploadNotification = async (fileType, fileName, status, errorMessage = null) => {
    const groupId = (status === 'SUCCESS') ? WHATSAPP_CONFIG.successGroup : WHATSAPP_CONFIG.failureGroup;
    
    const messageHeader = `*SFTP UPLOAD - PRODUCT DATA - ${status}*`;
    let messageBody = `*File Type:* ${fileType}\n*File Name:* ${fileName}`;

    if (errorMessage) {
        messageBody += `\n\n*Error Details:*\n${errorMessage}`;
    }

    const message = `${messageHeader}\n\n${messageBody}`;

    const form = new FormData();
    form.append('id_group', groupId);
    form.append('message', message);

    try {
        await axios.post(WHATSAPP_CONFIG.apiUrl, form, {
            headers: {
                ...form.getHeaders(),
                'Accept': 'application/json'
            },
            timeout: 10000
        });
    } catch (error) {
        console.error('Gagal mengirim notifikasi WhatsApp:', error.message);
    }
};

function getMillisecondsUntilNextDailyRun() {
    const now = new Date();
    const nextRun = new Date();
    nextRun.setHours(2, 0, 0, 0);

    if (now.getTime() > nextRun.getTime()) {
        nextRun.setDate(nextRun.getDate() + 1);
    }

    return nextRun.getTime() - now.getTime();
}

async function checkOutletFiles() {
    try {
        if (!fs.existsSync(OUTLET_FOLDER)) {
            return false;
        }

        const files = fs.readdirSync(OUTLET_FOLDER);
        const hasCsvOrTxt = files.some(file => 
            file.toLowerCase().endsWith('.csv') || 
            file.toLowerCase().endsWith('.txt')
        );

        if (hasCsvOrTxt) {
            await new Promise(resolve => setTimeout(resolve, 120000));
            
            const filesAfterWait = fs.readdirSync(OUTLET_FOLDER);
            const stillHasFiles = filesAfterWait.some(file => 
                file.toLowerCase().endsWith('.csv') || 
                file.toLowerCase().endsWith('.txt')
            );

            if (stillHasFiles) {
                return true;
            }
        }
        return false;
    } catch (err) {
        return false;
    }
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

    const fileName = `CStrg_MProdRDA_Ins_${year}${month}${day}_${hours}${minutes}.txt`;
    const localFilePath = path.join(LOCAL_FOLDER, fileName);
    const remoteFilePath = `${REMOTE_FOLDER}/${fileName}`;

    try {

        await currentSftpClient.connect(SFTP_CONFIG);

        const hasInsFile = await hasSftpFileWithPattern(currentSftpClient, REMOTE_FOLDER, 'ins');
        if (hasInsFile) {
            await sendUploadNotification('INSERT', fileName, 'SKIPPED', 'Terdapat file bertipe INSERT (ins) di folder SFTP. Proses insert dibatalkan.');
            await currentSftpClient.end();
            return;
        }

        const sftpEmpty = await waitUntilSftpFolderEmpty(currentSftpClient, REMOTE_FOLDER);
        if (!sftpEmpty) {
            await sendUploadNotification('INSERT', fileName, 'DELAYED', 'Folder SFTP tujuan masih berisi file CSV/TXT. Upload ditunda.');
            await currentSftpClient.end();
            return;
        }

        const getFilteredDataSQL = `
            SELECT *
            FROM (${PRODUCT_DATA_BASE_SQL}) AS ProductDataFiltered
            WHERE ProductDataFiltered.is_update = 0;
        `;

        const result = await executeSqlWithRetry(getFilteredDataSQL);

        if (result.recordset.length === 0) {
            await sendUploadNotification('INSERT', fileName, 'SKIPPED', 'Tidak ada data untuk di-upload.');
            return;
        }

        const rows = result.recordset.map(row => {
            return [
                row.Customer_PLU_code || '',
                (row.Long_Description || '').substring(0, 48),
                row.ORDER_UNIT || '',
                row['C/F'] || '',
                row.stock_unit || '',
                row.Pack_Size || '',
                row.Ruang || '',
                row.Category || '',
                row.Storage_Live || '',
                row.BARCODE_ID || '',
                row.Length || '',
                row.Width || '',
                row.Height || '',
                row.Weight || '',
                row.Status || '',
                row.Customer || '',
                row.Movement_Type || '',
                row.Currency || '',
                row.Tracking || '',
                row.Critical_Days || '',
                row.Location || '',
                row.Volume_Unit || '',
                row.Weight_UOM || '',
                row.Storage_Temp_From || '',
                row.Storage_Temp_To || '',
                row.Shelf_Life || '',
                row.Critical_Days1 || '',
                row.Volume_UOM || ''
            ].join('|');
        });

        const fileContent = rows.join('\n');

        if (!fs.existsSync(LOCAL_FOLDER)) {
            fs.mkdirSync(LOCAL_FOLDER, { recursive: true });
        }

        fs.writeFileSync(localFilePath, fileContent, 'utf8');

        await currentSftpClient.put(localFilePath, remoteFilePath);
        console.log('------------------------------------------------------------------------------------');
        console.log(`File INSERT berhasil di-upload: ${remoteFilePath}`);

        fs.unlinkSync(localFilePath);

        await sendUploadNotification('INSERT', fileName, 'SUCCESS');

    } catch (err) {
        console.error(`Gagal upload INSERT: ${err.message}`);
        await sendUploadNotification('INSERT', fileName, 'FAILED', err.message);
    } finally {
        if (currentSftpClient) {
            try {
                await currentSftpClient.end();
            } catch (sftpEndErr) {}
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

    const fileName = `CStrg_MProdRDA_Upd_${year}${month}${day}_${hours}${minutes}.txt`;
    const localFilePath = path.join(LOCAL_FOLDER, fileName);
    const remoteFilePath = `${REMOTE_FOLDER}/${fileName}`;

    try {
        
        await currentSftpClient.connect(SFTP_CONFIG);

        const hasUpdFile = await hasSftpFileWithPattern(currentSftpClient, REMOTE_FOLDER, 'upd');
        if (hasUpdFile) {
            await sendUploadNotification('UPDATE', fileName, 'SKIPPED', 'Terdapat file bertipe UPDATE (upd) di folder SFTP. Proses update dibatalkan.');
            await currentSftpClient.end();
            return;
        }

        const sftpEmpty = await waitUntilSftpFolderEmpty(currentSftpClient, REMOTE_FOLDER);
        if (!sftpEmpty) {
            await sendUploadNotification('UPDATE', fileName, 'DELAYED', 'Folder SFTP tujuan masih berisi file CSV/TXT. Upload ditunda.');
            await currentSftpClient.end();
            return;
        }

        const getFilteredDataSQL = `
            SELECT *
            FROM (${PRODUCT_DATA_BASE_SQL}) AS ProductDataFiltered
            WHERE ProductDataFiltered.is_update = 1;
        `;

        const result = await executeSqlWithRetry(getFilteredDataSQL);

        if (result.recordset.length === 0) {
            await sendUploadNotification('UPDATE', fileName, 'SKIPPED', 'Tidak ada data untuk di-upload.');
            return;
        }

        const rows = result.recordset.map(row => {
            return [
                row.Customer_PLU_code || '',
                (row.Long_Description || '').substring(0, 48),
                row.ORDER_UNIT || '',
                row['C/F'] || '',
                row.stock_unit || '',
                row.Pack_Size || '',
                row.Ruang || '',
                row.Category || '',
                row.Storage_Live || '',
                row.BARCODE_ID || '',
                row.Length || '',
                row.Width || '',
                row.Height || '',
                row.Weight || '',
                row.Status || '',
                row.Customer || '',
                row.Movement_Type || '',
                row.Currency || '',
                row.Tracking || '',
                row.Critical_Days || '',
                row.Location || '',
                row.Volume_Unit || '',
                row.Weight_UOM || '',
                row.Storage_Temp_From || '',
                row.Storage_Temp_To || '',
                row.Shelf_Life || '',
                row.Critical_Days1 || '',
                row.Volume_UOM || ''
            ].join('|');
        });

        const fileContent = rows.join('\n');

        if (!fs.existsSync(LOCAL_FOLDER)) {
            fs.mkdirSync(LOCAL_FOLDER, { recursive: true });
        }

        fs.writeFileSync(localFilePath, fileContent, 'utf8');

        await currentSftpClient.put(localFilePath, remoteFilePath);
        console.log('------------------------------------------------------------------------------------');
        console.log(`File UPDATE berhasil di-upload: ${remoteFilePath}`);

        fs.unlinkSync(localFilePath);

        await sendUploadNotification('UPDATE', fileName, 'SUCCESS');

    } catch (err) {
        console.error(`Gagal upload UPDATE: ${err.message}`);
        await sendUploadNotification('UPDATE', fileName, 'FAILED', err.message);
    } finally {
        if (currentSftpClient) {
            try {
                await currentSftpClient.end();
            } catch (sftpEndErr) {}
        }
        isUpdateRunning = false;
    }
}

async function dailyScheduler() {
    try {
        await ensureDatabaseConnection();
    } catch (err) {
        const delay = getMillisecondsUntilNextDailyRun();
        setTimeout(dailyScheduler, delay);
        return;
    }

    try {
        await generateAndUploadInsert();
    } catch (err) {}

    await new Promise(resolve => setTimeout(resolve, 1000));
    try {
        await generateAndUploadUpdate();
    } catch (err) {}

    const delay = getMillisecondsUntilNextDailyRun();
    setTimeout(dailyScheduler, delay);
}

(async () => {
    await ensureDatabaseConnection();
    await Promise.allSettled([
        generateAndUploadInsert(),
        new Promise(resolve => setTimeout(() => generateAndUploadUpdate().then(resolve).catch(resolve), 500))
    ]);

    const delay = getMillisecondsUntilNextDailyRun();
    setTimeout(dailyScheduler, delay);
})();

app.get('/', (req, res) => {
    res.send(`
        <h3>Auto SFTP Uploader Berjalan untuk Product Data</h3>
        <p>Status INSERT: ${isInsertRunning ? 'Sedang jalan' : 'Idle'}</p>
        <p>Status UPDATE: ${isUpdateRunning ? 'Sedang jalan' : 'Idle'}</p>
        <p>Proses upload dijalankan setiap hari pada pukul 02:00 pagi waktu lokal.</p>
    `);
});

app.listen(PORT, () => {
    console.log(`Server berjalan pada port ${PORT}`);
});