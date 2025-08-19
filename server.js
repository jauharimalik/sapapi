const app = require('./app');
const dbService = require('./services/dbService');
const doService = require('./services/doService');

const port = 3300;
async function initialize() {
    try {
      const pool = await dbService.connect();
      
      // Make pool available to app
      app.set('pool', pool);
      
      // Verify connection
      const connOk = await dbService.verifyConnection();
      if (!connOk) throw new Error('Database connection failed');
      
      // Initialize services
      await doService.dnbund(pool); 
      await doService.runAutoCheck(pool);
      await doService.recheckNullIswaDOs(pool);
      
      // Start periodic checks
      setInterval(() => doService.dnbund(pool), 1000); // 5 minutes
      setInterval(() => doService.runAutoCheck(pool), 6000); // 5 minutes
      setInterval(() => doService.recheckNullIswaDOs(pool), 360000); // 1 hour
      
      console.log('------------------------------------------------------------------------------------');
      app.listen(port, () => {
        console.log(`Server ready on port ${port}`);
      });
    } catch (error) {
      console.error('Startup failed:', error);
      process.exit(1);
    }
}

initialize();