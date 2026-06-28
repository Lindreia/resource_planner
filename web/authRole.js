function requireRole(...allowedRoles) {
    // Normalize allowed roles to lowercase
    const normalized = allowedRoles.map(r => r.toLowerCase());

    return (req, res, next) => {
        if (!req.session || !req.session.user) {
            return res.redirect("/login");
        }

        const userRole = (req.session.user.role || "").toLowerCase();

        // Block if role not allowed
        if (!normalized.includes(userRole)) {
            if (req.xhr || req.headers.accept?.includes("application/json")) {
                return res.status(403).json({
                    error: "Forbidden: insufficient permissions"
                });
            }

            return res
                .status(403)
                .send("Forbidden: You do not have permission to access this page");
        }

        next();
    };
}

module.exports = { requireRole };
