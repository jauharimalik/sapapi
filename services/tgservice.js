const axios = require('axios');
const sql = require('mssql');
const { SAP_CONFIG } = require('../utils/constants');
const { updateRecordStatus, sendWhatsAppNotification, getDocEntryFromOIGE, getFinalGoodsReceiptData } = require('./dbService');
const { getBatchDataFromOBTN, getBinAbsEntry, createGoodsReceiptPayload, postGoodsReceiptToSAP } = require('./sapServiceHelpers');

async function getDynamicSeries(pool) {
    try {
        const result = await pool.request()
            .query(`
                SELECT TOP 1 series
                FROM [pksrv-sap].test.dbo.nnm1
                WHERE series = 686 OR (seriesname LIKE '%tg%' AND indicator = YEAR(GETDATE()))
            `);
        
        if (result.recordset.length > 0) {
            return result.recordset[0].series;
        }
        return 686;
    } catch (error) {
        console.error('Gagal mendapatkan series dinamis:', error);
        return 686;
    }
}

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

const processTradeinTradeout = async (pool) => {
    try {
        const series = await getDynamicSeries(pool);
        const result = await pool.request()
            .query(`SELECT *,
                CASE WHEN t0x.SKU_qUALITY = 'n' THEN t2.dfltwh ELSE t0x.vendor collate database_default END AS vendor,
                CASE WHEN t0x.SKU_qUALITY = 'n' THEN t2.dfltwh ELSE t0x.vendor collate database_default END AS sub_vendor
                FROM r_grpo_coldspace t0x
                INNER JOIN [pksrv-sap].test.dbo.oitm t2 ON t0x.sku collate database_default = t2.itemcode collate database_default
                WHERE (t0x.iswa IS NULL OR t0x.jo_status IS NULL) AND t0x.TRK_TYPE = 'rplc'`);

        if (result.recordset.length === 0) return;

        const sessionCookie = await loginToSAP();
        if (!sessionCookie) return;

        for (const record of result.recordset) {
            try {
                if (record.QTYPO <= 0) {
                    await updateRecordStatus(record.id, 0, 'Kuantitas nol atau tidak valid', null, null, pool);
                    await sendWhatsAppNotification(record.PO_NO, null, null, 'Gagal: Kuantitas nol atau tidak valid', false, pool);
                    continue;
                }

                const docEntry = await getDocEntryFromOIGE(record.PO_NO, pool);
                if (!docEntry) {
                    const note = 'Docentry OIGE tidak ditemukan';
                    await updateRecordStatus(record.id, 0, note, null, null, pool);
                    await sendWhatsAppNotification(record.PO_NO, null, null, `Gagal: ${note}`, false, pool);
                    continue;
                }
                const goodsIssueData = await getGoodsIssueFromSAP(docEntry, sessionCookie);

                let validationResult = validateVfdatWithExpDate(record, goodsIssueData);

                let warehouseCode;
                let dfltwh = await getDfltwhForSKU(record.sub_vendor);
                if (record.sub_vendor === 'VIRTUAL') {
                    warehouseCode = 'CS-03';
                } else {
                    switch (record.SKU_QUALITY) {
                        case 'Y':
                            warehouseCode = dfltwh || record.sub_vendor;
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
                    const batchDataFromOBTN = await getBatchDataFromOBTN(record.SKU, vendor, record.VFDAT, pool);
                    if (!batchDataFromOBTN) {
                        const note = 'Batch data tidak ditemukan untuk SKU';
                        await updateRecordStatus(record.id, 0, note, null, null, pool);
                        await sendWhatsAppNotification(record.PO_NO, null, null, `Gagal: ${note}`, false, pool);
                        continue;
                    }
                    validationResult = { isValid: true, batchData: batchDataFromOBTN };
                }

                const goodsReceiptPayload = await createGoodsReceiptPayload(record, validationResult.batchData, goodsIssueData, pool, series);
                const pcc = await postGoodsReceiptToSAP(goodsReceiptPayload, sessionCookie);

                if (pcc?.error) {
                    const status = pcc.message.includes('closed') ? 3 : 0;
                    const note = status === 3 ? 'Berhasil diproses Tukar Guling' : `Gagal: ${pcc.message}`;
                    await updateRecordStatus(record.id, status, note, null, null, pool);
                    await sendWhatsAppNotification(record.PO_NO, null, null, note, true, pool);
                    continue;
                }

                const finalData = await getFinalGoodsReceiptData(docEntry, pool);
                if (finalData) {
                    const { GoodsReceiptDocEntry, GoodsReceiptDocNum } = finalData;
                    const successNote = 'Berhasil diproses sebagai Goods Receipt';
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

module.exports = {
    getDfltwhForSKU,
    getDynamicSeries,
    processTradeinTradeout
};