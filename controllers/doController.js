const doService = require('../services/doService');

exports.getRnColdspaceData = async (req, res) => {
    try {
        const pool = req.pool;
        const result = await doService.getRnColdspaceData(pool);
        res.json(result);
    } catch (error) {
        console.error('Error di doController.getRnColdspaceData:', error);
        res.status(500).json({
            error: error.message || 'Gagal mengambil data dari r_dn_coldspace.'
        });
    }
};


exports.getgrColdspaceData = async (req, res) => {
  try {
      const pool = req.pool;
      const result = await doService.getgrColdspaceData(pool);
      res.json(result);
  } catch (error) {
      console.error('Error di doController.getgrColdspaceData:', error);
      res.status(500).json({
          error: error.message || 'Gagal mengambil data dari r_dn_coldspace.'
      });
  }
};


exports.checkSingleDO = async (req, res) => {
  try {
    const doNo = req.query.docnum;
    if (!doNo) {
      return res.status(400).json({ 
        error: 'Parameter `docnum` is required for this endpoint.',
        example: '/api/check-do?docnum=12345'
      });
    }

    const pool = req.pool;
    if (!pool) {
      throw new Error('Database connection is not established.');
    }

    const result = await doService.checkSingleDO(doNo, pool);
    res.json(result);
  } catch (error) {
    console.error(`Error in checkSingleDO:`, error.message);
    res.status(500).json({ 
      error: `Request failed: ${error.message}`
    });
  }
};

// Endpoint baru untuk menjalankan auto check secara manual
exports.runAutoCheck = async (req, res) => {
  try {
    const pool = req.pool;
    if (!pool) {
      throw new Error('Database connection is not established.');
    }
    
    const results = await doService.runAutoCheck(pool);
    res.json(results);
  } catch (error) {
    console.error(`Error in runAutoCheck:`, error.message);
    res.status(500).json({ 
      error: `Request failed: ${error.message}`
    });
  }
};

exports.recheckNullIswaDOs = async (req, res) => {
  try {
    const pool = req.pool;
    if (!pool) {
      throw new Error('Database connection is not established.');
    }

    const results = await doService.recheckNullIswaDOs(pool);
    res.json(results);
  } catch (error) {
    console.error('Error in recheckNullIswaDOs:', error.message);
    res.status(500).json({ 
      error: `Request failed: ${error.message}`
    });
  }
};

exports.retryFailedDOs = async (req, res) => {
  try {
    const pool = req.pool;
    if (!pool) {
      throw new Error('Database connection is not established.');
    }

    const results = await doService.retryFailedDOs(pool);
    res.json(results);
  } catch (error) {
    console.error('Error in retryFailedDOs:', error.message);
    res.status(500).json({ 
      error: `Request failed: ${error.message}`
    });
  }
};