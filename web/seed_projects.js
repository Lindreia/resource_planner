const { getConnection } = require("../database");
const db = getConnection();

async function seedProjects() {
    console.log("Seeding projects...");

    // Clear old data
    await db.query("DELETE FROM projects;");

    const projects = [
        ["PRJ001", "Website Redesign", "Client A", "#FF5733"],
        ["PRJ002", "Mobile App", "Client B", "#33C1FF"],
        ["PRJ003", "Data Migration", "Client C", "#75FF33"],
        ["PRJ004", "System Upgrade", "Client A", "#FFC300"],
        ["PRJ005", "Analytics Dashboard", "Client D", "#C70039"]
    ];

    for (const project of projects) {
        await db.query(
            `
            INSERT INTO projects (project_code, project_name, client, color)
            VALUES ($1, $2, $3, $4)
        `,
            project
        );
    }

    console.log("Projects added successfully!");
}

module.exports = { seedProjects };
