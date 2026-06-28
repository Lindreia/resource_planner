const { getConnection } = require("../database");
const db = getConnection();

class Project {
    constructor(row) {
        this.id = row.id;
        this.project_code = row.project_code;
        this.project_name = row.project_name;
        this.client = row.client;
        this.color = row.color;
    }

    // ----------------------------------------------------
    // CREATE PROJECT
    // ----------------------------------------------------
    static async create(project_code, project_name, client = null, color = null) {
        const query = `
            INSERT INTO projects (project_code, project_name, client, color)
            VALUES ($1, $2, $3, $4)
            RETURNING *
        `;

        const result = await db.query(query, [
            project_code,
            project_name,
            client,
            color
        ]);

        return new Project(result.rows[0]);
    }

    // ----------------------------------------------------
    // GET ALL PROJECTS
    // ----------------------------------------------------
    static async all() {
        const query = `
            SELECT *
            FROM projects
            ORDER BY project_code
        `;

        const result = await db.query(query);
        return result.rows.map(row => new Project(row));
    }

    // ----------------------------------------------------
    // FIND BY ID
    // ----------------------------------------------------
    static async findById(id) {
        const query = `
            SELECT *
            FROM projects
            WHERE id = $1
        `;

        const result = await db.query(query, [id]);
        if (result.rows.length === 0) return null;

        return new Project(result.rows[0]);
    }

    // ----------------------------------------------------
    // UPDATE PROJECT
    // ----------------------------------------------------
    static async update(id, fields) {
        const allowed = ["project_code", "project_name", "client", "color"];
        const updates = [];
        const values = [];
        let index = 1;

        for (const key of allowed) {
            if (fields[key] !== undefined) {
                updates.push(`${key} = $${index}`);
                values.push(fields[key]);
                index++;
            }
        }

        if (updates.length === 0) return null;

        const query = `
            UPDATE projects
            SET ${updates.join(", ")}
            WHERE id = $${index}
            RETURNING *
        `;

        values.push(id);

        const result = await db.query(query, values);
        return new Project(result.rows[0]);
    }

    // ----------------------------------------------------
    // DELETE PROJECT
    // ----------------------------------------------------
    static async delete(id) {
        const query = `
            DELETE FROM projects
            WHERE id = $1
        `;
        await db.query(query, [id]);
        return true;
    }
}

module.exports = Project;
