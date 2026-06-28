const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const { requireLogin } = require("./web/authMiddleware");
const { requireRole } = require("./web/authRole");
const User = require("./web/user_model");

// -----------------------------------------
// ADMIN DASHBOARD
// -----------------------------------------
router.get(
    "/dashboard",
    requireLogin,
    requireRole("admin"),
    async (req, res) => {
        res.render("admin-dashboard", { user: req.session.user });
    }
);

// -----------------------------------------
// LIST USERS
// -----------------------------------------
router.get(
    "/users",
    requireLogin,
    requireRole("admin"),
    async (req, res) => {
        const users = await User.all();
        res.render("admin-users", { users, user: req.session.user });
    }
);

// -----------------------------------------
// ADD USER (FORM)
// -----------------------------------------
router.get(
    "/users/add",
    requireLogin,
    requireRole("admin"),
    (req, res) => {
        res.render("admin-add-user", { error: null, user: req.session.user });
    }
);

// -----------------------------------------
// ADD USER (SUBMIT)
// -----------------------------------------
router.post(
    "/users/add",
    requireLogin,
    requireRole("admin"),
    async (req, res) => {
        const { name, email, password, role, weekly_capacity } = req.body;

        try {
            await User.create(name, email, password, role, weekly_capacity);
            res.redirect("/admin/users");
        } catch (err) {
            console.error("Add user error:", err);
            res.render("admin-add-user", {
                error: "Could not create user",
                user: req.session.user
            });
        }
    }
);

// -----------------------------------------
// EDIT USER (FORM)
// -----------------------------------------
router.get(
    "/users/edit/:id",
    requireLogin,
    requireRole("admin"),
    async (req, res) => {
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).send("User not found");

        res.render("admin-edit-user", { user, error: null });
    }
);

// -----------------------------------------
// EDIT USER (SUBMIT)
// -----------------------------------------
router.post(
    "/users/edit/:id",
    requireLogin,
    requireRole("admin"),
    async (req, res) => {
        const { name, email, role, weekly_capacity } = req.body;

        try {
            await User.update(req.params.id, {
                name,
                email,
                role,
                weekly_capacity
            });

            res.redirect("/admin/users");
        } catch (err) {
            console.error("Edit user error:", err);
            const user = await User.findById(req.params.id);

            res.render("admin-edit-user", {
                user,
                error: "Could not update user"
            });
        }
    }
);

// -----------------------------------------
// DELETE USER
// -----------------------------------------
router.post(
    "/users/delete/:id",
    requireLogin,
    requireRole("admin"),
    async (req, res) => {
        try {
            await User.delete(req.params.id);
            res.redirect("/admin/users");
        } catch (err) {
            console.error("Delete user error:", err);
            res.status(500).send("Could not delete user");
        }
    }
);

// -----------------------------------------
// UNLOCK USER
// -----------------------------------------
router.post(
    "/users/unlock/:id",
    requireLogin,
    requireRole("admin"),
    async (req, res) => {
        try {
            await User.unlockAccount(req.params.id);
            res.redirect("/admin/users");
        } catch (err) {
            console.error("Unlock user error:", err);
            res.status(500).send("Could not unlock user");
        }
    }
);

module.exports = router;
