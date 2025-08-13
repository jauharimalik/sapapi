const sql = require('mssql');
const { sendWhatsAppNotification } = require('./dbService');

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
        console.error(`Process: ${poNo} | Error: ${error.message}`);
        await sendWhatsAppNotification(poNo, null, null, `Gagal: ${error.message}`, false, pool);
        return null;
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
            T1.DocEntry, T1.DocNum;`;

    const result = await pool.request().query(query);
    return result.recordset.length > 0 ? result.recordset[0] : null;
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

module.exports = {
    getDocEntryFromOIGE,
    getFinalGoodsReceiptData,
    resetNotificationStatus,
};