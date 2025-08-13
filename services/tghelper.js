const sql = require('mssql');
const axios = require('axios');
const { SAP_CONFIG } = require('../utils/constants');

const getBatchDataFromOBTN = async (itemCode, whsCode, ExpDate, pool) => {
    try {
        const query = `
            SELECT TOP 1
                ISNULL(T1.BatchNum, '${ExpDate}') AS BatchNumber,
                T1.Quantity AS AvailableQuantity,
                ISNULL(T1.ExpDate, '${ExpDate}') AS ExpirationDate
            FROM [pksrv-sap].test.dbo.OIBT T1
            INNER JOIN [pksrv-sap].test.dbo.oitm T2 ON T1.ItemCode = T2.ItemCode
            WHERE T1.ItemCode = '${itemCode}' AND (T1.WhsCode = '${whsCode}' OR T1.WhsCode = T2.dfltwh) AND T1.Quantity > 0
            AND T1.BatchNum LIKE '${ExpDate}%'
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

const getBinAbsEntry = async (whsCode, pool) => {
    const query = `
        SELECT TOP 1 T0.AbsEntry
        FROM [pksrv-sap].test.dbo.OBIN T0
        WHERE T0.WhsCode = @whsCode
        ORDER BY T0.AbsEntry ASC`;
    const result = await pool.request()
        .input('whsCode', sql.NVarChar, whsCode)
        .query(query);
    return result.recordset[0]?.AbsEntry || null;
};

const createGoodsReceiptPayload = async (record, batchData, goodsIssue, pool, series) => {
    const lineItem = goodsIssue.DocumentLines.find(line =>
        line.ItemCode === record.SKU && line.LineNum.toString() === record.LINE_NO.toString()
    );

    let warehouseCode;
    if (record.sub_vendor === 'VIRTUAL') {
        warehouseCode = 'CS-03';
    } else {
        switch (record.SKU_QUALITY) {
            case 'Y':
                warehouseCode = record.dfltwh || record.sub_vendor;
                break;
            case 'N':
                warehouseCode = record.sub_vendor;
                break;
            default:
                warehouseCode = record.sub_vendor;
                break;
        }
    }

    const whsCode = warehouseCode === 'VIRTUAL' ? 'CS-03' : warehouseCode;
    const binAbsEntry = await getBinAbsEntry(whsCode, pool);

    const documentLines = [{
        ItemCode: record.SKU,
        Quantity: record.QTYPO,
        WarehouseCode: whsCode,
        InventoryQuantity: record.QTYPO,
        BaseEntry: goodsIssue.DocEntry,
        BaseType: 60,
        BaseLine: lineItem.LineNum
    }];

    if (batchData?.BatchNumber) {
        documentLines[0].BatchNumbers = [{
            BatchNumber: batchData.BatchNumber,
            Quantity: record.QTYPO,
            ExpiryDate: batchData.ExpiryDate,
            AddmisionDate: new Date().toISOString().split('T')[0]
        }];
    }

    if (binAbsEntry) {
        documentLines[0].DocumentLinesBinAllocations = [{
            BinAbsEntry: binAbsEntry,
            Quantity: record.QTYPO,
            SerialAndBatchNumbersBaseLine: 0,
            BaseLineNumber: 0
        }];
    }
    
    return {
        DocType: "dDocument_Items",
        DocDate: new Date().toISOString().split('T')[0],
        DocDueDate: new Date().toISOString().split('T')[0],
        Comments: `Penerimaan Barang berdasarkan Pengeluaran Barang #${goodsIssue.DocNum}`,
        JournalMemo: "Goods Receipt",
        DocTime: new Date().toLocaleTimeString('id-ID', { hour12: false }),
        Series: series,
        TaxDate: new Date().toISOString().split('T')[0],
        DocObjectCode: "oInventoryGenEntry",
        DocumentLines: documentLines,
        U_IDU_MobBaseRef: goodsIssue.DocNum,
        U_IDU_No_TukarGuling: goodsIssue.DocNum,
        U_IDU_Referensi: goodsIssue.DocNum,
        U_IDU_JenisPajak: "04",
        U_IDU_Pengganti: "0",
        U_IDU_KetTambah: "0",
        U_IDU_Credit: "0",
        U_IDU_StatusInvoice: "No Tagih",
        U_IDU_TukarFaktur: "No TF",
        U_IDU_JDP: "0",
        U_IDU_RatePajak: "12",
        U_PK_VerifTT: 0,
        U_Print: 0,
        U_IDU_Status_DebitNote: "N"
    };
};

const postGoodsReceiptToSAP = async (payload, sessionCookie) => {
    try {
        const response = await axios.post(
            `${SAP_CONFIG.BASE_URL}/InventoryGenEntries`,
            payload, {
            headers: { 'Cookie': sessionCookie },
            httpsAgent: new(require('https').Agent)({ rejectUnauthorized: false })
        });
        return response.data;
    } catch (error) {
        const errorMessage = error.response?.data?.error?.message?.value || error.response?.statusText || error.message || 'Terjadi kesalahan tidak dikenal.';
        return { error: true, message: errorMessage };
    }
};

module.exports = {
    getBatchDataFromOBTN,
    getBinAbsEntry,
    createGoodsReceiptPayload,
    postGoodsReceiptToSAP,
};