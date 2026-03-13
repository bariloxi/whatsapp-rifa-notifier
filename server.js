const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

// Log requests
app.use((req, res, next) => {
    if (req.method !== 'GET') {
        console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
    }
    next();
});

const DB_PATH = path.join(__dirname, 'database.json');

// Middleware de Autenticação
const authMiddleware = (req, res, next) => {
    const publicPaths = ['/status', '/qr', '/login'];
    if (publicPaths.includes(req.path)) return next();

    const token = req.headers['authorization'];
    if (!token) return res.status(401).json({ error: 'Token não fornecido' });

    const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    if (!db.activeSessions || !db.activeSessions.includes(token)) {
        return res.status(401).json({ error: 'Sessão inválida ou expirada' });
    }
    next();
};

app.use(authMiddleware);

// Servir arquivos estáticos do frontend (fundamental vir antes das rotas customizadas se houver conflito)
app.use(express.static(path.join(__dirname, 'frontend', 'dist')));

const clientOptions = {
    authStrategy: new LocalAuth(),
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1018915031-alpha.html',
    },
    puppeteer: {
        executablePath: process.env.CHROME_PATH || undefined,
        headless: process.env.HEADLESS === 'false' ? false : true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-web-security',
            '--disable-features=IsolateOrigins,site-per-process',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ]
    }
};

let client = new Client(clientOptions);

let qrCodeData = null;
let clientStatus = 'DISCONNECTED';
let pairingCode = null;

function setupClient(c) {
    c.on('qr', (qr) => {
        console.log('QR RECEIVED', qr);
        qrCodeData = qr;
        clientStatus = 'QR_READY';
    });

    c.on('ready', () => {
        console.log('Client is ready!');
        qrCodeData = null;
        clientStatus = 'CONNECTED';
    });

    c.on('authenticated', () => {
        console.log('AUTHENTICATED');
    });

    c.on('auth_failure', msg => {
        console.error('AUTHENTICATION FAILURE', msg);
        clientStatus = 'DISCONNECTED';
    });

    c.on('disconnected', (reason) => {
        console.log('Client was logged out', reason);
        clientStatus = 'DISCONNECTED';
        qrCodeData = null;
    });

    c.initialize().catch(err => {
        console.error('Failed to initialize client:', err);
        clientStatus = 'DISCONNECTED';
    });
}

setupClient(client);

// API Endpoints

app.post('/reset', async (req, res) => {
    console.log('--- RESET INICIADO ---');
    try {
        if (client) {
            try {
                console.log('Finalizando cliente antigo...');
                await client.destroy();
                await new Promise(resolve => setTimeout(resolve, 2000));
            } catch (e) {
                console.error('Aviso ao finalizar cliente:', e.message);
            }
        }
        
        qrCodeData = null;
        pairingCode = null;
        clientStatus = 'DISCONNECTED';
        
        const authPath = path.join(__dirname, '.wwebjs_auth');
        if (fs.existsSync(authPath)) {
            try {
                console.log('Limpando pasta de sessão...');
                fs.rmSync(authPath, { recursive: true, force: true });
                console.log('Pasta de sessão limpa.');
            } catch (err) {
                console.error('Erro ao limpar pasta:', err.message);
            }
        }

        console.log('Iniciando novo cliente...');
        client = new Client(clientOptions);
        setupClient(client);
        
        res.json({ success: true, message: 'Servidor reiniciando...' });
    } catch (err) {
        console.error('ERRO FATAL NO RESET:', err);
        res.status(500).json({ error: 'Erro interno ao resetar: ' + err.message });
    }
});

app.post('/request-code', async (req, res) => {
    let { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Telefone é obrigatório' });
    
    // Formata o número: remove tudo que não é dígito
    phone = phone.replace(/\D/g, '');
    if (phone.length < 10) return res.status(400).json({ error: 'Número de telefone inválido' });

    console.log(`--- SOLICITANDO CÓDIGO PARA: ${phone} ---`);
    
    try {
        if (clientStatus === 'CONNECTED') {
            return res.status(400).json({ error: 'O WhatsApp já está conectado!' });
        }

        // Tenta gerar o código. Em alguns casos, o client precisa de alguns segundos apos initialize
        const code = await client.requestPairingCode(phone);
        pairingCode = code;
        console.log(`CÓDIGO GERADO: ${code}`);
        res.json({ code });
    } catch (err) {
        console.error('ERRO AO GERAR CÓDIGO:', err.message);
        res.status(500).json({ 
            error: 'O WhatsApp ainda está iniciando ou a versão é incompatível. Tente resetar, aguardar 10 segundos e tentar novamente.' 
        });
    }
});

app.post('/login', (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token é obrigatório' });

    const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    if (!db.activeSessions) db.activeSessions = [];
    
    // Se já estiver em uma sessão ativa, permite (re-login na mesma aba)
    if (db.activeSessions.includes(token)) {
        return res.json({ success: true, message: 'Já autenticado' });
    }

    if (db.tokens && db.tokens.includes(token)) {
        // Move o token de 'disponíveis' para 'sessões ativas'
        db.tokens = db.tokens.filter(t => t !== token);
        db.activeSessions.push(token);
        fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
        res.json({ success: true, message: 'Login realizado com sucesso' });
    } else {
        res.status(401).json({ error: 'Token inválido ou já utilizado' });
    }
});

app.post('/logout', (req, res) => {
    const token = req.headers['authorization'];
    if (token) {
        const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
        if (db.activeSessions) {
            db.activeSessions = db.activeSessions.filter(t => t !== token);
            fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
        }
    }
    res.json({ success: true });
});

app.post('/generate-token', (req, res) => {
    // Apenas para uso interno ou admin
    const newToken = 'RIFA-' + Math.random().toString(36).substr(2, 9).toUpperCase();
    const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    if (!db.tokens) db.tokens = [];
    db.tokens.push(newToken);
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
    res.json({ success: true, token: newToken });
});

app.get('/status', (req, res) => {
    res.json({ status: clientStatus, hasQR: !!qrCodeData, pairingCode });
});

app.get('/qr', async (req, res) => {
    if (qrCodeData) {
        try {
            const url = await qrcode.toDataURL(qrCodeData);
            res.json({ qr: url });
        } catch (err) {
            res.status(500).json({ error: 'Failed to generate QR code' });
        }
    } else {
        res.status(404).json({ error: 'QR code not available' });
    }
});

app.get('/participants', (req, res) => {
    const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    res.json(db.participants);
});

app.post('/participants', (req, res) => {
    const { name, phone } = req.body;
    if (!name || !phone) return res.status(400).json({ error: 'Name and phone are required' });
    
    const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    const cleanPhone = phone.replace(/\D/g, '');
    db.participants.push({ name, phone: cleanPhone });
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
    res.json({ success: true });
});

app.post('/participants/bulk', (req, res) => {
    try {
        const { participants } = req.body;
        if (!Array.isArray(participants)) {
            console.error('Erro: participants no  um array');
            return res.status(400).json({ error: 'Participants array required' });
        }
        
        console.log(`Recebidos ${participants.length} contatos para importao`);
        
        if (!fs.existsSync(DB_PATH)) {
            fs.writeFileSync(DB_PATH, JSON.stringify({ participants: [] }));
        }
        
        const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
        if (!db.participants) db.participants = [];

        let addedCount = 0;
        let duplicateCount = 0;
        let errorCount = 0;
        
        participants.forEach(p => {
            if (p.name && p.phone) {
                const cleanPhone = p.phone.toString().replace(/\D/g, '');
                if (!cleanPhone) {
                    errorCount++;
                    return;
                }
                // Only add if phone is not already there
                if (!db.participants.find(existing => existing.phone === cleanPhone)) {
                    db.participants.push({ name: p.name, phone: cleanPhone });
                    addedCount++;
                } else {
                    duplicateCount++;
                }
            } else {
                errorCount++;
            }
        });

        fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
        console.log(`Importao concluda: ${addedCount} adicionados, ${duplicateCount} duplicados, ${errorCount} erros`);
        
        res.json({ 
            success: true, 
            added: addedCount, 
            duplicates: duplicateCount, 
            errors: errorCount,
            totalInDb: db.participants.length 
        });
    } catch (err) {
        console.error('ERRO NA IMPORTAO BULK:', err);
        res.status(500).json({ error: 'Erro interno ao importar: ' + err.message });
    }
});

app.delete('/participants/all', (req, res) => {
    const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    db.participants = [];
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
    res.json({ success: true });
});

app.delete('/participants/:phone', (req, res) => {
    const phone = req.params.phone;
    const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    db.participants = db.participants.filter(p => p.phone !== phone);
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
    res.json({ success: true });
});

app.post('/send-bulk', async (req, res) => {
    const { message, video } = req.body;
    if (clientStatus !== 'CONNECTED') return res.status(400).json({ error: 'WhatsApp not connected' });
    
    const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    const participants = db.participants;

    res.json({ success: true, count: participants.length });

    // Prepara a mídia se houver vídeo
    let media = null;
    if (video && video.data && video.mimetype) {
        try {
            media = new MessageMedia(video.mimetype, video.data, video.filename || 'video.mp4');
            console.log('Mídia de vídeo preparada para envio em massa.');
        } catch (e) {
            console.error('Erro ao preparar mídia:', e.message);
        }
    }

    // Send messages in background with delay
    for (const participant of participants) {
        try {
            // WhatsApp format: 5511999999999@c.us (for Brazil)
            const chatId = participant.phone.includes('@c.us') ? participant.phone : `${participant.phone}@c.us`;
            
            // Envia o vídeo primeiro, se houver
            if (media) {
                await client.sendMessage(chatId, media);
                console.log(`Vídeo enviado para ${participant.name}`);
            }

            // Envia o texto SEM PREVIEW de link (remove a imagem automática do site)
            await client.sendMessage(chatId, message.replace('{nome}', participant.name), { linkPreview: false });
            console.log(`Mensagem de texto enviada para ${participant.name}`);
            
            // Random delay between 60-120 seconds to avoid ban (1-2 minutes)
            const delay = Math.floor(Math.random() * (120000 - 60000 + 1)) + 60000;
            await new Promise(resolve => setTimeout(resolve, delay));
        } catch (err) {
            console.error(`Error sending to ${participant.name}:`, err);
        }
    }
});

// Rota para o frontend (Single Page Application) - Deve ser o último!
app.get('*', (req, res) => {
    const indexPath = path.join(__dirname, 'frontend', 'dist', 'index.html');
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        res.status(404).send('Frontend não encontrado. Verifique se o build foi realizado.');
    }
});

app.listen(port, () => {
    console.log(`Server running at port ${port}`);
});
