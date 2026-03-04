import fs from 'fs';
import path from 'path';

class UserManager {
    constructor() {
        this.usersFile = 'data/users.json';
        this.ensureFile();
    }

    /**
     * Get today's date in WIB (UTC+7) timezone — YYYY-MM-DD
     */
    getTodayWIB() {
        const now = new Date();
        const wib = new Date(now.getTime() + (7 * 60 * 60 * 1000));
        return wib.toISOString().split('T')[0];
    }

    ensureFile() {
        if (!fs.existsSync('data')) {
            fs.mkdirSync('data', { recursive: true });
        }

        if (!fs.existsSync(this.usersFile)) {
            fs.writeFileSync(this.usersFile, JSON.stringify({ users: [] }, null, 2));
        }
    }

    loadUsers() {
        try {
            const data = fs.readFileSync(this.usersFile, 'utf8');
            const parsed = JSON.parse(data);
            const normalized = this.normalizeUsers(parsed);
            if (normalized.changed) {
                this.saveUsers(normalized.data);
            }
            return normalized.data;
        } catch (error) {
            return { users: [] };
        }
    }

    saveUsers(data) {
        fs.writeFileSync(this.usersFile, JSON.stringify(data, null, 2));
    }

    normalizeUsers(data) {
        if (!data || !Array.isArray(data.users)) {
            return { data: { users: [] }, changed: true };
        }

        const byPhone = new Map();
        let changed = false;

        for (const user of data.users) {
            if (!user || !user.phone) {
                changed = true;
                continue;
            }

            const existing = byPhone.get(user.phone);
            if (!existing) {
                byPhone.set(user.phone, { ...user });
                continue;
            }

            const today = new Date().toISOString().split('T')[0];
            const aReset = existing.lastReset || '';
            const bReset = user.lastReset || '';
            const lastReset = aReset >= bReset ? aReset : bReset;

            let usedToday = 0;
            if (aReset === lastReset) {
                usedToday = Math.max(usedToday, existing.usedToday || 0);
            }
            if (bReset === lastReset) {
                usedToday = Math.max(usedToday, user.usedToday || 0);
            }

            const isPremium = existing.type === 'premium' || user.type === 'premium';
            let dailyLimit = Math.max(existing.dailyLimit || 0, user.dailyLimit || 0);
            if (isPremium) {
                dailyLimit = Math.max(dailyLimit, 5);
            } else if (dailyLimit === 0) {
                dailyLimit = 1;
            }

            const totalInvites = (existing.totalInvites || 0) + (user.totalInvites || 0);

            let expiresAt = existing.expiresAt || null;
            if (user.expiresAt) {
                if (!expiresAt || new Date(user.expiresAt) > new Date(expiresAt)) {
                    expiresAt = user.expiresAt;
                }
            }

            const createdAt = existing.createdAt && user.createdAt
                ? (new Date(existing.createdAt) < new Date(user.createdAt)
                    ? existing.createdAt
                    : user.createdAt)
                : (existing.createdAt || user.createdAt || new Date().toISOString());

            byPhone.set(user.phone, {
                phone: user.phone,
                type: isPremium ? 'premium' : 'free',
                dailyLimit,
                usedToday: lastReset === today ? usedToday : 0,
                totalInvites,
                lastReset: lastReset || today,
                createdAt,
                expiresAt
            });

            changed = true;
        }

        return { data: { users: Array.from(byPhone.values()) }, changed };
    }

    getUser(phone) {
        const data = this.loadUsers();
        let user = data.users.find(u => u.phone === phone);

        // Auto create user jika belum ada (default: free)
        if (!user) {
            user = {
                phone,
                pushName: 'Unknown',
                type: 'free',
                dailyLimit: 1,       // free = 1 invite TOTAL
                usedToday: 0,
                totalInvites: 0,
                lastReset: this.getTodayWIB(),
                createdAt: new Date().toISOString(),
                expiresAt: null
            };
            data.users.push(user);
            this.saveUsers(data);
        }

        // Daily reset HANYA untuk premium, pakai WIB
        // Free user TIDAK pernah reset — 1 invite total seumur hidup
        const todayWIB = this.getTodayWIB();
        if (user.type === 'premium' && user.lastReset !== todayWIB) {
            user.usedToday = 0;
            user.lastReset = todayWIB;
            this.updateUser(phone, user);
        }

        // Check premium expiry
        if (user.type === 'premium' && user.expiresAt) {
            const now = new Date();
            const expiry = new Date(user.expiresAt);
            if (now > expiry) {
                // Downgrade to free, tapi kuota TIDAK direset
                user.type = 'free';
                user.dailyLimit = 1;
                user.expiresAt = null;
                this.updateUser(phone, user);
            }
        }

        return user;
    }

    updateUser(phone, updates) {
        const data = this.loadUsers();
        const index = data.users.findIndex(u => u.phone === phone);

        if (index !== -1) {
            data.users[index] = { ...data.users[index], ...updates };
            this.saveUsers(data);
            return true;
        }

        return false;
    }

    updatePushName(phone, pushName) {
        if (!pushName || pushName === 'Unknown') return;
        const data = this.loadUsers();
        const user = data.users.find(u => u.phone === phone);
        if (user && user.pushName !== pushName) {
            user.pushName = pushName;
            this.saveUsers(data);
        }
    }

    getUserByIndex(index, filterType = null) {
        const users = this.listUsers(filterType);
        if (index < 1 || index > users.length) return null;
        return users[index - 1];
    }

    incrementUsage(phone) {
        const user = this.getUser(phone);
        user.usedToday++;
        user.totalInvites++;
        this.updateUser(phone, user);
        return user;
    }

    canInvite(phone) {
        const user = this.getUser(phone);
        return user.usedToday < user.dailyLimit;
    }

    getRemainingInvites(phone) {
        const user = this.getUser(phone);
        return Math.max(0, user.dailyLimit - user.usedToday);
    }

    setPremium(phone, durationDays = null) {
        const user = this.getUser(phone);
        user.type = 'premium';
        user.dailyLimit = 5;  // 5 invite/hari
        user.usedToday = 0;   // Reset counter saat upgrade
        user.lastReset = this.getTodayWIB();

        if (durationDays) {
            const expiry = new Date();
            expiry.setDate(expiry.getDate() + durationDays);
            user.expiresAt = expiry.toISOString();
        } else {
            user.expiresAt = null; // Lifetime premium
        }

        this.updateUser(phone, user);
        return user;
    }

    setFree(phone) {
        const user = this.getUser(phone);
        user.type = 'free';
        user.dailyLimit = 1;
        user.usedToday = 0;   // Reset kuota — kasih 1 invite lagi
        user.expiresAt = null;
        this.updateUser(phone, user);
        return user;
    }

    listUsers(filterType = null) {
        const data = this.loadUsers();
        if (filterType) {
            return data.users.filter(u => u.type === filterType);
        }
        return data.users;
    }

    getUserStats(phone) {
        const user = this.getUser(phone);
        const remaining = this.getRemainingInvites(phone);

        return {
            phone: user.phone,
            type: user.type,
            usedToday: user.usedToday,
            dailyLimit: user.dailyLimit,
            remaining,
            totalInvites: user.totalInvites,
            expiresAt: user.expiresAt,
            createdAt: user.createdAt
        };
    }

    getAllStats() {
        const data = this.loadUsers();
        const totalUsers = data.users.length;
        const freeUsers = data.users.filter(u => u.type === 'free').length;
        const premiumUsers = data.users.filter(u => u.type === 'premium').length;
        const totalInvitesToday = data.users.reduce((sum, u) => sum + u.usedToday, 0);
        const totalInvitesAll = data.users.reduce((sum, u) => sum + u.totalInvites, 0);

        return {
            totalUsers,
            freeUsers,
            premiumUsers,
            totalInvitesToday,
            totalInvitesAll
        };
    }

    deleteUser(phone) {
        const data = this.loadUsers();
        const index = data.users.findIndex(u => u.phone === phone);

        if (index !== -1) {
            const user = data.users[index];
            data.users.splice(index, 1);
            this.saveUsers(data);
            return { success: true, user };
        }

        return { success: false, message: 'User tidak ditemukan' };
    }

    setCustomLimit(phone, limit) {
        const user = this.getUser(phone);
        user.dailyLimit = limit;
        this.updateUser(phone, user);
        return user;
    }

    findUserByPhoneDigits(phoneDigits) {
        if (!phoneDigits) {
            return null;
        }

        const data = this.loadUsers();
        const targetDigits = phoneDigits.replace(/\D/g, '');
        if (!targetDigits) {
            return null;
        }

        const targetTail = targetDigits.slice(-8);
        const matches = data.users.filter(user => {
            if (!user || !user.phone) {
                return false;
            }
            const digits = user.phone.replace(/\D/g, '');
            if (!digits) {
                return false;
            }
            return digits.slice(-8) === targetTail;
        });

        if (matches.length === 1) {
            return matches[0].phone;
        }

        if (matches.length > 1) {
            const premiumMatches = matches.filter(u => u.type === 'premium');
            if (premiumMatches.length === 1) {
                return premiumMatches[0].phone;
            }
        }

        return null;
    }

    mergeUsers(sourcePhone, targetPhone) {
        if (sourcePhone === targetPhone) {
            return { success: true, merged: false };
        }

        const data = this.loadUsers();
        const source = data.users.find(u => u.phone === sourcePhone);
        const target = data.users.find(u => u.phone === targetPhone);

        if (!source) {
            return { success: false, message: 'Source user tidak ditemukan' };
        }

        if (!target) {
            source.phone = targetPhone;
            this.saveUsers(data);
            return { success: true, merged: true };
        }

        const today = new Date().toISOString().split('T')[0];
        const sourceUsed = source.lastReset === today ? source.usedToday : 0;
        const targetUsed = target.lastReset === today ? target.usedToday : 0;

        let type = target.type;
        let dailyLimit = target.dailyLimit;
        let expiresAt = target.expiresAt;

        if (source.type === 'premium' && target.type !== 'premium') {
            type = 'premium';
            dailyLimit = Math.max(10, target.dailyLimit);
            expiresAt = source.expiresAt || target.expiresAt;
        } else if (source.type === 'premium' && target.type === 'premium') {
            dailyLimit = Math.max(target.dailyLimit, source.dailyLimit);
            if (source.expiresAt && target.expiresAt) {
                expiresAt = new Date(source.expiresAt) > new Date(target.expiresAt)
                    ? source.expiresAt
                    : target.expiresAt;
            } else {
                expiresAt = target.expiresAt || source.expiresAt;
            }
        }

        const usedToday = Math.min(sourceUsed + targetUsed, dailyLimit);
        const totalInvites = (target.totalInvites || 0) + (source.totalInvites || 0);

        const updated = {
            ...target,
            type,
            dailyLimit,
            usedToday,
            totalInvites,
            lastReset: today,
            expiresAt
        };

        data.users = data.users.filter(u => u.phone !== sourcePhone);
        const targetIndex = data.users.findIndex(u => u.phone === targetPhone);
        if (targetIndex !== -1) {
            data.users[targetIndex] = updated;
        }

        this.saveUsers(data);
        return { success: true, merged: true };
    }
}

export default UserManager;
