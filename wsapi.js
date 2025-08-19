const express = require('express');
const { Connection, Request, TYPES } = require('tedious');
const WebSocket = require('ws');
const http = require('http');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(cors({
    origin: [
        'http://albacore-direct-neatly.ngrok-free.app',
        'https://jauharimalik.github.io',
        'https://app2.pkserve.com',
        'https://cute-mature-shrew.ngrok-free.app',
        'http://192.168.60.19',
        'https://jauharimalik.github.io/sapapi',
        'https://rightly-composed-marlin.ngrok-free.app'
    ],
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'ngrok-skip-browser-warning']
}));

const config = {
    server: '192.168.100.202',
    authentication: {
        type: 'default',
        options: {
            userName: 'PK-SERVE',
            password: 'n0v@0707#'
        }
    },
    options: {
        database: 'db_pandurasa',
        encrypt: false
    }
};

const fetchData = () => {
    const connection = new Connection(config);
    connection.on('connect', err => {
        if (err) {
            console.error(err);
            return;
        }

        const request = new Request(
            'SELECT * FROM r_grpo_coldspace; SELECT * FROM r_dn_coldspace;',
            (err, rowCount, rows) => {
                if (err) {
                    console.error(err);
                    return;
                }
                
                const grpoData = [];
                const dnData = [];
                let currentTable = 'grpo';

                rows.forEach(row => {
                    const rowData = {};
                    row.forEach(col => {
                        rowData[col.metadata.colName] = col.value;
                    });
                    if (currentTable === 'grpo' && Object.keys(rowData).length > 0) {
                        grpoData.push(rowData);
                    } else if (Object.keys(rowData).length > 0) {
                        dnData.push(rowData);
                    }
                });

                if (rowCount > 0 && currentTable === 'grpo' && grpoData.length < rowCount) {
                    currentTable = 'dn';
                }

                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            grpo: grpoData,
                            dn: dnData
                        }));
                    }
                });
                
                connection.close();
            }
        );
        connection.execSql(request);
    });

    connection.connect();
};

wss.on('connection', ws => {
    console.log('Client connected!');
});

const PORT = 1948;
server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
    setInterval(fetchData, 5000);
});