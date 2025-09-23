const app = require('./app');
const axios = require('axios');
const sql = require('mssql');
const FormData = require('form-data');
const notificationService = require('./services/notificationService');

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

let lastDelayedRun = 0;
const DELAY_INTERVAL = 15 * 60 * 1000;
const NOTIFICATION_INTERVAL = 30 * 60 * 1000;

const resetFailedDnStatus = async (pool) => {
    try {
        await pool.request()
            .query(`update r_dn_coldspace set jo_status = null, note = null,doc_entry = null, doc_num = null where note like '%undefined%' or note like '%timeout%'`);
        console.log('Resetting failed DN statuses complete.');
    } catch (error) {
        console.error('Error resetting failed DN statuses:', error.message);
    }
};

const resetMismatchDnStatus = async (pool) => {
    try {
        await pool.request()
            .query(`update r_dn_coldspace set jo_status = null, note = null,doc_entry = null, doc_num = null, iswa = null, ismatch = 0, noterev = note where note like '%mismatch%'`);
        console.log('Resetting "mismatch" DN statuses complete.');
    } catch (error) {
        console.error('Error resetting "mismatch" DN statuses:', error.message);
    }
};

const sendProblematicDnNotifications = async () => {
    let pool;
    try {
        pool = await sql.connect(DB_CONFIG);
        const query = `
            select distinct t0.DO_NO,
            (
                select top 1 cardname from [pksrv-sap].pandurasa_live.dbo.ocrd where cardcode collate database_default = t0.whscode
            ) as customer,
            ( select top 1 note from r_dn_coldspace tx where tx.DO_NO =t0.do_no ) as note
            from r_dn_coldspace t0 where t0.ismatch = 1 and (t0.jo_status != 3 or t0.jo_status is null) and (t0.ORDER_TYPE = 'item' or t0.ORDER_TYPE = 'bund')
            and t0.note is not null
        `;

        const result = await pool.request().query(query);

        if (result.recordset.length > 0) {
            console.log('------------------------------------------------------------------------------------');
            console.log('Sending notifications for problematic DNs...');
            for (const record of result.recordset) {
                const message = `Pemberitahuan: DN bermasalah ditemukan\n\nDO No: ${record.DO_NO}\nCustomer: ${record.customer}\nNote: ${record.note}`;
                // await notificationService.sendWhatsApp(null, null, null, message, false, pool);
                // await notificationService.sendTelegramNotification(message, false);
            }
        } else {
            console.log('------------------------------------------------------------------------------------');
            console.log('Tidak ada data DN bermasalah yang perlu dinotifikasi.');
        }

    } catch (error) {
        console.error('Error sending problematic DN notifications:', error.message);
    } finally {
        if (pool) await pool.close();
    }
};

const processRepushDnColdspace = async () => {
    let pool;
    try {
        pool = await sql.connect(DB_CONFIG);

        const now = Date.now();
        const isDelayedRunTime = (now - lastDelayedRun) >= DELAY_INTERVAL;

        let query;
        if (isDelayedRunTime) {
            query = `SELECT DISTINCT do_no 
                      FROM [appsrv].db_pandurasa.dbo.r_dn_coldspace 
                      WHERE ismatch = 0 
                      AND (jo_status != 3 OR jo_status IS NULL) 
                      AND (ORDER_TYPE = 'item' OR ORDER_TYPE = 'bund')`;
            lastDelayedRun = now;
            console.log('------------------------------------------------------------------------------------');
            console.log('Running delayed process for all failed DNs (every 15 minutes).');
        } else {
            query = `SELECT DISTINCT do_no 
                      FROM [appsrv].db_pandurasa.dbo.r_dn_coldspace 
                      WHERE ismatch = 0 
                      AND (jo_status != 3 OR jo_status IS NULL) 
                      AND (ORDER_TYPE = 'item' OR ORDER_TYPE = 'bund')
                      AND noterev IS NULL`;
            console.log('------------------------------------------------------------------------------------');
            console.log('Running immediate process for new DNs.');
        }

        const result = await pool.request().query(query);

        if (result.recordset.length === 0) {
            console.log('------------------------------------------------------------------------------------');
            console.log('Tidak ada data DN Coldspace yang perlu diproses.');
            return;
        }

        const sessionCookie = await loginToSAP();
        if (!sessionCookie) {
            console.error('Gagal login ke SAP.');
            return;
        }

        for (const record of result.recordset) {
            const doNo = record.do_no;
            console.log('------------------------------------------------------------------------------------');
            console.log(`Memproses DO_NO: ${doNo}`);

            try {
                const docEntry = await getDocEntryFromORDR(doNo, pool);
                
                if (!docEntry) {
                    const noteRev = 'Docentry tidak ditemukan untuk DO_NO: ' + doNo;
                    console.log(`Error: ${noteRev}`);
                    await updateDnFailureStatus(doNo, noteRev, pool);
                    continue;
                }

                console.log(`DO_NO: ${doNo} | DocEntry: ${docEntry}`);

                const orderData = await getOrderFromSAP(docEntry, sessionCookie);
                
                if (!orderData) {
                    const noteRev = 'Data Order tidak ditemukan di SAP';
                    console.log(`Error: ${noteRev}`);
                    await updateDnFailureStatus(doNo, noteRev, pool);
                    continue;
                }

                const dnDetails = await getDnColdspaceDetails(doNo, pool);
                
                if (dnDetails.length === 0) {
                    const noteRev = 'Data detail tidak ditemukan untuk DO_NO: ' + doNo;
                    console.log(`Error: ${noteRev}`);
                    await updateDnFailureStatus(doNo, noteRev, pool);
                    continue;
                }

                const validationResult = await validateAndMatchData(dnDetails, orderData);
                
                if (!validationResult.isValid) {
                    const noteRev = validationResult.message || 'Validasi data gagal';
                    console.log(`Error: ${noteRev}`);
                    await updateDnFailureStatus(doNo, noteRev, pool);
                    continue;
                }

                await updateMatchAndSuccessStatus(doNo, docEntry, doNo, pool);
                const successNote = 'Berhasil Reset DN - data match DONO : '+doNo;
                console.log(`Success: ${successNote}`);
                // New notification calls
                // await notificationService.sendWhatsApp(doNo, doNo, docEntry, successNote, true, pool);
                // await notificationService.sendTelegramNotification(successNote, true);

            } catch (error) {
                const noteRev = error.message.includes('already exists') || error.message.includes('already closed')
                    ? 'Data sudah ada/closed di SAP'
                    : error.message;
                const status = noteRev.includes('already closed') ? 4 : 0;
                await updateDnFailureStatus(doNo, noteRev, pool);
                console.error(`Error memproses DO_NO ${doNo}: ${noteRev}`);
            }
        }

    } catch (error) {
        console.error('Error dalam proses utama:', error.message);
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

const getDocEntryFromORDR = async (doNo, pool) => {
    try {
        const result = await pool.request()
            .input('doNo', sql.Int, doNo)
            .query('SELECT TOP 1 DocEntry FROM [pksrv-sap].pandurasa_live.dbo.ORDR WITH (NOLOCK) WHERE DocNum = @doNo');
        return result.recordset[0]?.DocEntry || null;
    } catch (error) {
        console.log(`Error mendapatkan DocEntry untuk DO_NO ${doNo}: ${error.message}`);
        return null;
    }
};

const getOrderFromSAP = async (docEntry, sessionCookie) => {
    try {
        const response = await axios.get(
            `${SAP_CONFIG.BASE_URL}/Orders(${docEntry})`,
            {
                headers: { 'Cookie': sessionCookie },
                httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
            }
        );
        return response.data;
    } catch (error) {
        throw new Error(`Gagal mendapatkan Order dari SAP: ${error.response?.data?.error?.message || error.message}`);
    }
};

const getDnColdspaceDetails = async (doNo, pool) => {
    try {
        const result = await pool.request()
            .input('doNo', sql.Int, doNo)
            .query(`SELECT * FROM [appsrv].db_pandurasa.dbo.r_dn_coldspace 
                      WHERE do_no = @doNo 
                      AND ismatch = 0 
                      AND (jo_status != 3 OR jo_status IS NULL)`);
        return result.recordset;
    } catch (error) {
        throw new Error(`Gagal mendapatkan detail DN Coldspace: ${error.message}`);
    }
};

const validateAndMatchData = async (dnDetails, orderData) => {
    for (const dnDetail of dnDetails) {
        const lineItem = orderData.DocumentLines.find(line => 
            line.ItemCode === dnDetail.SKU && 
            line.LineNum.toString() === dnDetail.LineNum.toString()
        );

        if (!lineItem) {
            return {
                isValid: false,
                message: `Line item tidak ditemukan untuk SKU: ${dnDetail.SKU}, LineNum: ${dnDetail.LineNum}`
            };
        }

        if (dnDetail.SITE !== lineItem.WarehouseCode) {
            return {
                isValid: false,
                message: `Warehouse tidak match: ${dnDetail.SITE} vs ${lineItem.WarehouseCode} untuk SKU: ${dnDetail.SKU}`
            };
        }

        if (parseFloat(dnDetail.QTY) !== parseFloat(lineItem.Quantity)) {
            return {
                isValid: false,
                message: `Quantity tidak match: ${dnDetail.QTY} vs ${lineItem.Quantity} untuk SKU: ${dnDetail.SKU}`
            };
        }

        if (lineItem.BatchNumbers && lineItem.BatchNumbers.length > 0) {
            const batchMatch = lineItem.BatchNumbers.some(batch => 
                batch.BatchNumber.includes(dnDetail.batchnum) || 
                dnDetail.batchnum.includes(batch.BatchNumber)
            );
            
            if (!batchMatch) {
                console.log(`Warning: Batch number tidak match untuk SKU: ${dnDetail.SKU}`);
            }
        }
    }

    return { isValid: true, message: 'Semua validasi berhasil' };
};

const updateMatchAndSuccessStatus = async (doNo, docEntry, docNum, pool) => {
    try {
        await pool.request()
            .input('doNo', sql.Int, doNo)
            .input('docEntry', sql.Int, docEntry)
            .input('docNum', sql.Int, docNum)
            .query(`UPDATE [appsrv].db_pandurasa.dbo.r_dn_coldspace
                    SET ismatch = 1, 
                        jo_status = null,
                        note = NULL,
                        noterev = NULL,
                        doc_entry = NULL,
                        doc_num =NULL,
                        iswa = NULL,
                        updated_at = GETDATE()
                    WHERE do_no = @doNo`);
    } catch (error) {
        throw new Error(`Gagal update status match: ${error.message}`);
    }
};

const updateDnFailureStatus = async (doNo, noteRev, pool) => {
    try {
        await pool.request()
            .input('doNo', sql.Int, doNo)
            .input('noteRev', sql.NVarChar(255), noteRev)
            .query(`UPDATE [appsrv].db_pandurasa.dbo.r_dn_coldspace
                    SET jo_status = NULL,
                        ismatch = 0, 
                        note = NULL,
                        noterev = @noteRev,
                        doc_entry = NULL,
                        doc_num = NULL,
                        iswa = NULL,
                        updated_at = GETDATE()
                    WHERE do_no = @doNo`);
    } catch (error) {
        throw new Error(`Gagal update status DN: ${error.message}`);
    }
};

const initialize = async () => {
    let pool;
    try {
        pool = await sql.connect(DB_CONFIG);
        await resetFailedDnStatus(pool);
        await resetMismatchDnStatus(pool);
    } catch (error) {
        console.error('Error saat inisialisasi:', error);
    } finally {
        if (pool) await pool.close();
    }

    sendProblematicDnNotifications();
    processRepushDnColdspace().catch(error => {
        console.log('------------------------------------------------------------------------------------');
        console.log(`Error: ${error}`);
        console.log('------------------------------------------------------------------------------------');
    });

    console.log('------------------------------------------------------------------------------------');
    setInterval(() => processRepushDnColdspace(), 10000);
    setInterval(() => sendProblematicDnNotifications(), NOTIFICATION_INTERVAL); // New interval for notifications
    setInterval(() => resetFailedDnStatus(pool), 10000);
    setInterval(() => resetMismatchDnStatus(pool), 10000);
    app.listen(31455, () => {
        console.log('Server DN Repush ready on port 31455');
    });
};

initialize();