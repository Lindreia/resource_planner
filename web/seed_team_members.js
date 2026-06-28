const bcrypt = require("bcryptjs");
const { getConnection } = require("../database");
const db = getConnection();

async function seedTeamMembers() {
    console.log("Seeding team members...");

    // Clear existing users EXCEPT admin accounts if you want
    await db.query(`DELETE FROM users;`);

    const team = [
        { name: "Sasha", email: "sasha@example.com", capacity: 40, role: "staff" },
        { name: "Peter", email: "peter@example.com", capacity: 40, role: "staff" },
        { name: "Lappies", email: "lappies@example.com", capacity: 40, role: "staff" },
        { name: "Team Member 4", email: "tm4@example.com", capacity: 40, role: "staff" },
        { name: "Team Member 5", email: "tm5@example.com", capacity: 40, role: "staff" },
        { name: "Admin1", email: "admin1@example.com", capacity: 40, role: "admin" },
        { name: "Admin2", email: "admin2@example.com", capacity: 40, role: "admin" }
    ];

    for (const member of team) {
        const passwordHash = await bcrypt.hash("password123", 12);

        await db.query(
            `
            INSERT INTO users (name, email, password_hash, role, weekly_capacity)
            VALUES ($1, $2, $3, $4, $5)
        `,
            [
                member.name,
                member.email,
                passwordHash,
                member.role,
                member.capacity
            ]
        );
    }

    console.log("Team members added successfully!");
}

module.exports = { seedTeamMembers };
