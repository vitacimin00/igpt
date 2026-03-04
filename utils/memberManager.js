import fs from 'fs';

class MemberManager {
    constructor() {
        this.membersFile = 'data/members.json';
        this.ensureFile();
    }

    ensureFile() {
        if (!fs.existsSync('data')) {
            fs.mkdirSync('data', { recursive: true });
        }
        if (!fs.existsSync(this.membersFile)) {
            fs.writeFileSync(this.membersFile, JSON.stringify({ members: [] }, null, 2));
        }
    }

    loadMembers() {
        try {
            const data = JSON.parse(fs.readFileSync(this.membersFile, 'utf8'));
            if (!data || !Array.isArray(data.members)) {
                return { members: [] };
            }
            return data;
        } catch (e) {
            return { members: [] };
        }
    }

    saveMembers(data) {
        fs.writeFileSync(this.membersFile, JSON.stringify(data, null, 2));
    }

    /**
     * Tambah member baru setelah invite berhasil
     * @param {string} userEmail - email user yang diinvite
     * @param {string} gptAccountId - ID akun GPT yang dipakai
     * @param {string} gptAccountEmail - email akun GPT
     * @param {string} plan - '1week' atau '1month'
     */
    addMember(userEmail, gptAccountId, gptAccountEmail, plan = '1week') {
        const data = this.loadMembers();

        const durationMs = plan === '1month'
            ? 30 * 24 * 60 * 60 * 1000
            : 7 * 24 * 60 * 60 * 1000;

        const now = new Date();
        const member = {
            userEmail,
            gptAccountId,
            gptAccountEmail,
            invitedAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + durationMs).toISOString(),
            plan,
            status: 'active'
        };

        data.members.push(member);
        this.saveMembers(data);
        return member;
    }

    /**
     * Cari member berdasarkan email user
     */
    findMemberByEmail(userEmail) {
        const data = this.loadMembers();
        return data.members.find(m =>
            m.userEmail.toLowerCase() === userEmail.toLowerCase() && m.status === 'active'
        );
    }

    /**
     * Ambil semua member aktif untuk akun GPT tertentu
     */
    getMembersByAccount(gptAccountId) {
        const data = this.loadMembers();
        return data.members.filter(m => m.gptAccountId === gptAccountId && m.status === 'active');
    }

    /**
     * Ambil member yang sudah expired
     */
    getExpiredMembers() {
        const data = this.loadMembers();
        const now = new Date();
        return data.members.filter(m =>
            m.status === 'active' && new Date(m.expiresAt) <= now
        );
    }

    /**
     * Update status member jadi 'removed'
     */
    removeMember(userEmail) {
        const data = this.loadMembers();
        const member = data.members.find(m =>
            m.userEmail.toLowerCase() === userEmail.toLowerCase() && m.status === 'active'
        );

        if (member) {
            member.status = 'removed';
            member.removedAt = new Date().toISOString();
            this.saveMembers(data);
            return { success: true, member };
        }

        return { success: false, message: 'Member tidak ditemukan atau sudah di-remove.' };
    }

    /**
     * Ambil semua member aktif
     */
    getAllActiveMembers() {
        const data = this.loadMembers();
        return data.members.filter(m => m.status === 'active');
    }

    /**
     * Hitung sisa waktu member
     */
    getTimeRemaining(member) {
        const now = new Date();
        const expires = new Date(member.expiresAt);
        const diffMs = expires.getTime() - now.getTime();

        if (diffMs <= 0) return 'Expired';

        const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));
        const hours = Math.floor((diffMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));

        if (days > 0) return `${days}h ${hours}j`;
        return `${hours}j`;
    }
}

export default MemberManager;
