import makeWASocket, {
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import dotenv from 'dotenv';
import fs from 'fs';
import AccountManager from './utils/accountManager.js';
import ChatGPTService from './utils/chatgptService.js';
import ChatGPTLoginService from './utils/chatgptLoginService.js';
import UserManager from './utils/userManager.js';
import MemberManager from './utils/memberManager.js';

// Load environment variables
dotenv.config();

class WhatsAppBot {
    constructor() {
        this.accountManager = new AccountManager();
        this.chatgptService = new ChatGPTService(this.accountManager);
        this.chatgptLoginService = new ChatGPTLoginService(this.accountManager);
        this.userManager = new UserManager();
        this.memberManager = new MemberManager();
        this.ownerNumbers = process.env.OWNER_NUMBERS ? process.env.OWNER_NUMBERS.split(',').map(num => num.trim()).filter(Boolean) : [];
        this.ownerLidMapping = this.loadOwnerLidMapping();
        console.log('👑 Owner Numbers:', this.ownerNumbers);
        this.inviteQueueFile = 'data/invite-queue.json';
        this.inviteQueue = this.loadInviteQueue();
        this.pendingInvites = this.inviteQueue.length;
        this.isProcessingQueue = false;
        this.userJidMappingFile = 'data/user-jid-mapping.json';
        this.userJidMapping = this.loadUserJidMapping();
        this.adminCommands = ['/add', '/list', '/hapus', '/kick', '/stats', '/setpremium', '/setfree', '/members', '/userstats', '/broadcast'];
        this.sock = null;
    }





    loadUserJidMapping() {
        try {
            if (!fs.existsSync(this.userJidMappingFile)) {
                return {};
            }

            const data = JSON.parse(fs.readFileSync(this.userJidMappingFile, 'utf8'));
            if (!data || typeof data !== 'object' || Array.isArray(data)) {
                return {};
            }

            return data;
        } catch (error) {
            console.error('Error loading user JID mapping:', error);
            return {};
        }
    }

    saveUserJidMapping() {
        try {
            fs.writeFileSync(this.userJidMappingFile, JSON.stringify(this.userJidMapping, null, 2));
        } catch (error) {
            console.error('Error saving user JID mapping:', error);
        }
    }

    normalizeDigits(value) {
        return (value || '').toString().replace(/\D/g, '');
    }

    loadInviteQueue() {
        try {
            if (!fs.existsSync(this.inviteQueueFile)) {
                return [];
            }

            const data = JSON.parse(fs.readFileSync(this.inviteQueueFile, 'utf8'));
            if (!Array.isArray(data)) {
                return [];
            }

            return data.map(item => ({
                id: item.id,
                from: item.from,
                targetEmail: item.targetEmail,
                createdAt: item.createdAt,
                status: item.status === 'processing' ? 'queued' : (item.status || 'queued')
            })).filter(item => item.id && item.from && item.targetEmail);
        } catch (error) {
            console.error('Error loading invite queue:', error);
            return [];
        }
    }

    saveInviteQueue() {
        try {
            fs.writeFileSync(this.inviteQueueFile, JSON.stringify(this.inviteQueue, null, 2));
        } catch (error) {
            console.error('Error saving invite queue:', error);
        }
    }

    enqueueInvite(job) {
        this.inviteQueue.push(job);
        this.pendingInvites = this.inviteQueue.length;
        this.saveInviteQueue();
    }

    removeInvite(jobId) {
        this.inviteQueue = this.inviteQueue.filter(job => job.id !== jobId);
        this.pendingInvites = this.inviteQueue.length;
        this.saveInviteQueue();
    }

    async processQueue() {
        if (this.isProcessingQueue || !this.sock) {
            return;
        }

        this.isProcessingQueue = true;
        try {
            while (true) {
                const job = this.inviteQueue.find(item => item.status === 'queued');
                if (!job) {
                    break;
                }

                job.status = 'processing';
                this.saveInviteQueue();

                try {
                    await this.processInvite(job);
                } catch (error) {
                    console.error('❌ Error invite queued:', error);
                    await this.sendMessage(job.from, `❌ Invite gagal: ${error.message}`);
                } finally {
                    this.removeInvite(job.id);
                }
            }
        } finally {
            this.isProcessingQueue = false;
        }
    }

    async isOwnerNumber(phoneNumber, from) {
        // Direct match with .env OWNER_NUMBERS (for @s.whatsapp.net)
        const directMatch = this.ownerNumbers.some(num => phoneNumber.includes(num) || num.includes(phoneNumber));
        if (directMatch) return true;

        // Partial match: last 8 digits
        for (const ownerNum of this.ownerNumbers) {
            if (ownerNum.slice(-8) === phoneNumber.slice(-8)) return true;
        }

        // Check cached LID mapping
        if (this.ownerLidMapping[from]) {
            return true;
        }

        // Linked device (@lid): try to resolve real number
        if (from && from.includes('@lid')) {
            try {
                // Method 1: onWhatsApp lookup
                if (this.sock) {
                    const [result] = await this.sock.onWhatsApp(phoneNumber);
                    if (result && result.jid) {
                        const realNumber = result.jid.split('@')[0];
                        const isOwner = this.ownerNumbers.some(num =>
                            realNumber.includes(num) || num.includes(realNumber) ||
                            realNumber.slice(-8) === num.slice(-8)
                        );
                        if (isOwner) {
                            console.log(`👑 Owner detected via LID resolve: ${from} -> ${realNumber}`);
                            this.ownerLidMapping[from] = realNumber;
                            this.saveOwnerLidMapping();
                            return true;
                        }
                    }
                }
            } catch (e) {
                console.log(`⚠️ LID resolve gagal: ${e.message}`);
            }
        }

        // Fallback: try onWhatsApp for non-LID too
        try {
            if (this.sock && from) {
                const [result] = await this.sock.onWhatsApp(from.split('@')[0]);
                if (result && result.jid) {
                    const realNumber = result.jid.split('@')[0];
                    const isOwner = this.ownerNumbers.some(num =>
                        realNumber.includes(num) || num.includes(realNumber)
                    );
                    if (isOwner) {
                        console.log('👑 Owner detected via linked device: ' + phoneNumber + ' -> ' + realNumber);
                        this.ownerLidMapping[from] = realNumber;
                        this.saveOwnerLidMapping();
                        return true;
                    }
                }
            }
        } catch (e) { }

        return false;
    }

    loadOwnerLidMapping() {
        try {
            if (fs.existsSync('data/owner-lid-mapping.json')) {
                return JSON.parse(fs.readFileSync('data/owner-lid-mapping.json', 'utf8'));
            }
        } catch (e) { }
        return {};
    }

    saveOwnerLidMapping() {
        try {
            if (!fs.existsSync('data')) fs.mkdirSync('data', { recursive: true });
            fs.writeFileSync('data/owner-lid-mapping.json', JSON.stringify(this.ownerLidMapping, null, 2));
        } catch (e) { }
    }

    async getUserKey(from, phoneNumber) {
        if (from.includes('@s.whatsapp.net')) {
            return from;
        }

        if (this.userJidMapping[from]) {
            return this.userJidMapping[from];
        }

        try {
            if (this.sock) {
                const [result] = await this.sock.onWhatsApp(from.split('@')[0]);
                if (result && result.jid) {
                    this.userJidMapping[from] = result.jid;
                    this.saveUserJidMapping();
                    this.userManager.mergeUsers(from, result.jid);
                    return result.jid;
                }
            }
        } catch (error) {
            console.log(`⚠️ onWhatsApp user check failed: ${error.message}`);
        }

        const digits = this.normalizeDigits(phoneNumber || from);
        const matchedUser = this.userManager.findUserByPhoneDigits(digits);
        if (matchedUser) {
            this.userJidMapping[from] = matchedUser;
            this.saveUserJidMapping();
            this.userManager.mergeUsers(from, matchedUser);
            return matchedUser;
        }

        return from;
    }

    async start() {
        const { state, saveCreds } = await useMultiFileAuthState('sessions/wa-bot');
        const { version } = await fetchLatestBaileysVersion();

        this.sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            auth: state,
            browser: ['AutoInvite Bot', 'Chrome', '1.0.0']
        });

        this.sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            // Handle QR code
            if (qr) {
                console.log('📱 Scan QR Code di bawah ini dengan WhatsApp:\n');
                qrcode.generate(qr, { small: true });
            }

            if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                console.log('❌ Koneksi tertutup, reconnecting:', shouldReconnect);

                if (shouldReconnect) {
                    await this.start();
                }
            } else if (connection === 'open') {
                console.log('✅ Bot WhatsApp terhubung!');
                console.log('📱 Siap menerima perintah...\n');
                await this.processQueue();
                this.startAutoKickTimer();
            }
        });

        this.sock.ev.on('creds.update', saveCreds);

        this.sock.ev.on('messages.upsert', async ({ messages }) => {
            try {
                const msg = messages[0];
                if (!msg.message || msg.key.fromMe) return;

                const text = msg.message?.conversation ||
                    msg.message?.extendedTextMessage?.text || '';

                if (!text) return;

                const from = msg.key.remoteJid;
                // Extract phone number from remoteJid (handle both @s.whatsapp.net and @lid format)
                const phoneNumber = from.split('@')[0];
                const pushName = msg.pushName || 'Unknown';
                const userKey = await this.getUserKey(from, phoneNumber);
                const isOwner = await this.isOwnerNumber(phoneNumber, from);

                // Simpan/update pushName di user record
                this.userManager.updatePushName(userKey, pushName);

                console.log(`📨 ${pushName} | ${phoneNumber}${isOwner ? ' 👑' : ''}`);

                // Enforce /start untuk user baru (admin bebas)
                const cmdLower = text.trim().toLowerCase();

                // /registeradmin — special command to register LID as owner (anyone can try, but must match .env)
                if (cmdLower.startsWith('/registeradmin')) {
                    await this.handleRegisterAdmin(from, text.trim().split(' '));
                    return;
                }

                // Enforce /start untuk user baru (admin bebas)
                if (!isOwner && cmdLower.startsWith('/') && cmdLower !== '/start') {
                    const existingUser = this.userManager.loadUsers().users.find(u => u.phone === userKey);
                    if (!existingUser) {
                        await this.sendMessage(from, '👋 Halo! Ketik */start* dulu untuk mulai menggunakan bot ini.');
                        return;
                    }
                }

                await this.handleCommand(from, text, isOwner, phoneNumber, userKey);
            } catch (error) {
                console.error('❌ Error handling message:', error);
                console.error(error.stack);
            }
        });
    }

    async handleCommand(from, text, isOwner, phoneNumber, userKey) {
        const args = text.trim().split(' ');
        const command = args[0].toLowerCase();

        // Admin-only commands — block non-admin
        if (this.adminCommands.includes(command)) {
            if (!isOwner) {
                await this.sendMessage(from, '❌ Command ini khusus admin.');
                return;
            }

            if (command === '/add') {
                await this.handleAdd(from, args);
            } else if (command === '/list') {
                await this.handleList(from);
            } else if (command === '/hapus') {
                await this.handleHapus(from, args);
            } else if (command === '/kick') {
                await this.handleKick(from, args);
            } else if (command === '/stats') {
                await this.handleStats(from);
            } else if (command === '/setpremium') {
                await this.handleSetPremium(from, args);
            } else if (command === '/setfree') {
                await this.handleSetFree(from, args);
            } else if (command === '/members') {
                await this.handleMembers(from, args);
            } else if (command === '/userstats') {
                await this.handleUserStats(from);
            } else if (command === '/broadcast') {
                await this.handleBroadcast(from, args);
            }
            return;
        }

        // Menu/Help — different view for owner vs user
        if (command === '/menu' || command === '/help') {
            if (isOwner) {
                await this.sendOwnerHelp(from);
            } else {
                await this.sendUserHelp(from, userKey);
            }
            return;
        }

        // User Commands (available for everyone)
        if (command === '/invite') {
            await this.handleInvite(from, args, userKey);
        } else if (command === '/status') {
            await this.handleStatusCheck(from, userKey);
        } else if (command === '/myplan') {
            await this.handleMyPlan(from, userKey);
        } else if (command === '/linkme') {
            await this.handleLinkMe(from, args);
        } else if (command === '/start') {
            await this.sendWelcome(from, userKey);
        }
    }

    async handleRegisterAdmin(from, args) {
        if (args.length < 2) {
            await this.sendMessage(from, '❌ Format: /registeradmin <nomor_hp>\nContoh: /registeradmin 6287750914688');
            return;
        }

        const phoneInput = args[1].replace(/\D/g, '');

        // Cek apakah nomor ini ada di .env OWNER_NUMBERS
        const isValidOwner = this.ownerNumbers.some(num =>
            num === phoneInput || num.includes(phoneInput) || phoneInput.includes(num) ||
            num.slice(-8) === phoneInput.slice(-8)
        );

        if (!isValidOwner) {
            await this.sendMessage(from, '❌ Nomor ini tidak terdaftar sebagai admin di .env');
            return;
        }

        // Map LID → owner number
        this.ownerLidMapping[from] = phoneInput;
        this.saveOwnerLidMapping();

        console.log(`👑 Admin registered: ${from} -> ${phoneInput}`);
        await this.sendMessage(from,
            `✅ Admin berhasil terdaftar!\n` +
            `📱 LID: ${from}\n` +
            `📞 Nomor: ${phoneInput}\n\n` +
            `Sekarang kamu bisa pakai semua command admin.\nKetik /menu untuk melihat daftar command.`);
    }

    // ========== ADMIN COMMAND HANDLERS ==========

    async handleAdd(from, args) {
        if (args.length < 3) {
            await this.sendMessage(from, '❌ Format salah!\n\n' +
                '✅ Format: /add email password 2fa_secret\n' +
                'Contoh: /add test@gmail.com pass123 JBSWY3DPEHPK3PXP');
            return;
        }

        const email = args[1];
        const password = args[2];
        const twoFASecret = args[3] || '';

        const result = this.accountManager.addAccount(email, password, twoFASecret);
        await this.sendMessage(from, result.message);
    }

    async handleList(from) {
        const accounts = this.accountManager.listAccounts();

        if (accounts.length === 0) {
            await this.sendMessage(from, '📋 Belum ada akun terdaftar.');
            return;
        }

        let message = '📋 *DAFTAR AKUN GPT*\n';

        accounts.forEach((acc, index) => {
            const members = this.memberManager.getMembersByAccount(acc.id);
            message += `\n━━━━━━━━━━━━━━━━━━\n`;
            message += `*${index + 1}. ${acc.email}*\n`;
            message += `📊 Status: ${acc.status === 'active' ? '✅ Active' : '🔴 Full'}\n`;
            message += `📨 Slot: ${acc.inviteCount}/${acc.maxInvites}\n`;
            message += `🔐 Session: ${this.accountManager.hasSession(acc.id) ? '✅' : '❌'}\n`;

            if (members.length > 0) {
                message += `\n👥 *Member Aktif (${members.length}):*\n`;
                members.forEach((m, i) => {
                    const timeLeft = this.memberManager.getTimeRemaining(m);
                    message += `   ${i + 1}. ${m.userEmail}\n`;
                    message += `      📅 ${m.plan === '1month' ? '1 Bulan' : '1 Minggu'} | ⏳ Sisa: ${timeLeft}\n`;
                });
            } else {
                message += `\n👥 Belum ada member\n`;
            }
        });

        await this.sendMessage(from, message);
    }

    async handleHapus(from, args) {
        if (args.length < 2) {
            await this.sendMessage(from, '❌ Format: /hapus <email_akun_gpt>\nContoh: /hapus gptaku@email.com');
            return;
        }

        const email = args[1];
        const result = this.accountManager.deleteAccountByEmail(email);
        await this.sendMessage(from, result.message);
    }

    async handleKick(from, args) {
        if (args.length < 2) {
            await this.sendMessage(from, '❌ Format: /kick <email_user>\nContoh: /kick john@gmail.com');
            return;
        }

        const targetEmail = args[1];

        // Cari member di database
        const member = this.memberManager.findMemberByEmail(targetEmail);
        if (!member) {
            await this.sendMessage(from, `❌ Email ${targetEmail} tidak ditemukan di daftar member aktif.`);
            return;
        }

        // Ambil akun GPT yang menampung member ini
        const account = this.accountManager.getAccountById(member.gptAccountId);
        if (!account) {
            await this.sendMessage(from, `❌ Akun GPT ${member.gptAccountEmail} tidak ditemukan.\nMember mungkin perlu di-remove manual.`);
            return;
        }

        await this.sendMessage(from,
            `🔨 Memulai kick ${targetEmail}...\n` +
            `📧 Dari akun: ${account.email}\n` +
            `⏳ Estimasi ~30-60 detik...`);

        const result = await this.chatgptService.kickTeamMember(account, targetEmail);

        if (result.success) {
            // Update member record
            this.memberManager.removeMember(targetEmail);
            // Free up invite slot
            this.accountManager.decrementInviteCount(account.id);

            await this.sendMessage(from,
                `${result.message}\n\n` +
                `📊 Slot akun ${account.email} terbuka: ${account.inviteCount - 1}/${account.maxInvites}`);
        } else {
            await this.sendMessage(from, result.message);
        }
    }

    async handleStats(from) {
        const stats = this.accountManager.getAccountStats();
        const activeMembers = this.memberManager.getAllActiveMembers();
        const expiredSoon = activeMembers.filter(m => {
            const diff = new Date(m.expiresAt).getTime() - Date.now();
            return diff > 0 && diff < 24 * 60 * 60 * 1000; // expires within 24h
        });

        const message = `📊 *STATISTIK BOT*\n\n` +
            `*Akun GPT:*\n` +
            `📝 Total: ${stats.total}\n` +
            `✅ Active: ${stats.active}\n` +
            `🔴 Full: ${stats.full}\n\n` +
            `*Member:*\n` +
            `👥 Aktif: ${activeMembers.length}\n` +
            `⚠️ Expired < 24h: ${expiredSoon.length}\n` +
            `📧 Total Invite: ${stats.totalInvites}`;

        await this.sendMessage(from, message);
    }



    async handleInvite(from, args, userKey) {
        if (args.length < 2) {
            await this.sendMessage(from, '❌ Format salah!\n\n' +
                '✅ Format: /invite email@example.com\n' +
                'Contoh: /invite john@gmail.com');
            return;
        }

        const targetEmail = args[1];

        if (!targetEmail.includes('@')) {
            await this.sendMessage(from, '❌ Format email tidak valid!');
            return;
        }

        const jobId = `job_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
        const job = {
            id: jobId,
            from,
            targetEmail,
            status: 'queued',
            createdAt: new Date().toISOString()
        };

        this.enqueueInvite(job);

        const position = this.inviteQueue.findIndex(item => item.id === jobId) + 1;

        if (position > 1) {
            await this.sendMessage(from, `⏳ Antrian terdeteksi. Posisi kamu: ${position}`);
        }

        this.processQueue();
    }

    async processInvite(job) {
        const from = job.from;
        const phoneNumber = from.split('@')[0];
        const userKey = await this.getUserKey(from, phoneNumber);
        const targetEmail = job.targetEmail;

        if (!targetEmail || !targetEmail.includes('@')) {
            await this.sendMessage(from, '❌ Format email tidak valid!');
            return;
        }

        // Check user limit
        const canInvite = this.userManager.canInvite(userKey);
        if (!canInvite) {
            const userStats = this.userManager.getUserStats(userKey);
            const resetTime = new Date();
            resetTime.setDate(resetTime.getDate() + 1);
            resetTime.setHours(0, 0, 0, 0);

            await this.sendMessage(from,
                `❌ *Limit Invite Habis!*\n\n` +
                `📊 Plan: ${userStats.type.toUpperCase()}\n` +
                `📧 Terpakai: ${userStats.usedToday}/${userStats.dailyLimit}\n` +
                `⏰ Reset: Besok jam 00:00\n\n` +
                `💎 Upgrade ke Premium untuk 10 invite/hari!\n` +
                `Hubungi owner untuk upgrade.`
            );
            return;
        }

        // Get available account
        const account = this.accountManager.getAvailableAccount();

        if (!account) {
            await this.sendMessage(from,
                '🚧 *MAINTENANCE*\n\n' +
                'Saat ini semua akun GPT sedang penuh (limit invite habis).\n' +
                'Mohon coba lagi nanti atau hubungi owner.');
            return;
        }

        const hasSession = this.accountManager.hasSession(account.id);
        if (hasSession) {
            await this.sendMessage(from, `🔄 Memproses invite ke ${targetEmail}...\n` +
                `🆔 Menggunakan akun: ${account.id}\n` +
                `📊 Invite count: ${account.inviteCount + 1}/${account.maxInvites}\n\n` +
                `⏳ Estimasi ~30 detik...`);
        } else {
            await this.sendMessage(from, `🔄 Memproses invite ke ${targetEmail}...\n` +
                `🆔 Menggunakan akun: ${account.id}\n` +
                `📊 Invite count: ${account.inviteCount + 1}/${account.maxInvites}\n\n` +
                `🔐 Login akun pertama kali, estimasi ~1 menit...`);
        }

        const result = await this.chatgptService.inviteTeamMember(account, targetEmail);

        if (result.success) {
            // Increment user usage
            this.userManager.incrementUsage(userKey);
            const userStats = this.userManager.getUserStats(userKey);

            // Save member record with subscription timer
            const userPlan = userStats.type === 'premium' ? '1month' : '1week';
            const memberRecord = this.memberManager.addMember(
                targetEmail,
                account.id,
                account.email,
                userPlan
            );

            const updatedAccount = this.accountManager.getAccountById(account.id);
            let statusMessage = result.message;

            // Member info
            const timeLeft = this.memberManager.getTimeRemaining(memberRecord);
            statusMessage += `\n\n📋 *Detail Langganan*`;
            statusMessage += `\n📅 Plan: ${userPlan === '1month' ? '1 Bulan' : '1 Minggu'}`;
            statusMessage += `\n⏳ Aktif sampai: ${new Date(memberRecord.expiresAt).toLocaleDateString('id-ID')}`;
            statusMessage += `\n⏰ Sisa waktu: ${timeLeft}`;

            // User stats
            statusMessage += `\n\n📊 *Your Stats Today*`;
            statusMessage += `\n📧 Used: ${userStats.usedToday}/${userStats.dailyLimit}`;
            statusMessage += `\n⏳ Remaining: ${userStats.remaining}`;
            statusMessage += `\n💎 Plan: ${userStats.type.toUpperCase()}`;

            if (updatedAccount && updatedAccount.inviteCount >= updatedAccount.maxInvites) {
                statusMessage += `\n\n⚠️ Akun ${account.email} sudah penuh (${updatedAccount.inviteCount}/${updatedAccount.maxInvites})`;

                const nextAccount = this.accountManager.getAvailableAccount();
                if (nextAccount) {
                    statusMessage += `\n✅ Invite berikutnya akan menggunakan: ${nextAccount.email}`;
                } else {
                    statusMessage += `\n❌ Tidak ada akun tersedia lagi!`;
                }
            }

            await this.sendMessage(from, statusMessage);
        } else {
            // Check if error is due to ChatGPT being down
            if (result.message.includes('down') || result.message.includes('timeout')) {
                // Try with another account if available
                const nextAccount = this.accountManager.getAvailableAccount();

                if (nextAccount && nextAccount.id !== account.id) {
                    await this.sendMessage(from,
                        `${result.message}\n\n` +
                        `🔄 Mencoba dengan akun lain: ${nextAccount.email}...`);

                    // Retry with different account
                    const retryResult = await this.chatgptService.inviteTeamMember(nextAccount, targetEmail);

                    if (retryResult.success) {
                        this.userManager.incrementUsage(userKey);
                        const userStats = this.userManager.getUserStats(userKey);

                        await this.sendMessage(from,
                            `${retryResult.message}\n\n` +
                            `📊 Used: ${userStats.usedToday}/${userStats.dailyLimit}\n` +
                            `💎 Plan: ${userStats.type.toUpperCase()}`);
                    } else {
                        await this.sendMessage(from,
                            `❌ Retry juga gagal: ${retryResult.message}\n\n` +
                            `💡 ChatGPT mungkin sedang maintenance. Coba lagi dalam 5-10 menit.`);
                    }
                } else {
                    await this.sendMessage(from,
                        `${result.message}\n\n` +
                        `💡 Tidak ada akun backup. Coba lagi dalam beberapa menit.`);
                }
            } else {
                await this.sendMessage(from, result.message);
            }
        }
    }

    async handleStatusCheck(from, userKey) {
        const accountStats = this.accountManager.getAccountStats();
        const userStats = this.userManager.getUserStats(userKey);
        const allUserStats = this.userManager.getAllStats();
        const isFree = userStats.type === 'free';

        const message = `📊 *STATUS BOT*\n\n` +
            `*Account Status:*\n` +
            `✅ Akun Head ChatGPT: ${accountStats.active}/${accountStats.total}\n` +
            `🔴 Akun Penuh: ${accountStats.full}\n` +
            `📧 Total Invite: ${allUserStats.totalInvitesAll}\n` +
            `👥 Total User: ${allUserStats.totalUsers}\n\n` +
            `*Your Status:*\n` +
            `💎 Plan: ${userStats.type.toUpperCase()}\n` +
            (isFree ?
                `📊 Kuota: ${userStats.remaining}/1\n` :
                `📊 Hari ini: ${userStats.usedToday}/${userStats.dailyLimit}\n`
            ) +
            `🎯 Total Invites: ${userStats.totalInvites}\n\n` +
            `💡 Gunakan /invite email@example.com untuk invite`;

        await this.sendMessage(from, message);
    }

    async handleMyPlan(from, userKey) {
        const userStats = this.userManager.getUserStats(userKey);
        const isFree = userStats.type === 'free';
        const ownerNum = this.ownerNumbers[0] || '-';
        const lid = userKey.replace('@s.whatsapp.net', '').replace('@lid', '');

        let message = `💎 *YOUR PLAN*\n\n`;
        message += `🆔 ID: ${lid}\n`;
        message += `💼 Plan: ${userStats.type.toUpperCase()}\n`;

        if (isFree) {
            message += `📊 Kuota: ${userStats.remaining}/1\n`;
        } else {
            message += `📊 Limit: ${userStats.dailyLimit} invite/hari\n`;
            message += `📧 Hari ini: ${userStats.usedToday}/${userStats.dailyLimit}\n`;
        }

        message += `🎯 Total Invites: ${userStats.totalInvites}\n`;

        if (userStats.expiresAt) {
            const expiry = new Date(userStats.expiresAt);
            message += `⏰ Expires: ${expiry.toLocaleDateString('id-ID')}\n`;
        }

        if (isFree) {
            message += `\n💡 *Upgrade Premium*`;
            message += `\n✨ 5 invites per hari`;
            message += `\n✨ Invite ChatGPT: 1 bulan`;
            message += `\n📞 Hubungi owner: wa.me/${ownerNum}`;
        }

        await this.sendMessage(from, message);
    }

    // Owner commands for user management
    async handleSetPremium(from, args) {
        // Format: /setpremium <lid> [duration_days]
        if (args.length < 2) {
            await this.sendMessage(from,
                '❌ Format: /setpremium <lid> [days]\n\n' +
                'Contoh:\n' +
                '/setpremium 55194691838033 30 (premium 30 hari)\n' +
                '/setpremium 55194691838033 (lifetime premium)\n\n' +
                '💡 Lihat LID user di /members');
            return;
        }

        const targetId = args[1].replace(/\D/g, '');
        const durationDays = args[2] ? parseInt(args[2]) : null;

        // Cari user — bisa @lid atau @s.whatsapp.net
        const data = this.userManager.loadUsers();
        const targetUser = data.users.find(u =>
            u.phone === `${targetId}@lid` ||
            u.phone === `${targetId}@s.whatsapp.net` ||
            u.phone.split('@')[0] === targetId
        );

        if (!targetUser) {
            await this.sendMessage(from, `❌ User dengan ID ${targetId} tidak ditemukan. Cek /members.`);
            return;
        }

        const user = this.userManager.setPremium(targetUser.phone, durationDays);
        const name = targetUser.pushName || 'Unknown';

        let message = `✅ User berhasil di-upgrade ke PREMIUM!\n\n`;
        message += `👤 Nama: ${name}\n`;
        message += `🆔 ID: ${targetId}\n`;
        message += `💎 Plan: PREMIUM\n`;
        message += `📊 Daily Limit: 5 invites/hari\n`;

        if (durationDays) {
            const expiry = new Date(user.expiresAt);
            message += `⏰ Expires: ${expiry.toLocaleDateString('id-ID')}`;
        } else {
            message += `⏰ Duration: LIFETIME`;
        }

        await this.sendMessage(from, message);

        // Notify user
        try {
            await this.sendMessage(targetUser.phone,
                `🎉 *SELAMAT!*\n\n` +
                `Akun Anda telah di-upgrade ke *PREMIUM*!\n\n` +
                `✨ Daily Limit: 5 invites/hari\n` +
                `✨ Invite ChatGPT: 1 Bulan\n` +
                (durationDays ? `⏰ Valid hingga: ${new Date(user.expiresAt).toLocaleDateString('id-ID')}` : `⏰ Lifetime Access`) +
                `\n\nTerima kasih! 🙏`
            );
        } catch (e) {
            // User might not have chatted with bot yet
        }
    }

    async handleSetFree(from, args) {
        if (args.length < 2) {
            await this.sendMessage(from,
                '❌ Format: /setfree <lid>\n\n' +
                '💡 Lihat LID user di /members');
            return;
        }

        const targetId = args[1].replace(/\D/g, '');

        const data = this.userManager.loadUsers();
        const targetUser = data.users.find(u =>
            u.phone === `${targetId}@lid` ||
            u.phone === `${targetId}@s.whatsapp.net` ||
            u.phone.split('@')[0] === targetId
        );

        if (!targetUser) {
            await this.sendMessage(from, `❌ User dengan ID ${targetId} tidak ditemukan. Cek /members.`);
            return;
        }

        this.userManager.setFree(targetUser.phone);
        const name = targetUser.pushName || 'Unknown';

        await this.sendMessage(from,
            `✅ ${name} diubah ke FREE plan\n` +
            `📊 Kuota: 1 invite (direset)`);
    }

    async handleMembers(from, args) {
        const filterType = args[1]; // 'free' or 'premium'
        const allUsers = this.userManager.listUsers(filterType);

        if (allUsers.length === 0) {
            await this.sendMessage(from, '📋 Belum ada user terdaftar.');
            return;
        }

        // Kalau tanpa filter, tampilkan 20 user terakhir
        let users;
        if (!filterType) {
            users = allUsers.slice(-20);
        } else {
            users = allUsers.slice(0, 20);
        }

        let message = `📋 *DAFTAR USER*${filterType ? ` (${filterType.toUpperCase()})` : ' (20 terakhir)'}\n\n`;

        users.forEach((user, index) => {
            const name = user.pushName || 'Unknown';
            const lid = user.phone.replace('@s.whatsapp.net', '').replace('@lid', '');
            message += `${index + 1}. ${name}\n`;
            message += `   🆔 ${lid}\n`;
            message += `   💎 ${user.type.toUpperCase()}`;
            if (user.type === 'free') {
                message += ` | 📊 ${user.usedToday}/1\n`;
            } else {
                message += ` | 📊 ${user.usedToday}/${user.dailyLimit} hari ini\n`;
            }
            message += `   🎯 Total: ${user.totalInvites}`;
            if (user.expiresAt) {
                const expiry = new Date(user.expiresAt);
                message += ` | ⏰ ${expiry.toLocaleDateString('id-ID')}`;
            }
            message += `\n`;
        });

        if (allUsers.length > 20) {
            message += `\n... dan ${allUsers.length - 20} user lainnya`;
        }

        message += `\n💡 Pakai LID (ID) untuk /setpremium atau /setfree`;

        await this.sendMessage(from, message);
    }

    async handleLinkMe(from, args) {
        if (from.includes('@s.whatsapp.net')) {
            await this.sendMessage(from, '✅ Akun kamu sudah pakai nomor HP asli. Tidak perlu link.');
            return;
        }

        if (args.length < 2) {
            await this.sendMessage(from, '❌ Format: /linkme <nomor_hp>\nContoh: /linkme 6281234567890');
            return;
        }

        const digits = args[1].replace(/\D/g, '');
        if (digits.length < 7) {
            await this.sendMessage(from, '❌ Nomor tidak valid. Gunakan format seperti 6281234567890');
            return;
        }

        const targetJid = `${digits}@s.whatsapp.net`;
        this.userJidMapping[from] = targetJid;
        this.saveUserJidMapping();

        const mergeResult = this.userManager.mergeUsers(from, targetJid);
        const mergeMessage = mergeResult.success
            ? '✅ Data akun berhasil disinkronkan.'
            : `⚠️ Link berhasil, tapi merge data gagal: ${mergeResult.message}`;

        await this.sendMessage(from,
            `✅ Link berhasil!\n` +
            `Sekarang akun kamu dikenali sebagai: ${digits}\n\n` +
            `${mergeMessage}`);
    }

    async handleUserStats(from) {
        const stats = this.userManager.getAllStats();

        const message = `📊 *USER STATISTICS*\n\n` +
            `👥 Total Users: ${stats.totalUsers}\n` +
            `🆓 Free Users: ${stats.freeUsers}\n` +
            `💎 Premium Users: ${stats.premiumUsers}\n` +
            `📧 Invites Today: ${stats.totalInvitesToday}\n` +
            `🎯 Total Invites: ${stats.totalInvitesAll}`;

        await this.sendMessage(from, message);
    }

    async handleBroadcast(from, args) {
        if (args.length < 2) {
            await this.sendMessage(from, '❌ Format: /broadcast <pesan>\nContoh: /broadcast Maintenance jam 3 sore');
            return;
        }

        const broadcastMessage = args.slice(1).join(' ');
        const allUsers = this.userManager.listUsers();

        if (allUsers.length === 0) {
            await this.sendMessage(from, '📋 Belum ada user terdaftar.');
            return;
        }

        await this.sendMessage(from, `📢 Mengirim broadcast ke ${allUsers.length} user...`);

        let sent = 0;
        let failed = 0;

        for (const user of allUsers) {
            try {
                await this.sendMessage(user.phone,
                    `📢 *BROADCAST*\n\n${broadcastMessage}`);
                sent++;
                // Delay antar pesan supaya tidak kena rate limit
                await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (e) {
                failed++;
            }
        }

        await this.sendMessage(from,
            `✅ Broadcast selesai!\n` +
            `📧 Terkirim: ${sent}\n` +
            `❌ Gagal: ${failed}`);
    }

    async sendOwnerHelp(from) {
        const help = `🤖 *MENU ADMIN*\n\n` +
            `*Akun ChatGPT:*\n` +
            `/add <email> <password> <2fa>\n` +
            `/list - Lihat akun + member\n` +
            `/hapus <email> - Hapus akun\n` +
            `/kick <email_user> - Kick member\n` +
            `/stats - Statistik bot\n\n` +
            `*Manajemen User:*\n` +
            `/setpremium <lid> [days]\n` +
            `/setfree <lid> - Reset kuota free\n` +
            `/members [free/premium]\n` +
            `/userstats\n` +
            `/broadcast <pesan>\n\n` +
            `*User Commands:*\n` +
            `/invite <email> - Invite member\n` +
            `/status - Status bot\n` +
            `/myplan - Plan info\n` +
            `/linkme <nomor> - Link LID ke nomor HP\n\n` +
            `⏰ Auto-kick expired | WIB timezone`;

        await this.sendMessage(from, help);
    }

    async sendUserHelp(from, userKey) {
        const userStats = this.userManager.getUserStats(userKey);
        const isFree = userStats.type === 'free';
        const ownerNum = this.ownerNumbers[0] || '-';

        const help = `🤖 *CHATGPT AUTO INVITE BOT*\n\n` +
            `Halo! Saya bot untuk invite member ke ChatGPT Team.\n\n` +
            `*Your Plan:*\n` +
            `💎 ${userStats.type.toUpperCase()}\n` +
            (isFree ?
                `📊 Kuota: ${userStats.remaining}/1\n` :
                `📊 Limit: ${userStats.dailyLimit} invite/hari\n` +
                `📧 Hari ini: ${userStats.usedToday}/${userStats.dailyLimit}\n`
            ) +
            `\n*Commands:*\n` +
            `/invite <email> - Invite member\n` +
            `/status - Cek status bot\n` +
            `/myplan - Lihat plan\n` +
            `/menu - Menu ini\n\n` +
            `*Contoh:*\n` +
            `/invite john@example.com\n\n` +
            (isFree ?
                `💡 *Upgrade Premium*\n` +
                `✨ 5 invites per hari\n` +
                `✨ Invite ChatGPT: 1 bulan\n` +
                `📞 Hubungi owner: wa.me/${ownerNum}` :
                `🎉 Anda user PREMIUM! Terima kasih!`);

        await this.sendMessage(from, help);
    }

    async sendWelcome(from, userKey) {
        const userStats = this.userManager.getUserStats(userKey);
        const isFree = userStats.type === 'free';

        const welcome = `👋 *SELAMAT DATANG!*\n\n` +
            `🤖 *ChatGPT Auto Invite Bot*\n\n` +
            `Saya dapat membantu Anda mengirim invite ke ChatGPT Team secara otomatis!\n\n` +
            `*Your Status:*\n` +
            `💎 Plan: ${userStats.type.toUpperCase()}\n` +
            (isFree ?
                `📊 Kuota: 1 invite (Invite ChatGPT: 1 minggu)\n` :
                `📊 Limit: ${userStats.dailyLimit} invite/hari (Invite ChatGPT: 1 bulan)\n`
            ) +
            `\n*Cara Pakai:*\n` +
            `Kirim: /invite email@example.com\n\n` +
            `*Lihat Menu:*\n` +
            `Kirim: /menu\n\n` +
            `Selamat menggunakan! 🚀`;

        await this.sendMessage(from, welcome);
    }

    async sendMessage(jid, text) {
        try {
            await this.sock.sendMessage(jid, { text });
        } catch (error) {
            console.error('❌ Error sending message:', error);
        }
    }

    // ========== AUTO-KICK TIMER ==========

    startAutoKickTimer() {
        // Check every 1 hour for expired members
        const CHECK_INTERVAL = 60 * 60 * 1000; // 1 hour

        console.log('⏰ Auto-kick timer dimulai (cek setiap 1 jam)');

        setInterval(async () => {
            await this.processExpiredMembers();
        }, CHECK_INTERVAL);

        // Also check immediately on start
        setTimeout(async () => {
            await this.processExpiredMembers();
        }, 10000); // 10 seconds after boot
    }

    async processExpiredMembers() {
        const expiredMembers = this.memberManager.getExpiredMembers();

        if (expiredMembers.length === 0) return;

        console.log(`⏰ Ditemukan ${expiredMembers.length} member expired, memproses kick...`);

        // Notify owners
        const ownerJid = this.ownerNumbers[0] ? `${this.ownerNumbers[0]}@s.whatsapp.net` : null;

        for (const member of expiredMembers) {
            console.log(`🔨 Auto-kick: ${member.userEmail} (expired ${member.plan})`);

            const account = this.accountManager.getAccountById(member.gptAccountId);

            if (!account) {
                console.log(`⚠️ Akun GPT ${member.gptAccountEmail} tidak ditemukan, skip kick, mark as removed`);
                this.memberManager.removeMember(member.userEmail);
                continue;
            }

            try {
                const result = await this.chatgptService.kickTeamMember(account, member.userEmail);

                if (result.success) {
                    this.memberManager.removeMember(member.userEmail);
                    this.accountManager.decrementInviteCount(account.id);

                    console.log(`✅ Auto-kick berhasil: ${member.userEmail}`);

                    if (ownerJid) {
                        await this.sendMessage(ownerJid,
                            `⏰ *AUTO-KICK*\n\n` +
                            `📧 ${member.userEmail}\n` +
                            `📅 Plan: ${member.plan === '1month' ? '1 Bulan' : '1 Minggu'}\n` +
                            `✅ Berhasil di-remove dari ${account.email}\n` +
                            `📊 Slot terbuka: ${account.inviteCount - 1}/${account.maxInvites}`);
                    }
                } else {
                    console.log(`❌ Auto-kick gagal: ${member.userEmail} - ${result.message}`);

                    if (ownerJid) {
                        await this.sendMessage(ownerJid,
                            `⚠️ *AUTO-KICK GAGAL*\n\n` +
                            `📧 ${member.userEmail}\n` +
                            `❌ ${result.message}\n\n` +
                            `💡 Gunakan /kick ${member.userEmail} untuk coba manual.`);
                    }
                }
            } catch (error) {
                console.error(`❌ Error auto-kick ${member.userEmail}:`, error.message);
            }

            // Wait between kicks to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
}

// Start bot
console.log('🚀 Starting WhatsApp Bot...\n');

const bot = new WhatsAppBot();
bot.start().catch(err => {
    console.error('❌ Error starting bot:', err);
    process.exit(1);
});
