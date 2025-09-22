const app = require('./app');
const dbService = require('./services/dbService');
const doService = require('./services/doService');
const http = require('http');
const WebSocket = require('ws');

const port = 3300;
async function initialize() {
    try {
      const pool = await dbService.connect();
      app.set('pool', pool);
      const connOk = await dbService.verifyConnection();
      if (!connOk) throw new Error('Database connection failed');
      
      await doService.dnbund(pool); 
      await doService.runAutoCheck(pool);
      await doService.recheckNullIswaDOs(pool);

      setInterval(() => doService.dnbund(pool), 1000);
      setInterval(() => doService.runAutoCheck(pool), 6000); 
      setInterval(() => doService.recheckNullIswaDOs(pool), 360000); 

      const server = http.createServer(app);
      const wss = new WebSocket.Server({ server });

      wss.on('connection', (ws) => {
          console.log('Client WebSocket connected');
          ws.send(JSON.stringify({ message: 'Welcome to WebSocket server' }));

          ws.on('message', (message) => {
              console.log('Received:', message);
              ws.send(JSON.stringify({ message: `Server received: ${message}` }));
          });

          ws.on('close', () => {
              console.log('Client WebSocket disconnected');
          });
      });

      console.log('------------------------------------------------------------------------------------');
      server.listen(port, () => {
        console.log(`Server ready on port ${port}`);
      });
    } catch (error) {
      console.error('Startup failed:', error);
      process.exit(1);
    }
}

initialize();