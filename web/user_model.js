const { getConnection } = require("../database");
const bcrypt = require("bcryptjs");

const db = getConnection();

class User {
    constructor(row) {
        this.id = row.id;
        this.name = row.name;
        this.email = row.email;
        this.role = row.role;
        this.password_hash = row.password_hash;
        this.failed_attempts = row.failed_attempts;
        this.locked_until = row.locked_until;
    }

    // ----------------------------------------------------
    // CREATE USER
    // ----------------------------------------------------
    static async create(name, email, password, role = "staff") {
        const passwordHash = await bcrypt.hash(password, 12);

        const query = `
            INSERT INTO users (name, email, password_hash, role)
            VALUES ($1, $2, $3, $4)
            RETURNING *
        `;

        const result = await db.query(query, [
            name,
            email,
            passwordHash,
            role
        ]);

        return new User(result.rows[0]);
    }

    // ----------------------------------------------------
    // FIND BY EMAIL
    // ----------------------------------------------------
    static async findByEmail(email) {
        const query = `
            SELECT *
            FROM users
            WHERE email = $1
        `;

        const result = await db.query(query, [email]);

        if (result.rows.length === 0) return null;

        return new User(result.rows[0]);
    }

    // ----------------------------------------------------
    // PASSWORD CHECK
    // ----------------------------------------------------
    async checkPassword(password) {
        return await bcrypt.compare(password, this.password_hash);
    }

    // ----------------------------------------------------
    // UPDATE FAILED ATTEMPTS
    // ----------------------------------------------------
    static async incrementFailedAttempts(userId) {
        const query = `
            UPDATE users
            SET failed_attempts = failed_attempts + 1
            WHERE id = $1
        `;
        await db.query(query, [userId]);
    }

    // ----------------------------------------------------
    // RESET FAILED ATTEMPTS
    // ----------------------------------------------------
    static async resetFailedAttempts(userId) {
        const query = `
            UPDATE users
            SET failed_attempts = 0
            WHERE id = $1
        `;
        await db.query(query, [userId]);
    }

    // ----------------------------------------------------
    // LOCK ACCOUNT
    // ----------------------------------------------------
    static async lockAccount(userId, untilDate) {
        const query = `
            UPDATE users
            SET locked_until = $1
            WHERE id = $2
        `;
        await db.query(query, [untilDate, userId]);
    }

    // ----------------------------------------------------
    // UNLOCK ACCOUNT
    // ----------------------------------------------------
    static async unlockAccount(userId) {
        const query = `
            UPDATE users
            SET locked_until = NULL,
                failed_attempts = 0
            WHERE id = $1
        `;
        await db.query(query, [userId]);
    }
}

module.exports = User;
